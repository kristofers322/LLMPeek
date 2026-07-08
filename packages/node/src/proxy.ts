import { randomUUID } from "node:crypto";
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { type AddressInfo, type Socket, connect as netConnect } from "node:net";
import { type SecureContext, createSecureContext } from "node:tls";
import type {
  ErrorEvent,
  RawPayload,
  RedactionEntry,
  RedactionInfo,
  RequestStartedEvent,
  ResponseCompletedEvent,
  Source,
  StreamDeltaEvent,
  StreamStartEvent,
  Timing,
} from "@llmpeek/schema";
import { SCHEMA_VERSION } from "@llmpeek/schema";
import { type CA, certForHost } from "./ca.js";
import { ship } from "./collector-client.js";
import type { StreamDeltaInfo } from "./decoders/openai.js";
import { createStreamAggregator, decodeRequest, decodeResponse } from "./decoders/registry.js";
import { asObject, asString, tryParseJson } from "./json.js";
import { type ProviderMatch, detectProvider, detectSdk, isLlmHost } from "./providers.js";
import { redactBody, redactHeaders, redactUrl, scrubText } from "./redact.js";
import { SSEParser } from "./sse.js";
import { VERSION } from "./version.js";

// Cap how much of a body we buffer FOR CAPTURE — forwarding is always streamed
// and unaffected. Prevents a huge/hostile body from exhausting proxy memory.
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

const sessionId = randomUUID();

/** Per-request capture state — a local seq counter, so no global map leaks. */
interface Capture {
  requestId: string;
  seq: number;
  startedAt: number;
  source: Source;
}
function env(cap: Capture) {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId: cap.requestId,
    seq: cap.seq++,
    timestamp: Date.now(),
    sessionId,
    source: cap.source,
  };
}

/** Tear down both ends of a tunnel when either errors or closes. */
function linkSockets(a: Socket, b: Socket): void {
  const kill = () => {
    a.destroy();
    b.destroy();
  };
  a.on("error", kill).on("close", kill);
  b.on("error", kill).on("close", kill);
}

export interface ProxyServer {
  port: number;
  close(): void;
}

export function startProxy(ca: CA, port: number): Promise<ProxyServer> {
  const fallback = certForHost(ca, "llmpeek.local");
  const contexts = new Map<string, SecureContext>();

  const mitm = createHttpsServer(
    {
      key: fallback.key,
      cert: fallback.cert,
      SNICallback: (servername, cb) => {
        // Re-enforce decrypt scope INSIDE the tunnel: refuse to terminate TLS for
        // any servername that is not a known LLM host, even if it arrived via a
        // CONNECT to a host that was.
        if (!servername || !isLlmHost(servername)) {
          cb(new Error("llmpeek: host not intercepted"));
          return;
        }
        let ctx = contexts.get(servername);
        if (!ctx) {
          const c = certForHost(ca, servername);
          ctx = createSecureContext({ key: c.key, cert: c.cert });
          if (contexts.size >= 256) {
            const oldest = contexts.keys().next().value;
            if (oldest !== undefined) contexts.delete(oldest);
          }
          contexts.set(servername, ctx);
        }
        cb(null, ctx);
      },
    },
    (req, res) => {
      try {
        handleForward(req, res, new URL(`https://${req.headers.host}${req.url}`), true);
      } catch {
        try {
          res.writeHead(400).end();
        } catch {}
      }
    },
  );

  const proxy = createHttpServer((req, res) => {
    try {
      handleForward(req, res, new URL(req.url ?? ""), false);
    } catch {
      try {
        res.writeHead(400).end();
      } catch {}
    }
  });

  proxy.on("connect", (req, clientSocket: Socket, head: Buffer) => {
    clientSocket.on("error", () => {});
    const [host, portStr] = (req.url ?? "").split(":");
    const targetPort = Number(portStr) || 443;

    if (isLlmHost(host)) {
      const addr = mitm.address() as AddressInfo | null;
      if (!addr) {
        clientSocket.destroy();
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const up = netConnect(addr.port, "127.0.0.1", () => {
        if (head?.length) up.write(head);
        clientSocket.pipe(up);
        up.pipe(clientSocket);
      });
      linkSockets(clientSocket, up);
    } else {
      // Non-LLM host: blind tunnel, never decrypted.
      const up = netConnect(targetPort, host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) up.write(head);
        clientSocket.pipe(up);
        up.pipe(clientSocket);
      });
      linkSockets(clientSocket, up);
    }
  });

  return new Promise((resolve, reject) => {
    mitm.listen(0, "127.0.0.1", () => {
      proxy.once("error", reject);
      proxy.listen(port, "127.0.0.1", () => {
        proxy.removeListener("error", reject);
        resolve({
          port,
          close: () => {
            mitm.close();
            proxy.close();
          },
        });
      });
    });
  });
}

/**
 * Forward a request upstream, streaming the response back to the client, and
 * capture it as events ONLY if it's a known LLM call. Capture never alters the
 * proxied bytes: uncaptured traffic is forwarded verbatim and back-pressured.
 */
function handleForward(req: IncomingMessage, res: ServerResponse, url: URL, secure: boolean): void {
  const method = req.method ?? "GET";
  // Decrypt scope: only the MITM (secure) path may capture, and only for LLM hosts.
  const capturable = secure ? isLlmHost(url.hostname) : true;
  const match = capturable ? detectProvider(url, method) : null;
  const cap: Capture | null = match
    ? {
        requestId: randomUUID(),
        seq: 0,
        startedAt: Date.now(),
        source: sourceFrom(req.headers, match),
      }
    : null;

  const headers: IncomingHttpHeaders = { ...req.headers };
  delete headers["proxy-connection"];
  // Only strip accept-encoding for CAPTURED traffic (so we can parse an
  // uncompressed body). Uncaptured traffic keeps its encoding — byte-transparent.
  if (cap) delete headers["accept-encoding"];
  headers.host = url.host;

  const requester = secure ? httpsRequest : httpRequest;
  const up = requester(
    {
      host: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      servername: url.hostname,
    },
    (upRes) => {
      upRes.on("error", () => res.destroy());
      res.writeHead(upRes.statusCode ?? 502, upRes.headers as OutgoingHttpHeaders);
      if (cap && match) captureResponse(cap, match, upRes);
      upRes.pipe(res);
    },
  );
  up.on("error", () => {
    if (res.headersSent) res.destroy();
    else {
      try {
        res.writeHead(502).end();
      } catch {
        res.destroy();
      }
    }
  });
  // Client abort → tear down the upstream so it can't leak.
  res.on("close", () => up.destroy());

  if (cap && match) {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    req.on("data", (c: Buffer) => {
      up.write(c);
      if (!truncated && size + c.length <= MAX_CAPTURE_BYTES) {
        chunks.push(c);
        size += c.length;
      } else if (size + c.length > MAX_CAPTURE_BYTES) {
        truncated = true;
      }
    });
    req.on("error", () => {});
    req.on("end", () => {
      up.end();
      captureRequest(cap, match, url, method, req.headers, Buffer.concat(chunks), size, truncated);
    });
  } else {
    req.pipe(up);
  }
}

function captureRequest(
  cap: Capture,
  match: ProviderMatch,
  url: URL,
  method: string,
  reqHeaders: IncomingHttpHeaders,
  bodyBuf: Buffer,
  byteLength: number,
  truncated: boolean,
): void {
  try {
    const { headers, entries: hEntries } = redactHeaders(
      toWebHeaders(reqHeaders),
      "request_headers",
    );
    const redUrl = redactUrl(url);
    const parsed = truncated ? undefined : tryParseJson(bodyBuf.toString("utf8"));
    const bodyRed = redactBody(parsed, "request_body");
    // Decode from the REDACTED body so masked secrets never resurface in
    // normalized fields (messages/params).
    const decoded = decodeRequest(match, bodyRed.body);
    const raw: RawPayload = truncated
      ? {
          format: match.wireFormat,
          encoding: "omitted",
          omittedReason: "too_large",
          byteLength,
          truncated: true,
        }
      : { format: match.wireFormat, encoding: "json", body: bodyRed.body, byteLength };

    const event: RequestStartedEvent = {
      type: "request_started",
      ...env(cap),
      request: {
        provider: match.provider,
        wireFormat: match.wireFormat,
        operation: match.operation,
        host: url.hostname,
        path: url.pathname,
        method,
        url: redUrl.url,
        query: redUrl.query,
        params: decoded.params,
        headers,
        raw,
        ...(decoded.model ? { model: decoded.model } : {}),
        ...(decoded.messages.length ? { messages: decoded.messages } : {}),
        ...(decoded.input ? { input: decoded.input } : {}),
      },
      redaction: redaction([...hEntries, ...redUrl.entries, ...bodyRed.entries]),
      timing: { startedAt: cap.startedAt },
    };
    ship(event);
  } catch {
    // observe-only
  }
}

function captureResponse(cap: Capture, match: ProviderMatch, upRes: IncomingMessage): void {
  try {
    const status = upRes.statusCode ?? 0;
    const { headers: respHeaders, entries: rhEntries } = redactHeaders(
      toWebHeaders(upRes.headers),
      "response_headers",
    );
    const isStream = String(upRes.headers["content-type"] ?? "").includes("text/event-stream");

    if (isStream) {
      const parser = new SSEParser();
      const agg = createStreamAggregator(match);
      const decoder = new TextDecoder();
      let firstByteAt: number | undefined;
      let firstTokenAt: number | undefined;

      const feed = (text: string): void => {
        for (const frame of parser.push(text)) {
          if (frame.data === "[DONE]") continue;
          const json = tryParseJson(frame.data);
          if (json === undefined) continue;
          for (const info of agg.handleChunk(json, frame.event)) {
            if (
              firstTokenAt === undefined &&
              (info.textDelta || info.toolCallDelta || info.refusalDelta)
            ) {
              firstTokenAt = Date.now();
            }
            ship(mkDelta(env(cap), info));
          }
        }
      };

      upRes.on("data", (c: Buffer) => {
        if (firstByteAt === undefined) {
          firstByteAt = Date.now();
          ship({
            type: "stream_start",
            ...env(cap),
            firstByteAt,
            httpStatus: status,
            responseHeaders: respHeaders,
            ...(rhEntries.length ? { redaction: redaction(rhEntries) } : {}),
          } as StreamStartEvent);
        }
        feed(decoder.decode(c, { stream: true }));
      });
      upRes.on("error", () => {});
      upRes.on("end", () => {
        feed(decoder.decode());
        for (const frame of parser.flush()) {
          const json = tryParseJson(frame.data);
          if (json !== undefined)
            for (const info of agg.handleChunk(json, frame.event)) ship(mkDelta(env(cap), info));
        }
        const completedAt = Date.now();
        const d = agg.finalize();
        const timing: Timing = {
          startedAt: cap.startedAt,
          completedAt,
          totalMs: completedAt - cap.startedAt,
        };
        if (firstByteAt !== undefined) timing.firstByteAt = firstByteAt;
        const ttftAt = firstTokenAt ?? firstByteAt;
        if (ttftAt !== undefined) {
          timing.firstTokenAt = ttftAt;
          timing.ttftMs = ttftAt - cap.startedAt;
        }
        ship({
          type: "response_completed",
          ...env(cap),
          timing,
          streamed: true,
          raw: { format: match.wireFormat, encoding: "omitted", omittedReason: "streamed" },
          redaction: redaction(rhEntries),
          responseHeaders: respHeaders,
          httpStatus: status,
          ...(d.messages?.length ? { messages: d.messages } : {}),
          ...(d.usage ? { usage: d.usage } : {}),
          ...(d.finishReason ? { finishReason: d.finishReason } : {}),
          ...(d.rawFinishReason ? { rawFinishReason: d.rawFinishReason } : {}),
          ...(d.systemFingerprint ? { systemFingerprint: d.systemFingerprint } : {}),
          ...(d.serviceTier ? { serviceTier: d.serviceTier } : {}),
        } as ResponseCompletedEvent);
      });
      return;
    }

    // Non-streaming: buffer a size-capped copy for capture (pipe-to-client unaffected).
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    upRes.on("data", (c: Buffer) => {
      if (!truncated && size + c.length <= MAX_CAPTURE_BYTES) {
        chunks.push(c);
        size += c.length;
      } else if (size + c.length > MAX_CAPTURE_BYTES) {
        truncated = true;
      }
    });
    upRes.on("error", () => {});
    upRes.on("end", () => {
      const parsed = truncated ? undefined : tryParseJson(Buffer.concat(chunks).toString("utf8"));
      const bodyRed = redactBody(parsed, "response_body");
      const completedAt = Date.now();
      const timing: Timing = {
        startedAt: cap.startedAt,
        firstByteAt: completedAt,
        completedAt,
        totalMs: completedAt - cap.startedAt,
      };
      const raw: RawPayload = truncated
        ? {
            format: match.wireFormat,
            encoding: "omitted",
            omittedReason: "too_large",
            byteLength: size,
            truncated: true,
          }
        : { format: match.wireFormat, encoding: "json", body: bodyRed.body, byteLength: size };
      const rInfo = redaction([...rhEntries, ...bodyRed.entries]);

      if (status >= 200 && status < 300) {
        const d = decodeResponse(match, bodyRed.body);
        ship({
          type: "response_completed",
          ...env(cap),
          timing,
          streamed: false,
          raw,
          redaction: rInfo,
          responseHeaders: respHeaders,
          httpStatus: status,
          ...(d.messages?.length ? { messages: d.messages } : {}),
          ...(d.embeddings?.length ? { embeddings: d.embeddings } : {}),
          ...(d.usage ? { usage: d.usage } : {}),
          ...(d.finishReason ? { finishReason: d.finishReason } : {}),
          ...(d.rawFinishReason ? { rawFinishReason: d.rawFinishReason } : {}),
          ...(d.systemFingerprint ? { systemFingerprint: d.systemFingerprint } : {}),
          ...(d.serviceTier ? { serviceTier: d.serviceTier } : {}),
        } as ResponseCompletedEvent);
      } else {
        const err = asObject(asObject(parsed).error);
        ship({
          type: "error",
          ...env(cap),
          errorKind: "http_status",
          httpStatus: status,
          message: scrubText(asString(err.message) ?? `HTTP ${status}`),
          timing,
          raw,
          redaction: rInfo,
          responseHeaders: respHeaders,
          ...(asString(err.type) ? { providerErrorType: asString(err.type) } : {}),
          ...(status === 429 || status >= 500 ? { retryable: true } : {}),
        } as ErrorEvent);
      }
    });
  } catch {
    // observe-only
  }
}

// ---------------------------------------------------------------- helpers ---

function mkDelta(base: Record<string, unknown>, info: StreamDeltaInfo): StreamDeltaEvent {
  return {
    type: "stream_delta",
    ...base,
    ...(info.index !== undefined ? { index: info.index } : {}),
    ...(info.blockIndex !== undefined ? { blockIndex: info.blockIndex } : {}),
    ...(info.textDelta ? { textDelta: info.textDelta } : {}),
    ...(info.thinkingDelta ? { thinkingDelta: info.thinkingDelta } : {}),
    ...(info.refusalDelta ? { refusalDelta: info.refusalDelta } : {}),
    ...(info.roleDelta ? { roleDelta: info.roleDelta } : {}),
    ...(info.toolCallDelta ? { toolCallDelta: info.toolCallDelta } : {}),
    ...(info.finishReason ? { finishReason: info.finishReason } : {}),
    ...(info.usage ? { usage: info.usage } : {}),
  } as StreamDeltaEvent;
}

function redaction(entries: RedactionEntry[]): RedactionInfo {
  return { redacted: entries.length > 0, entries };
}

function sourceFrom(reqHeaders: IncomingHttpHeaders, match: ProviderMatch): Source {
  const web = toWebHeaders(reqHeaders);
  const lang = web.get("x-stainless-lang");
  const language: Source["language"] =
    lang === "js" ? "node" : lang === "python" ? "python" : "unknown";
  return {
    language,
    sdk: detectSdk(web, match.provider),
    transport: "unknown",
    interceptorVersion: VERSION,
  };
}

function toWebHeaders(h: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (Array.isArray(v)) for (const x of v) out.append(k, x);
    else if (v != null) out.set(k, String(v));
  }
  return out;
}
