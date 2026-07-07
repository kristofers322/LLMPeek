/**
 * LLMPeek — Canonical Normalized Event Schema
 * ============================================
 *
 * The single, language-neutral, JSON-serializable contract shared by:
 *   - the Node interceptor (fetch / http.request / XHR shim)
 *   - the future Python (httpx) shim
 *   - the collector (persists events as NDJSON + fans out over WebSocket)
 *   - the dashboard (renders purely by folding this event stream)
 *
 * PORTABILITY RULES (enforced by review, not by the type system):
 *   - No Node-isms. No `Date`, no `Buffer`, no class instances, no `undefined`
 *     on the wire (omit the key instead). Everything here serializes to plain
 *     JSON and round-trips through Python `json.dumps`/`json.loads`.
 *   - All timestamps are epoch milliseconds (integer). All durations are
 *     integer milliseconds. Never ISO strings, never `Date`.
 *   - Binary (images/audio) is never inlined as bytes. It is referenced by
 *     URL, or summarized (mime + byteLength + sha256), or redacted.
 *
 * DESIGN DECISION — discriminated EVENTS, not one evolving RECORD.
 *   NDJSON is an append-only log: you physically cannot rewrite line 4 when
 *   the stream finishes. Streaming produces N deltas over time, each of which
 *   must be a durable, self-contained line. Modeling the lifecycle as a single
 *   mutable record would force the collector to buffer, rewrite, and re-emit —
 *   losing exactly the live, incremental behavior that is the product. So the
 *   lifecycle is a stream of immutable, `type`-discriminated events correlated
 *   by a stable `requestId` and ordered by a monotonic per-request `seq`. The
 *   dashboard is an event-sourcing fold: it materializes a per-request view
 *   model by reducing over the events. See `LLMPeekEvent` at the bottom.
 */

/** Semantic version of THIS schema. Bump per the rules in the block comment
 *  above `SCHEMA_VERSION`. Every emitted event carries this value so a
 *  consumer can branch on producer/consumer skew. */
export const SCHEMA_VERSION = "1.0.0" as const;

/**
 * VERSIONING CONTRACT (read before you touch this file):
 *   MAJOR — a change a naive consumer CANNOT safely ignore: removing/renaming
 *           a field, narrowing a union, changing a field's type or meaning,
 *           or adding a new REQUIRED field. Consumers must gate on major.
 *   MINOR — additive & backward-compatible: a new OPTIONAL field, a new event
 *           `type`, a new string-literal member of an OPEN union (see the
 *           `| (string & {})` widening below). Old consumers keep working by
 *           ignoring what they do not recognize.
 *   PATCH — docs/comments/clarifications, no shape change.
 *
 * Forward-compat is engineered three ways, not just documented:
 *   1) OPEN string-literal unions: every provider/role/etc. union is widened
 *      with `| (string & {})`. TS still autocompletes the known members and
 *      still lets you `switch` on them, but an unknown value from a newer
 *      producer deserializes as a plain string instead of being illegal.
 *   2) EXTENSION BAGS: every structured object carries an optional `x` bag
 *      (`Record<string, unknown>`) for producer-specific or future fields.
 *      New data can ride along under `x.*` for a release before it earns a
 *      first-class field — zero breakage to existing consumers.
 *   3) GRACEFUL DEGRADATION: normalization is best-effort. When a wire format
 *      drifts and a payload can't be mapped, the producer sets `degraded` and
 *      still ships the `raw` payload, so the dashboard degrades to raw-JSON
 *      display instead of dropping the call. Raw payloads are first-class.
 */

/* ============================================================================
 * 0. Open-union helper & shared primitives
 * ========================================================================== */

/** Widen a string-literal union so unknown future members are legal at runtime
 *  while known members still autocomplete and narrow. This is the backbone of
 *  forward-compatibility for every enumerated field in the schema. */
type Open<T extends string> = T | (string & {});

/** Epoch milliseconds (integer). The ONLY absolute-time representation. */
export type EpochMillis = number;

/** A non-negative integer duration in milliseconds. */
export type DurationMillis = number;

/** JSON Pointer (RFC 6901) into the raw payload, e.g.
 *  "/messages/0/content" or "/headers/authorization". Used by redaction and
 *  degradation metadata to point at exact locations without copying data. */
export type JsonPointer = string;

/** Extension bag. Present on every structured object. Producers MAY stash
 *  forward/vendor-specific data here; consumers MUST ignore keys they do not
 *  understand. Never put a required semantic on `x.*` — promote it to a real
 *  field (a MINOR bump) once it stabilizes. */
export interface Extensible {
  x?: Record<string, unknown>;
}

/* ============================================================================
 * 1. Enumerations (all OPEN unions — new members are MINOR, not breaking)
 * ========================================================================== */

/** Provider family, inferred from host + wire shape. `openai_compatible`
 *  covers OpenAI itself plus Azure OpenAI, Together, Groq, OpenRouter,
 *  Mistral, Fireworks, vLLM, Ollama's OpenAI endpoint, etc. */
export type Provider = Open<
  | "openai"
  | "openai_compatible"
  | "azure_openai"
  | "anthropic"
  | "google_gemini"
  | "google_vertex"
  | "cohere"
  | "mistral"
  | "bedrock"
  | "ollama"
  | "unknown"
>;

/** Which wire dialect the bytes actually followed. This — not `provider` — is
 *  what the normalizer keyed off, and what a consumer should trust when
 *  `degraded` is set and it must parse `raw` itself. */
export type WireFormat = Open<
  | "openai_chat" // POST /v1/chat/completions
  | "openai_responses" // POST /v1/responses
  | "openai_completions" // legacy /v1/completions
  | "openai_embeddings"
  | "anthropic_messages" // POST /v1/messages
  | "gemini_generate" // :generateContent
  | "gemini_stream" // :streamGenerateContent
  | "unknown"
>;

/** Detected SDK/framework that originated the call. `raw_fetch` means no known
 *  SDK fingerprint matched (bare fetch/http/httpx). */
export type SdkKind = Open<
  | "openai_node"
  | "openai_python"
  | "anthropic_node"
  | "anthropic_python"
  | "google_genai_node"
  | "google_genai_python"
  | "langchain"
  | "llamaindex"
  | "vercel_ai"
  | "litellm"
  | "raw_fetch"
  | "raw_httpx"
  | "unknown"
>;

/** Source runtime that produced the event. */
export type SourceLanguage = Open<"node" | "python" | "unknown">;

/** How the interceptor grabbed the wire bytes. */
export type Transport = Open<"fetch" | "node_http" | "xhr" | "httpx" | "unknown">;

/** Normalized message role, unified across providers. Provider quirks (e.g.
 *  Anthropic's top-level `system` param, Gemini's `model` role) are mapped to
 *  these; see the mapping notes on `NormalizedMessage`. */
export type Role = Open<"system" | "user" | "assistant" | "tool" | "developer">;

/** Normalized content-part kind. The union below (`ContentPart`) discriminates
 *  on this. Covers text, media, tool call/return, and reasoning across all
 *  three wire formats. */
export type ContentPartType = Open<
  | "text"
  | "image"
  | "audio"
  | "file"
  | "tool_use" // assistant asks to call a tool (OpenAI tool_calls / Anthropic tool_use / Gemini functionCall)
  | "tool_result" // tool output fed back (OpenAI role:tool msg / Anthropic tool_result / Gemini functionResponse)
  | "thinking" // reasoning/extended-thinking (Anthropic thinking, OpenAI reasoning)
  | "refusal" // OpenAI structured refusal part
  | "unknown" // present but unmappable → carries `raw`
>;

/** Reason a generation stopped, normalized. Provider-native value is preserved
 *  in `Completion.rawFinishReason`. */
export type FinishReason = Open<
  | "stop" // natural end / stop sequence / Anthropic end_turn / Gemini STOP
  | "length" // hit max_tokens / MAX_TOKENS
  | "tool_calls" // model wants a tool (Anthropic tool_use / Gemini FUNCTION_CALL)
  | "content_filter" // safety block (Gemini SAFETY, OpenAI content_filter)
  | "refusal"
  | "aborted" // client aborted / timed out before completion
  | "error"
  | "unknown"
>;

/** Category of failure for `ErrorEvent`. */
export type ErrorKind = Open<
  | "http_status" // non-2xx with a (maybe provider) error body
  | "provider_error" // 2xx transport but provider signalled an error payload
  | "network" // DNS/TCP/TLS/socket reset — never reached an HTTP response
  | "timeout" // deadline exceeded
  | "aborted" // AbortController / caller cancellation
  | "stream_error" // stream opened then failed/interrupted mid-flight
  | "decode_error" // response bytes could not be parsed at all
  | "unknown"
>;

/* ============================================================================
 * 2. Raw payloads & graceful degradation (FIRST-CLASS citizens)
 * ========================================================================== */

/**
 * A verbatim (post-redaction) capture of wire bytes. Kept on requests,
 * completions, stream chunks, and errors so the dashboard can ALWAYS fall
 * back to raw display when normalization is partial or absent. This is the
 * core of "degrade, don't break".
 *
 * `encoding` tells a consumer how to read `body`:
 *   - "json":   `body` is the already-parsed JSON value (object/array/etc.).
 *   - "text":   `body` is a string (e.g. a raw SSE frame or non-JSON error).
 *   - "base64": `body` is base64 of opaque bytes (rare; binary error bodies).
 *   - "omitted": body intentionally not captured (see `omittedReason`,
 *                e.g. capture disabled, too large, fully redacted).
 */
export interface RawPayload extends Extensible {
  format: WireFormat;
  encoding: Open<"json" | "text" | "base64" | "omitted">;
  /** Parsed JSON, raw string, base64, or absent when encoding==="omitted". */
  body?: unknown;
  /** Original byte length before any truncation/redaction, if known. */
  byteLength?: number;
  /** True if `body` was truncated to fit a size cap; see `maxBytes`. */
  truncated?: boolean;
  maxBytes?: number;
  /** Why the body was not captured, when encoding==="omitted". */
  omittedReason?: Open<"capture_disabled" | "too_large" | "fully_redacted" | "binary">;
}

/**
 * Attached to any object whose normalization was incomplete. When
 * `degraded` is true on an event, consumers should render from `raw` and
 * treat normalized fields as best-effort. This is how wire drift is survived:
 * the producer flags what it could not map and ships the bytes anyway.
 */
export interface Degradation extends Extensible {
  degraded: true;
  /** Machine-usable reason so dashboards can badge the call. */
  reason: Open<
    | "unknown_wire_format" // could not identify the dialect at all
    | "schema_drift" // known dialect, unexpected fields/shape
    | "partial_parse" // some parts mapped, others left as unknown
    | "parse_failed" // could not parse into normalized form at all
    | "unsupported_feature" // recognized but not yet modeled
    | "producer_version_skew" // producer schema newer than this modeling
  >;
  /** Human-readable detail for the dashboard/logs. */
  message?: string;
  /** JSON Pointers into the associated `raw.body` that could not be mapped. */
  unmappedPaths?: JsonPointer[];
  /** The SCHEMA_VERSION the PRODUCER used, when it differs and is known. */
  producerSchemaVersion?: string;
}

/* ============================================================================
 * 3. Redaction (FIRST-CLASS metadata; happens at the interceptor boundary)
 * ========================================================================== */

/** What class of secret/content a redaction removed. */
export type RedactionCategory = Open<
  | "auth_header" // Authorization / x-api-key / api-key headers
  | "api_key" // key found in body/query/url
  | "cookie"
  | "message_content" // prompt/response text, when content redaction is on
  | "image_data" // inlined base64 media stripped to a summary
  | "audio_data"
  | "pii" // matched a PII rule
  | "custom" // matched a user-supplied redaction rule
  | "other"
>;

/** How the value was removed. Consumers can rely on this to render placeholders
 *  and to know whether ANY signal about the original survives. */
export type RedactionStrategy = Open<
  | "removed" // key deleted entirely
  | "masked" // replaced with a fixed placeholder e.g. "***"
  | "hashed" // replaced with a hash (see `hash`)
  | "truncated" // kept a prefix/suffix, dropped the middle
  | "summarized" // replaced with structural summary (type/length/mime)
>;

/**
 * A single redaction applied to a single location. The collection of these is
 * the audit trail proving what left the process and what did not. Redaction is
 * performed at the interceptor boundary BEFORE the event is serialized, so no
 * unredacted bytes ever reach the collector or disk.
 */
export interface RedactionEntry extends Extensible {
  /** Where the removal happened: which payload + JSON Pointer within it. */
  target: Open<"request_headers" | "request_body" | "response_headers" | "response_body" | "url" | "messages">;
  path: JsonPointer;
  category: RedactionCategory;
  strategy: RedactionStrategy;
  /** Which rule fired — a built-in id or a user rule name — for auditability. */
  ruleId?: string;
  /** Structural residue that is safe to keep, so the UI can show "[image 42KB
   *  image/png redacted]" or "[string, 1284 chars]" without the payload. */
  originalType?: Open<"string" | "number" | "object" | "array" | "boolean" | "binary">;
  originalLength?: number;
  mimeType?: string;
  /** Present only when strategy==="hashed": algorithm + digest of the original,
   *  enabling equality checks (e.g. "same api key as before") without exposure. */
  hash?: { algo: Open<"sha256" | "sha1">; value: string };
}

/**
 * Roll-up of redaction for one event. `redacted: false` with an empty `entries`
 * is a positive assertion that nothing was stripped (useful for auditing that
 * redaction ran at all). `policyId`/`policyVersion` pin the ruleset used.
 */
export interface RedactionInfo extends Extensible {
  redacted: boolean;
  policyId?: string;
  policyVersion?: string;
  entries: RedactionEntry[];
}

/* ============================================================================
 * 4. Normalized messages & content parts
 * ========================================================================== */

/**
 * A single normalized content part. Discriminated on `type`. The mapping from
 * each provider's native shape:
 *
 *  text          OpenAI {type:"text",text} or bare string content
 *                Anthropic {type:"text",text}
 *                Gemini    parts[].text
 *  image/audio/  OpenAI {type:"image_url"} / {type:"input_audio"} / file parts
 *  file          Anthropic {type:"image", source:{...}}
 *                Gemini    parts[].inlineData / parts[].fileData
 *  tool_use      OpenAI assistant message `tool_calls[]` (one part each)
 *                Anthropic {type:"tool_use", id, name, input}
 *                Gemini    parts[].functionCall {name, args}
 *  tool_result   OpenAI role:"tool" message (toolCallId links back)
 *                Anthropic {type:"tool_result", tool_use_id, content}
 *                Gemini    parts[].functionResponse {name, response}
 *  thinking      Anthropic {type:"thinking", thinking, signature}
 *                OpenAI    reasoning summary parts (Responses API)
 *  refusal       OpenAI {type:"refusal", refusal}
 */
export interface ContentPartBase extends Extensible {
  type: ContentPartType;
  /** Set when THIS part could not be fully normalized; carries the bytes. */
  degradation?: Degradation;
  raw?: unknown;
}

export interface TextPart extends ContentPartBase {
  type: "text";
  text: string;
}

/** Media reference — never inlined bytes. Exactly one of url/base64Ref/summary
 *  locates the content; base64 is discouraged and normally redacted to a
 *  summary. */
export interface MediaPart extends ContentPartBase {
  type: "image" | "audio" | "file";
  mimeType?: string;
  /** Remote/data URL as sent (data: URLs are typically redacted). */
  url?: string;
  /** Present when inline bytes were stripped: what they were. */
  summary?: { byteLength?: number; sha256?: string; redacted?: boolean };
  /** Provider-specific detail hints, e.g. OpenAI image `detail:"high"`. */
  detail?: string;
  filename?: string;
}

/** Assistant requesting a tool/function call. `arguments` is the parsed JSON
 *  object when it parsed; `argumentsRaw` preserves the exact string (important
 *  because streamed tool args arrive as partial JSON fragments). */
export interface ToolUsePart extends ContentPartBase {
  type: "tool_use";
  /** Correlates with the matching `ToolResultPart.toolCallId`. Synthesized if
   *  a provider omits one (e.g. single-call Gemini). */
  toolCallId: string;
  name: string;
  arguments?: Record<string, unknown>;
  argumentsRaw?: string;
  /** True while streaming, before the args JSON is complete/parseable. */
  partial?: boolean;
}

/** Tool/function output fed back to the model. */
export interface ToolResultPart extends ContentPartBase {
  type: "tool_result";
  toolCallId: string;
  /** Tool name when the provider carries it (Gemini functionResponse.name). */
  name?: string;
  /** Normalized nested content (a tool may return text and/or media). */
  content?: ContentPart[];
  /** Whether the tool signalled an error (Anthropic tool_result.is_error). */
  isError?: boolean;
}

/** Reasoning / extended thinking. `redactedThinking` marks Anthropic's
 *  encrypted reasoning that the provider itself withholds. */
export interface ThinkingPart extends ContentPartBase {
  type: "thinking";
  text?: string;
  /** Anthropic thinking-block signature, opaque, round-trip only. */
  signature?: string;
  redactedThinking?: boolean;
}

export interface RefusalPart extends ContentPartBase {
  type: "refusal";
  refusal: string;
}

/** Escape hatch: a part we recognized as present but could not classify.
 *  Always accompanied by `raw`. Keeps drift non-fatal at the part level. */
export interface UnknownPart extends ContentPartBase {
  type: "unknown";
  raw: unknown;
}

export type ContentPart =
  | TextPart
  | MediaPart
  | ToolUsePart
  | ToolResultPart
  | ThinkingPart
  | RefusalPart
  | UnknownPart;

/**
 * One normalized message. Provider unification notes:
 *  - Anthropic top-level `system` string/array is lifted into a synthetic
 *    message with role:"system" (flagged `syntheticSystem:true`) so the
 *    dashboard shows a single uniform conversation.
 *  - OpenAI `tool_calls` on an assistant message become `tool_use` parts.
 *  - OpenAI role:"tool" messages become a message with a single
 *    `tool_result` part carrying `toolCallId`.
 *  - Gemini role "model" maps to "assistant"; "function" turns map to tool
 *    results.
 */
export interface NormalizedMessage extends Extensible {
  role: Role;
  content: ContentPart[];
  /** OpenAI parallel-tool naming / participant name, when present. */
  name?: string;
  /** True when synthesized from a top-level system param (Anthropic/Gemini
   *  systemInstruction) rather than an in-array message. */
  syntheticSystem?: boolean;
  /** Set if this whole message could not be normalized. */
  degradation?: Degradation;
  raw?: unknown;
}

/* ============================================================================
 * 5. Request params, tool defs, and the request itself
 * ========================================================================== */

/** A normalized tool/function definition offered to the model. */
export interface ToolDefinition extends Extensible {
  type: Open<"function" | "web_search" | "code_interpreter" | "computer_use" | "custom">;
  name: string;
  description?: string;
  /** JSON Schema for the arguments (OpenAI parameters / Anthropic input_schema
   *  / Gemini parameters). Kept verbatim as a JSON value. */
  parameters?: unknown;
}

/** How the model may/must pick tools. */
export type ToolChoice =
  | Open<"auto" | "none" | "required" | "any">
  | { type: "function" | "tool"; name: string }
  | Record<string, unknown>; // pass-through for shapes we do not model yet

/**
 * Normalized, provider-agnostic generation parameters. All optional — presence
 * mirrors what the caller actually sent. Provider-only knobs that have no
 * normalized home live under `Extensible.x` or in the raw request body.
 */
export interface RequestParams extends Extensible {
  temperature?: number;
  maxTokens?: number; // OpenAI max_tokens / max_completion_tokens, Anthropic max_tokens, Gemini maxOutputTokens
  topP?: number;
  topK?: number;
  stop?: string[]; // normalized to array (OpenAI string|array, Anthropic stop_sequences, Gemini stopSequences)
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  n?: number;
  logProbs?: boolean;
  topLogProbs?: number;
  /** Whether streaming was requested on the wire. */
  stream?: boolean;
  /** OpenAI response_format / Anthropic tool-based JSON / Gemini
   *  responseMimeType+responseSchema, normalized. */
  responseFormat?: {
    type: Open<"text" | "json_object" | "json_schema">;
    jsonSchema?: unknown;
    schemaName?: string;
  };
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /** Anthropic/OpenAI reasoning controls (effort / thinking budget). */
  reasoning?: {
    effort?: Open<"minimal" | "low" | "medium" | "high">;
    maxTokens?: number; // Anthropic thinking.budget_tokens
    enabled?: boolean;
  };
  /** Provider metadata like OpenAI `user`, Anthropic `metadata.user_id`. */
  user?: string;
}

/** The normalized HTTP + LLM request. */
export interface NormalizedRequest extends Extensible {
  provider: Provider;
  wireFormat: WireFormat;
  host: string;
  /** URL path only, query stripped into `query` (secrets redacted). */
  path: string;
  method: Open<"POST" | "GET" | "PUT" | "PATCH" | "DELETE">;
  /** Full URL AFTER redaction (api keys in query params masked). */
  url?: string;
  query?: Record<string, string>;
  model?: string;
  params: RequestParams;
  messages: NormalizedMessage[];
  /** Request headers AFTER redaction (auth stripped, kept for debugging). */
  headers?: Record<string, string>;
  /** Verbatim (post-redaction) request body — the raw fallback. */
  raw: RawPayload;
  /** Set if the request could not be fully normalized. */
  degradation?: Degradation;
}

/* ============================================================================
 * 6. Usage, cost, timing
 * ========================================================================== */

/**
 * Normalized token accounting. Nullable throughout — some providers only
 * report usage at stream end, some not at all. Mapping:
 *  promptTokens      OpenAI usage.prompt_tokens / Anthropic input_tokens /
 *                    Gemini usageMetadata.promptTokenCount
 *  completionTokens  OpenAI completion_tokens / Anthropic output_tokens /
 *                    Gemini candidatesTokenCount
 *  cacheReadTokens   OpenAI prompt_tokens_details.cached_tokens /
 *                    Anthropic cache_read_input_tokens /
 *                    Gemini cachedContentTokenCount
 *  cacheWriteTokens  Anthropic cache_creation_input_tokens
 *  reasoningTokens   OpenAI completion_tokens_details.reasoning_tokens
 */
export interface Usage extends Extensible {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  audioTokens?: number;
  /** Verbatim provider usage object, for fields we do not normalize. */
  raw?: unknown;
}

/**
 * Computed cost. Null-friendly: the entire object is omitted when the model or
 * its pricing is unknown. Amounts are in `currency` major units (e.g. USD).
 * Source is LiteLLM's pricing dataset; `pricePer1kInput`/`Output` pin the exact
 * rates used so a stale price can be re-derived.
 */
export interface Cost extends Extensible {
  currency: Open<"USD">;
  totalCost: number | null;
  inputCost?: number | null;
  outputCost?: number | null;
  cacheReadCost?: number | null;
  cacheWriteCost?: number | null;
  reasoningCost?: number | null;
  /** How the number was obtained; drives a "estimated"/"unknown" UI badge. */
  source: Open<"litellm" | "manual_override" | "provider_reported" | "unknown">;
  pricePer1kInput?: number;
  pricePer1kOutput?: number;
  /** Version/date stamp of the pricing dataset used. */
  pricingVersion?: string;
}

/**
 * Portable timing. Absolute instants are epoch millis; spans are integer ms.
 * `ttftMs` (time-to-first-token) is the headline streaming metric: the gap from
 * request send to the first content/usage byte.
 */
export interface Timing extends Extensible {
  /** When the request left the process. */
  startedAt: EpochMillis;
  /** When the first response byte/chunk arrived (stream open or first delta). */
  firstByteAt?: EpochMillis;
  /** When the first CONTENT token was decoded (may differ from firstByte if
   *  the stream opens with role/preamble frames). */
  firstTokenAt?: EpochMillis;
  /** When the response fully completed or errored. */
  completedAt?: EpochMillis;
  /** Convenience spans (derivable, but precomputed for the dashboard). */
  ttftMs?: DurationMillis; // firstTokenAt - startedAt
  totalMs?: DurationMillis; // completedAt - startedAt
}

/* ============================================================================
 * 7. Event envelope & the discriminated event union
 * ========================================================================== */

/** The event lifecycle discriminator. */
export type EventType =
  | "request_started"
  | "stream_start"
  | "stream_delta"
  | "response_completed"
  | "error";

/**
 * Fields common to EVERY event. `schemaVersion` and `seq` are the load-bearing
 * forward-compat/ordering primitives:
 *   - `schemaVersion` lets a consumer detect producer skew per-event (mixed
 *     producers can write to one log during an upgrade).
 *   - `seq` is a monotonic 0-based counter WITHIN a `requestId`, so consumers
 *     order and de-duplicate deltas without trusting wall-clock `timestamp`.
 */
export interface BaseEvent extends Extensible {
  type: EventType;
  schemaVersion: string;
  /** Stable id correlating all events of one LLM request (uuid/ulid string). */
  requestId: string;
  /** Monotonic per-request sequence, starting at 0 on `request_started`. */
  seq: number;
  /** Emit time, epoch millis. Ordering should prefer `seq` over this. */
  timestamp: EpochMillis;
  /** Groups requests from one interceptor lifetime/run. */
  sessionId: string;
  /** OS process id (or runtime-equivalent) that emitted the event. */
  processId?: string;
  source: {
    language: SourceLanguage;
    sdk: SdkKind;
    sdkVersion?: string;
    transport: Transport;
    /** LLMPeek interceptor package version that produced this. */
    interceptorVersion?: string;
  } & Extensible;
}

/** [1] Lifecycle start. Carries the fully-normalized request + raw body +
 *  redaction audit. `timing.startedAt` anchors all later spans. */
export interface RequestStartedEvent extends BaseEvent {
  type: "request_started";
  request: NormalizedRequest;
  redaction: RedactionInfo;
  timing: Pick<Timing, "startedAt">;
}

/** [2] Stream opened / first byte. Optional but recommended: it pins TTFT and
 *  lets the dashboard flip to "streaming" state before any delta lands. */
export interface StreamStartEvent extends BaseEvent {
  type: "stream_start";
  firstByteAt: EpochMillis;
  /** HTTP status of the (successful) streaming response. */
  httpStatus?: number;
  /** Response headers after redaction (e.g. request-id, rate-limit). */
  responseHeaders?: Record<string, string>;
}

/**
 * [3] One incremental delta. This is the streaming heart of the schema.
 * `index` selects which choice/candidate/content-block this delta targets, so
 * parallel tool calls and multi-candidate responses reassemble correctly.
 * The dashboard reduces deltas into the eventual final message; the producer
 * also emits a `response_completed` with the reassembled result so late joiners
 * and NDJSON replays don't have to fold.
 */
export interface StreamDeltaEvent extends BaseEvent {
  type: "stream_delta";
  /** Which choice/candidate/content-block index this applies to. */
  index?: number;
  /** Incremental text appended to that block, if any. */
  textDelta?: string;
  /** Incremental reasoning/thinking text, if any. */
  thinkingDelta?: string;
  /** Incremental tool-call info. `argumentsRaw` is a PARTIAL JSON fragment to
   *  be concatenated in `seq` order; do not JSON.parse until complete. */
  toolCallDelta?: {
    index: number;
    toolCallId?: string;
    name?: string;
    argumentsRaw?: string;
  };
  /** Role announced by the opening frame (OpenAI first chunk / Anthropic
   *  message_start), when this delta carries it. */
  roleDelta?: Role;
  /** Finish reason if THIS delta is the terminal one for its index
   *  (OpenAI finish_reason / Anthropic message_delta.stop_reason). */
  finishReason?: FinishReason;
  /** Usage if the provider attaches it to a delta (Anthropic message_delta,
   *  OpenAI final chunk with stream_options.include_usage). */
  usage?: Usage;
  /** The provider's own event tag when it is event-typed, so the dashboard can
   *  show the true stream shape (Anthropic message_start /
   *  content_block_start / content_block_delta / content_block_stop /
   *  message_delta / message_stop; OpenAI has none; Gemini none). */
  providerEventType?: string;
  /** Verbatim decoded SSE/JSON frame — the raw fallback for this delta. */
  raw?: RawPayload;
  /** Set if this frame could not be normalized (drift mid-stream). */
  degradation?: Degradation;
}

/**
 * [4] Terminal success. Carries the fully-reassembled message(s), final usage,
 * computed cost, and complete timing. This event is SELF-SUFFICIENT: a consumer
 * that only reads `request_started` + `response_completed` (ignoring deltas)
 * gets the whole call. That redundancy is deliberate — it's what makes NDJSON
 * replay, pagination, and "load only finished calls" cheap.
 */
export interface ResponseCompletedEvent extends BaseEvent {
  type: "response_completed";
  /** Reassembled assistant message(s) — one per choice/candidate. */
  messages: NormalizedMessage[];
  finishReason?: FinishReason;
  /** Provider-native finish/stop reason string, unmapped. */
  rawFinishReason?: string;
  httpStatus?: number;
  responseHeaders?: Record<string, string>;
  usage?: Usage;
  cost?: Cost;
  timing: Timing;
  /** Whether the response was delivered as a stream. */
  streamed: boolean;
  /** Verbatim (post-redaction) final response body. For streamed responses
   *  this MAY be the concatenation/aggregate or omitted in favor of deltas. */
  raw: RawPayload;
  redaction: RedactionInfo;
  degradation?: Degradation;
}

/**
 * [5] Terminal failure / abort. Mutually exclusive with
 * `response_completed` for a given `requestId`. Captures HTTP-status errors,
 * provider error payloads, network failures, timeouts, aborts, and mid-stream
 * breaks. Whatever timing/usage was observed before the failure is retained.
 */
export interface ErrorEvent extends BaseEvent {
  type: "error";
  errorKind: ErrorKind;
  /** HTTP status when one was received (absent for pure network/abort). */
  httpStatus?: number;
  /** Normalized provider error code/type (OpenAI error.type,
   *  Anthropic error.type, Gemini error.status). */
  providerErrorType?: string;
  message: string;
  /** Retryability hint when derivable (429/5xx/network → often true). */
  retryable?: boolean;
  responseHeaders?: Record<string, string>;
  /** Partial results captured before failure (e.g. tokens streamed so far). */
  partialMessages?: NormalizedMessage[];
  usage?: Usage;
  cost?: Cost;
  timing: Timing;
  /** Verbatim (post-redaction) error body / provider error payload. */
  raw?: RawPayload;
  redaction?: RedactionInfo;
  degradation?: Degradation;
}

/**
 * THE canonical event. A collector reads NDJSON lines as `LLMPeekEvent`,
 * discriminates on `type`, and the dashboard folds a per-`requestId` view
 * model. Adding a new event `type` is a MINOR change: existing consumers hit
 * the `default` of their switch and ignore it.
 */
export type LLMPeekEvent =
  | RequestStartedEvent
  | StreamStartEvent
  | StreamDeltaEvent
  | ResponseCompletedEvent
  | ErrorEvent;

/* ============================================================================
 * 8. Consumer helpers (tiny, dependency-free)
 * ========================================================================== */

/** Exhaustiveness guard for `switch (event.type)`. Reaching this at runtime for
 *  a value produced by a NEWER schema is EXPECTED — handle it by rendering
 *  `raw`, not by throwing. */
export function assertNever(_x: never): void {
  /* intentionally empty: unknown future event types degrade, not crash */
}

/** True when major versions match (the only compatibility that matters for
 *  safe consumption). Consumers should still tolerate unknown minor additions. */
export function isMajorCompatible(eventSchemaVersion: string, consumer = SCHEMA_VERSION): boolean {
  return eventSchemaVersion.split(".")[0] === consumer.split(".")[0];
}
