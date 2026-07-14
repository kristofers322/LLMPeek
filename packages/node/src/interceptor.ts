import type {
  ErrorEvent,
  RawPayload,
  RedactionEntry,
  RedactionInfo,
  RequestStartedEvent,
  ResponseCompletedEvent,
  SdkKind,
  StreamDeltaEvent,
  StreamStartEvent,
  Timing,
} from "@llmpeek/schema";
import { BatchInterceptor } from "@mswjs/interceptors";
import nodeInterceptors from "@mswjs/interceptors/presets/node";
import type { StreamDeltaInfo } from "./decoders/openai.js";
import { createStreamAggregator, decodeRequest, decodeResponse } from "./decoders/registry.js";
import { asObject, asString, tryParseJson } from "./json.js";
import { type ProviderMatch, detectProvider, detectSdk } from "./providers.js";
import { redactBody, redactHeaders, redactUrl } from "./redact.js";
import { SCHEMA_VERSION, emit, endRequest, makeSource, nextSeq, sessionId } from "./runtime.js";
import { SSEParser } from "./sse.js";

interface RequestContext {
  match: ProviderMatch;
  sdk: SdkKind;
  startedAt: number;
  streamRequested: boolean;
}

const contexts = new Map<string, RequestContext>();
// A request that never receives a response (network error / abort) fires no
// 'response' event, so cleanup would never run for it. These bounds reclaim such
// orphaned entries so the maps can't grow without bound over the process life.
const CONTEXT_TTL_MS = 10 * 60 * 1000;
const MAX_CONTEXTS = 4096;

let interceptor: BatchInterceptor<typeof nodeInterceptors> | null = null;

export function install(): void {
  if (interceptor) return;
  interceptor = new BatchInterceptor({ name: "llmpeek", interceptors: nodeInterceptors });
  interceptor.apply();
  interceptor.on("request", ({ request, requestId }) => {
    try {
      onRequest(request, requestId);
    } catch {
      // observe-only: a bug in capture must never break the host request
    }
  });
  interceptor.on("response", ({ response, requestId, isMockedResponse }) => {
    try {
      onResponse(response, requestId, isMockedResponse);
    } catch {
      // observe-only
    }
  });
}

export function uninstall(): void {
  interceptor?.dispose();
  interceptor = null;
  contexts.clear();
}

// --------------------------------------------------------------- request ---

function onRequest(request: Request, requestId: string): void {
  const url = new URL(request.url);
  const match = detectProvider(url, request.method);
  if (!match) return;

  const startedAt = Date.now();
  sweepContexts(startedAt);

  const sdk = detectSdk(request.headers, match.provider);
  // Detect stream intent SYNCHRONOUSLY (SDKs send `accept: text/event-stream`)
  // so onResponse never races the async request-body read below.
  const streamRequested = (request.headers.get("accept") ?? "").includes("text/event-stream");
  const ctx: RequestContext = { match, sdk, startedAt, streamRequested };
  contexts.set(requestId, ctx);

  // Reserve seq 0 synchronously so request_started orders before any response
  // event even though the body is read (and the event emitted) asynchronously.
  const seq = nextSeq(requestId);
  const clone = request.clone();

  void (async () => {
    // Outer guard: nothing in this async continuation may reject unhandled.
    try {
      let bodyText = "";
      try {
        bodyText = await clone.text();
      } catch {
        // request body may be unreadable; emit what we have
      }
      const parsed = bodyText ? tryParseJson(bodyText) : undefined;
      if (asObject(parsed).stream === true) ctx.streamRequested = true;

      const { headers, entries: hEntries } = redactHeaders(request.headers, "request_headers");
      const redUrl = redactUrl(url);
      const bodyRedaction = redactBody(parsed, "request_body");
      // Decode from the redacted body so masked secrets never resurface in the
      // normalized request.messages/params shown in the dashboard.
      const decoded = decodeRequest(match, bodyRedaction.body);
      const raw: RawPayload = {
        format: match.wireFormat,
        encoding: "json",
        body: bodyRedaction.body,
        byteLength: bodyText.length,
      };

      const event: RequestStartedEvent = {
        type: "request_started",
        schemaVersion: SCHEMA_VERSION,
        requestId,
        seq,
        timestamp: Date.now(),
        sessionId,
        source: makeSource(sdk, "fetch"),
        request: {
          provider: match.provider,
          wireFormat: match.wireFormat,
          operation: match.operation,
          host: url.hostname,
          path: url.pathname,
          method: request.method,
          url: redUrl.url,
          query: redUrl.query,
          params: decoded.params,
          headers,
          raw,
          ...(decoded.model ? { model: decoded.model } : {}),
          ...(decoded.messages.length ? { messages: decoded.messages } : {}),
          ...(decoded.input ? { input: decoded.input } : {}),
        },
        redaction: mergeRedaction([...hEntries, ...redUrl.entries, ...bodyRedaction.entries]),
        timing: { startedAt },
      };
      emit(event);
    } catch {
      // observe-only: swallow so no unhandled rejection reaches the host
    }
  })();
}

// -------------------------------------------------------------- response ---

/**
 * Whether to read the response as an SSE stream. A request made with stream
 * intent that FAILS comes back as a non-2xx JSON error (not an event stream), so
 * stream intent alone must not force the streaming path — otherwise the error is
 * parsed as zero SSE frames and surfaces as an empty completion instead of an
 * error event. Route genuine event streams (and ok, non-JSON stream-intent
 * responses) to the stream path; everything else, including errors, to the
 * non-stream path which emits a proper ErrorEvent.
 */
export function isStreamingResponse(
  contentType: string,
  streamRequested: boolean,
  ok: boolean,
): boolean {
  if (contentType.includes("text/event-stream")) return true;
  return streamRequested && ok && !contentType.includes("application/json");
}

function onResponse(response: Response, requestId: string, isMockedResponse: boolean): void {
  if (isMockedResponse) return;
  const ctx = contexts.get(requestId);
  if (!ctx) return;

  const clone = response.clone();
  const contentType = response.headers.get("content-type") ?? "";
  const isStream = isStreamingResponse(contentType, ctx.streamRequested, response.ok);
  const { headers: respHeaders, entries: rhEntries } = redactHeaders(
    response.headers,
    "response_headers",
  );

  if (isStream && clone.body) {
    void consumeStream(clone.body, ctx, requestId, response.status, respHeaders, rhEntries);
    return;
  }

  void (async () => {
    try {
      let text = "";
      try {
        text = await clone.text();
      } catch {
        // response body may be unreadable
      }
      finishNonStream(ctx, requestId, response, tryParseJson(text), text, respHeaders, rhEntries);
    } catch {
      // observe-only
    } finally {
      cleanup(requestId);
    }
  })();
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  ctx: RequestContext,
  requestId: string,
  status: number,
  respHeaders: Record<string, string>,
  rhEntries: RedactionEntry[],
): Promise<void> {
  try {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser();
    const agg = createStreamAggregator(ctx.match);
    let firstByteAt: number | undefined;
    let firstTokenAt: number | undefined;

    const handleFrames = (frames: { event?: string; data: string }[]): void => {
      for (const frame of frames) {
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
          emit(buildDelta(requestId, ctx, info));
        }
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByteAt === undefined) {
          firstByteAt = Date.now();
          const startEvent: StreamStartEvent = {
            type: "stream_start",
            ...envelope(requestId, ctx),
            firstByteAt,
            httpStatus: status,
            responseHeaders: respHeaders,
            ...(rhEntries.length ? { redaction: mergeRedaction(rhEntries) } : {}),
          };
          emit(startEvent);
        }
        handleFrames(parser.push(decoder.decode(value, { stream: true })));
      }
    } catch {
      // mid-stream read error; still emit the reassembled completion below
    }
    // Flush any bytes/frame the decoder or parser is still holding (truncated or
    // non-\n\n-terminated final frame).
    handleFrames(parser.push(decoder.decode()));
    handleFrames(parser.flush());

    const completedAt = Date.now();
    const decoded = agg.finalize();
    const timing: Timing = {
      startedAt: ctx.startedAt,
      completedAt,
      totalMs: completedAt - ctx.startedAt,
    };
    if (firstByteAt !== undefined) timing.firstByteAt = firstByteAt;
    const ttftAt = firstTokenAt ?? firstByteAt;
    if (ttftAt !== undefined) {
      timing.firstTokenAt = ttftAt;
      timing.ttftMs = ttftAt - ctx.startedAt;
    }

    const event: ResponseCompletedEvent = {
      type: "response_completed",
      ...envelope(requestId, ctx),
      timing,
      streamed: true,
      raw: { format: ctx.match.wireFormat, encoding: "omitted", omittedReason: "streamed" },
      redaction: mergeRedaction(rhEntries),
      responseHeaders: respHeaders,
      httpStatus: status,
      ...(decoded.messages?.length ? { messages: decoded.messages } : {}),
      ...(decoded.usage ? { usage: decoded.usage } : {}),
      ...(decoded.finishReason ? { finishReason: decoded.finishReason } : {}),
      ...(decoded.rawFinishReason ? { rawFinishReason: decoded.rawFinishReason } : {}),
      ...(decoded.systemFingerprint ? { systemFingerprint: decoded.systemFingerprint } : {}),
      ...(decoded.serviceTier ? { serviceTier: decoded.serviceTier } : {}),
    };
    emit(event);
  } catch {
    // observe-only: never reject
  } finally {
    cleanup(requestId);
  }
}

function finishNonStream(
  ctx: RequestContext,
  requestId: string,
  response: Response,
  parsed: unknown,
  text: string,
  respHeaders: Record<string, string>,
  rhEntries: RedactionEntry[],
): void {
  const completedAt = Date.now();
  const timing: Timing = {
    startedAt: ctx.startedAt,
    firstByteAt: completedAt,
    completedAt,
    totalMs: completedAt - ctx.startedAt,
  };
  const bodyRedaction = redactBody(parsed, "response_body");
  const raw: RawPayload = {
    format: ctx.match.wireFormat,
    encoding: "json",
    body: bodyRedaction.body,
    byteLength: text.length,
  };
  const redaction = mergeRedaction([...rhEntries, ...bodyRedaction.entries]);

  if (response.ok) {
    // Decode from the redacted body (see onRequest) so masked secrets stay masked.
    const decoded = decodeResponse(ctx.match, bodyRedaction.body);
    const event: ResponseCompletedEvent = {
      type: "response_completed",
      ...envelope(requestId, ctx),
      timing,
      streamed: false,
      raw,
      redaction,
      responseHeaders: respHeaders,
      httpStatus: response.status,
      ...(decoded.messages?.length ? { messages: decoded.messages } : {}),
      ...(decoded.embeddings?.length ? { embeddings: decoded.embeddings } : {}),
      ...(decoded.usage ? { usage: decoded.usage } : {}),
      ...(decoded.finishReason ? { finishReason: decoded.finishReason } : {}),
      ...(decoded.rawFinishReason ? { rawFinishReason: decoded.rawFinishReason } : {}),
      ...(decoded.systemFingerprint ? { systemFingerprint: decoded.systemFingerprint } : {}),
      ...(decoded.serviceTier ? { serviceTier: decoded.serviceTier } : {}),
    };
    emit(event);
  } else {
    const errObj = asObject(asObject(bodyRedaction.body).error);
    const event: ErrorEvent = {
      type: "error",
      ...envelope(requestId, ctx),
      errorKind: "http_status",
      httpStatus: response.status,
      message: asString(errObj.message) ?? `HTTP ${response.status}`,
      timing,
      raw,
      redaction,
      responseHeaders: respHeaders,
      ...(asString(errObj.type) ? { providerErrorType: asString(errObj.type) } : {}),
      ...(response.status === 429 || response.status >= 500 ? { retryable: true } : {}),
    };
    emit(event);
  }
}

// ---------------------------------------------------------------- helpers ---

function buildDelta(
  requestId: string,
  ctx: RequestContext,
  info: StreamDeltaInfo,
): StreamDeltaEvent {
  return {
    type: "stream_delta",
    ...envelope(requestId, ctx),
    ...(info.index !== undefined ? { index: info.index } : {}),
    ...(info.blockIndex !== undefined ? { blockIndex: info.blockIndex } : {}),
    ...(info.textDelta ? { textDelta: info.textDelta } : {}),
    ...(info.thinkingDelta ? { thinkingDelta: info.thinkingDelta } : {}),
    ...(info.refusalDelta ? { refusalDelta: info.refusalDelta } : {}),
    ...(info.roleDelta ? { roleDelta: info.roleDelta } : {}),
    ...(info.toolCallDelta ? { toolCallDelta: info.toolCallDelta } : {}),
    ...(info.finishReason ? { finishReason: info.finishReason } : {}),
    ...(info.usage ? { usage: info.usage } : {}),
  };
}

function envelope(requestId: string, ctx: RequestContext) {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    seq: nextSeq(requestId),
    timestamp: Date.now(),
    sessionId,
    source: makeSource(ctx.sdk, "fetch"),
  };
}

function mergeRedaction(entries: RedactionEntry[]): RedactionInfo {
  return { redacted: entries.length > 0, entries };
}

function cleanup(requestId: string): void {
  contexts.delete(requestId);
  endRequest(requestId);
}

/** Reclaim orphaned contexts (requests that never got a response). Cheap: the
 *  Map is in insertion order, so once we reach a non-expired entry the rest are
 *  newer. A hard size cap backstops pathological bursts. */
function sweepContexts(now: number): void {
  const expired: string[] = [];
  for (const [id, ctx] of contexts) {
    if (now - ctx.startedAt > CONTEXT_TTL_MS) expired.push(id);
    else break;
  }
  for (const id of expired) cleanup(id);
  while (contexts.size > MAX_CONTEXTS) {
    const oldest = contexts.keys().next().value;
    if (oldest === undefined) break;
    cleanup(oldest);
  }
}
