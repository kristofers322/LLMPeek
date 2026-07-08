import type { Cost, LLMPeekEvent, NormalizedMessage, Usage } from "@llmpeek/schema";

/** The per-request view the dashboard renders — materialized by folding the
 *  event stream (event-sourcing reduce), keyed by requestId. */
export interface RequestView {
  requestId: string;
  provider?: string;
  model?: string;
  operation?: string;
  host?: string;
  path?: string;
  status: "pending" | "streaming" | "completed" | "error";
  startedAt?: number;
  ttftMs?: number;
  totalMs?: number;
  promptMessages: NormalizedMessage[];
  responseMessages: NormalizedMessage[];
  streamingText: string;
  usage?: Usage;
  cost?: Cost;
  finishReason?: string;
  errorMessage?: string;
  streamed: boolean;
  lastSeq: number;
  events: LLMPeekEvent[];
}

export function emptyView(requestId: string): RequestView {
  return {
    requestId,
    status: "pending",
    promptMessages: [],
    responseMessages: [],
    streamingText: "",
    streamed: false,
    lastSeq: -1,
    events: [],
  };
}

/** Fold one event into a request's view (mutates and returns it). */
export function applyEvent(view: RequestView, event: LLMPeekEvent): RequestView {
  // Idempotent: on WS reconnect the collector replays its backlog, so skip any
  // event already folded (seq is monotonic per request) — otherwise streaming
  // text would be duplicated on every reconnect.
  if (event.seq <= view.lastSeq) return view;
  view.events.push(event);
  view.lastSeq = Math.max(view.lastSeq, event.seq);

  switch (event.type) {
    case "request_started": {
      const r = event.request;
      view.provider = r.provider;
      view.model = r.model;
      view.operation = r.operation;
      view.host = r.host;
      view.path = r.path;
      view.promptMessages = r.messages ?? [];
      view.startedAt = event.timing.startedAt;
      break;
    }
    case "stream_start":
      view.streamed = true;
      if (view.status === "pending") view.status = "streaming";
      break;
    case "stream_delta":
      view.streamed = true;
      if (view.status === "pending" || view.status === "streaming") view.status = "streaming";
      if (event.textDelta) view.streamingText += event.textDelta;
      if (event.usage) view.usage = event.usage;
      if (event.finishReason) view.finishReason = event.finishReason;
      break;
    case "response_completed":
      view.status = "completed";
      view.streamed = event.streamed;
      if (event.messages) view.responseMessages = event.messages;
      if (event.usage) view.usage = event.usage;
      if (event.cost) view.cost = event.cost;
      if (event.finishReason) view.finishReason = event.finishReason;
      view.ttftMs = event.timing.ttftMs;
      view.totalMs = event.timing.totalMs;
      break;
    case "error":
      view.status = "error";
      view.errorMessage = event.message;
      view.ttftMs = event.timing.ttftMs;
      view.totalMs = event.timing.totalMs;
      break;
    default:
      // Unknown future event type (forward-compat): recorded in `events`, no fold.
      break;
  }
  return view;
}
