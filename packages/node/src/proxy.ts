import { randomUUID } from "node:crypto";
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { type AddressInfo, connect as netConnect } from "node:net";
import { createSecureContext } from "node:tls";
import type {
  ErrorEvent,
  LLMPeekEvent,
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
import {
  OpenAIStreamAggregator,
  type StreamDeltaInfo,
  decodeChatRequest,
  decodeChatResponse,
  decodeEmbeddingRequest,
  decodeEmbeddingResponse,
} from "./decoders/openai.js";
import { asObject, asString, tryParseJson } from "./json.js";
import { type ProviderMatch, detectProvider, detectSdk, isLlmHost } from "./providers.js";
import { redactBody, redactHeaders, redactUrl } from "./redact.js";
import { SSEParser } from "./sse.js";

const sessionId = randomUUID();
const seqByRequest = new Map<string, number>();
function nextSeq(id: string): number {
  const n = seqByRequest.get(id) ?? 0;
  seqByRequest.set(id, n + 1);
  return n;
}

export interface ProxyServer {
  port: number;
  close(): void;
}

export function startProxy(ca: CA, port: number): Promise<ProxyServer> {
  const fallback = certForHost(ca, "llmpeek.local");
  const mitm = createHttpsServer(
    {
      key: fallback.key,
      cert: fallback.cert,
      SNICallback: (servername, cb) => {
        try {
          const c = certForHost(ca, servername);
          cb(null, createSecureContext({ key: c.key, cert: c.cert }));
        } catch (e) {
          cb(e as Error);
        }
      },
    },
    (req, res) => {
      try {
        handleForward(req, res, new URL(`https://${req.headers.host}${req.url}`), true);
      } catch {
        res.writeHead(400).end();
      }
    },
  );

  const proxy = createHttpServer((req, res) => {
    try {
      handleForward(req, res, new URL(req.url ?? ""), false);
    } catch {
      res.writeHead(400).end();
    }
  });

  proxy.on("connect", (req, clientSocket) => {
    clientSocket.on("error", () => {});
    const [host, portStr] = (req.url ?? "").split(":");
    const targetPort = Number(portStr) || 443;

    if (isLlmHost(host)) {
      const addr = mitm.address() as AddressInfo | null;
      if (!addr) return clientSocket.destroy();
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const up = netConnect(addr.port, "127.0.0.1", () => {
        clientSocket.pipe(up);
        up.pipe(clientSocket);
      });
      up.on("error", () => clientSocket.destroy());
    } else {
      // Non-LLM host: blind tunnel, never decrypted.
      const up = netConnect(targetPort, host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        clientSocket.pipe(up);
        up.pipe(clientSocket);
      });
      up.on("error", () => clientSocket.destroy());
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

/** Forward a (decrypted) request upstream, streaming the response back to the
 *  client, and capture it as events if it's an LLM call. */
function handleForward(req: IncomingMessage, res: ServerResponse, url: URL, secure: boolean): void {
  const method = req.method ?? "GET";
  const match = detectProvider(url, method);
  const requestId = randomUUID();
  const startedAt = Date.now();

  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("error", () => {});
  req.on("end", () => {
    const reqBody = Buffer.concat(chunks);
    const headers: IncomingHttpHeaders = { ...req.headers };
    delete headers["proxy-connection"];
    // Strip accept-encoding so we (and the client) get uncompressed, parseable bodies.
    delete headers["accept-encoding"];
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
        res.writeHead(upRes.statusCode ?? 502, upRes.headers as Record<string, string | string[]>);
        if (match)
          captureExchange(match, url, method, requestId, startedAt, req.headers, reqBody, upRes);
        upRes.pipe(res);
      },
    );
    up.on("error", () => {
      try {
        res.writeHead(502).end();
      } catch {}
    });
    if (reqBody.length) up.write(reqBody);
    up.end();
  });
}

function captureExchange(
  match: ProviderMatch,
  url: URL,
  method: string,
  requestId: string,
  startedAt: number,
  reqHeaders: IncomingHttpHeaders,
  reqBody: Buffer,
  upRes: IncomingMessage,
): void {
  try {
    const webReqHeaders = toWebHeaders(reqHeaders);
    const source: Source = {
      language: langFrom(webReqHeaders),
      sdk: detectSdk(webReqHeaders, match.provider),
      transport: "unknown",
      interceptorVersion: "0.0.0",
    };
    const env = (): Omit<LLMPeekEvent, "type"> & Record<string, unknown> =>
      ({
        schemaVersion: SCHEMA_VERSION,
        requestId,
        seq: nextSeq(requestId),
        timestamp: Date.now(),
        sessionId,
        source,
      }) as never;

    // request_started
    const parsed = tryParseJson(reqBody.toString("utf8"));
    const { headers, entries: hEntries } = redactHeaders(webReqHeaders, "request_headers");
    const redUrl = redactUrl(url);
    const bodyRed = redactBody(parsed, "request_body");
    const decoded =
      match.operation === "embedding" ? decodeEmbeddingRequest(parsed) : decodeChatRequest(parsed);
    const reqRaw: RawPayload = {
      format: match.wireFormat,
      encoding: "json",
      body: bodyRed.body,
      byteLength: reqBody.length,
    };
    const started: RequestStartedEvent = {
      type: "request_started",
      ...env(),
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
        raw: reqRaw,
        ...(decoded.model ? { model: decoded.model } : {}),
        ...(decoded.messages.length ? { messages: decoded.messages } : {}),
        ...(decoded.input ? { input: decoded.input } : {}),
      },
      redaction: redaction([...hEntries, ...redUrl.entries, ...bodyRed.entries]),
      timing: { startedAt },
    } as RequestStartedEvent;
    ship(started);

    // response
    const status = upRes.statusCode ?? 0;
    const { headers: respHeaders, entries: rhEntries } = toRedactedRespHeaders(upRes.headers);
    const isStream = String(upRes.headers["content-type"] ?? "").includes("text/event-stream");

    if (isStream) {
      const parser = new SSEParser();
      const agg = new OpenAIStreamAggregator();
      const decoder = new TextDecoder();
      let firstByteAt: number | undefined;
      let firstTokenAt: number | undefined;

      const feed = (text: string): void => {
        for (const frame of parser.push(text)) {
          if (frame.data === "[DONE]") continue;
          const json = tryParseJson(frame.data);
          if (json === undefined) continue;
          for (const info of agg.handleChunk(json)) {
            if (
              firstTokenAt === undefined &&
              (info.textDelta || info.toolCallDelta || info.refusalDelta)
            ) {
              firstTokenAt = Date.now();
            }
            ship(mkDelta(env(), info));
          }
        }
      };

      upRes.on("data", (c: Buffer) => {
        if (firstByteAt === undefined) {
          firstByteAt = Date.now();
          ship({
            type: "stream_start",
            ...env(),
            firstByteAt,
            httpStatus: status,
            responseHeaders: respHeaders,
            ...(rhEntries.length ? { redaction: redaction(rhEntries) } : {}),
          } as StreamStartEvent);
        }
        feed(decoder.decode(c, { stream: true }));
      });
      upRes.on("end", () => {
        feed(decoder.decode());
        for (const frame of parser.flush()) {
          const json = tryParseJson(frame.data);
          if (json !== undefined)
            for (const info of agg.handleChunk(json)) ship(mkDelta(env(), info));
        }
        const completedAt = Date.now();
        const decodedResp = agg.finalize();
        const timing: Timing = { startedAt, completedAt, totalMs: completedAt - startedAt };
        if (firstByteAt !== undefined) timing.firstByteAt = firstByteAt;
        const ttftAt = firstTokenAt ?? firstByteAt;
        if (ttftAt !== undefined) {
          timing.firstTokenAt = ttftAt;
          timing.ttftMs = ttftAt - startedAt;
        }
        ship({
          type: "response_completed",
          ...env(),
          timing,
          streamed: true,
          raw: { format: match.wireFormat, encoding: "omitted", omittedReason: "streamed" },
          redaction: redaction(rhEntries),
          responseHeaders: respHeaders,
          httpStatus: status,
          ...(decodedResp.messages?.length ? { messages: decodedResp.messages } : {}),
          ...(decodedResp.usage ? { usage: decodedResp.usage } : {}),
          ...(decodedResp.finishReason ? { finishReason: decodedResp.finishReason } : {}),
          ...(decodedResp.rawFinishReason ? { rawFinishReason: decodedResp.rawFinishReason } : {}),
          ...(decodedResp.systemFingerprint
            ? { systemFingerprint: decodedResp.systemFingerprint }
            : {}),
          ...(decodedResp.serviceTier ? { serviceTier: decodedResp.serviceTier } : {}),
        } as ResponseCompletedEvent);
      });
    } else {
      const buf: Buffer[] = [];
      upRes.on("data", (c: Buffer) => buf.push(c));
      upRes.on("end", () => {
        const text = Buffer.concat(buf).toString("utf8");
        const p = tryParseJson(text);
        const completedAt = Date.now();
        const timing: Timing = {
          startedAt,
          firstByteAt: completedAt,
          completedAt,
          totalMs: completedAt - startedAt,
        };
        const respRaw: RawPayload = {
          format: match.wireFormat,
          encoding: "json",
          body: redactBody(p, "response_body").body,
          byteLength: text.length,
        };
        if (status >= 200 && status < 300) {
          const d =
            match.operation === "embedding" ? decodeEmbeddingResponse(p) : decodeChatResponse(p);
          ship({
            type: "response_completed",
            ...env(),
            timing,
            streamed: false,
            raw: respRaw,
            redaction: redaction(rhEntries),
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
          const err = asObject(asObject(p).error);
          ship({
            type: "error",
            ...env(),
            errorKind: "http_status",
            httpStatus: status,
            message: asString(err.message) ?? `HTTP ${status}`,
            timing,
            raw: respRaw,
            redaction: redaction(rhEntries),
            responseHeaders: respHeaders,
            ...(asString(err.type) ? { providerErrorType: asString(err.type) } : {}),
            ...(status === 429 || status >= 500 ? { retryable: true } : {}),
          } as ErrorEvent);
        }
      });
    }
  } catch {
    // observe-only: never disturb the proxied request
  }
}

function mkDelta(env: Record<string, unknown>, info: StreamDeltaInfo): StreamDeltaEvent {
  return {
    type: "stream_delta",
    ...env,
    ...(info.index !== undefined ? { index: info.index } : {}),
    ...(info.blockIndex !== undefined ? { blockIndex: info.blockIndex } : {}),
    ...(info.textDelta ? { textDelta: info.textDelta } : {}),
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

function toWebHeaders(h: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (Array.isArray(v)) for (const x of v) out.append(k, x);
    else if (v != null) out.set(k, String(v));
  }
  return out;
}

function toRedactedRespHeaders(h: IncomingHttpHeaders): {
  headers: Record<string, string>;
  entries: RedactionEntry[];
} {
  return redactHeaders(toWebHeaders(h), "response_headers");
}

function langFrom(h: Headers): Source["language"] {
  const lang = h.get("x-stainless-lang");
  if (lang === "js") return "node";
  if (lang === "python") return "python";
  return "unknown";
}
