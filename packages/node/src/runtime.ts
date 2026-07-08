import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION } from "@llmpeek/schema";
import type { LLMPeekEvent, Source } from "@llmpeek/schema";

/** Version stamped onto every event's `source.interceptorVersion`. */
export const INTERCEPTOR_VERSION = "0.0.0";

export type Sink = (event: LLMPeekEvent) => void;

const sinks = new Set<Sink>();
const buffer: LLMPeekEvent[] = [];
const MAX_BUFFER = 1000;
const seqByRequest = new Map<string, number>();

/** Stable id for this interceptor lifetime; groups all requests from one run. */
export const sessionId = randomUUID();

/** Monotonic per-request sequence, starting at 0 on request_started. */
export function nextSeq(requestId: string): number {
  const n = seqByRequest.get(requestId) ?? 0;
  seqByRequest.set(requestId, n + 1);
  return n;
}

export function endRequest(requestId: string): void {
  seqByRequest.delete(requestId);
}

/** Register an event sink. Returns an unsubscribe function. */
export function subscribe(sink: Sink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/** Recent events (bounded ring buffer), oldest first. */
export function getEvents(): readonly LLMPeekEvent[] {
  return buffer;
}

export function clearEvents(): void {
  buffer.length = 0;
}

/**
 * Fan an event out to every sink. Observe-only: a throwing sink can never break
 * capture, the other sinks, or the host application.
 */
export function emit(event: LLMPeekEvent): void {
  buffer.push(event);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  for (const sink of sinks) {
    try {
      sink(event);
    } catch {
      // swallow: a bad sink must not affect the app or other sinks
    }
  }
}

export function makeSource(sdk: Source["sdk"], transport: Source["transport"]): Source {
  return { language: "node", sdk, transport, interceptorVersion: INTERCEPTOR_VERSION };
}

/**
 * Whether capture should run. The import itself is the opt-in; this only
 * REFUSES in obviously-deployed environments so the tool never captures in
 * production by accident. `LLMPEEK=1|0` forces on/off explicitly.
 */
export function isEnabled(): boolean {
  // The proxy process must never self-install the interceptor — it would capture
  // its own upstream forwarding and loop.
  if (process.env.LLMPEEK_ROLE === "proxy") return false;
  const flag = (process.env.LLMPEEK ?? "").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  if (process.env.NODE_ENV === "production") return false;
  const deployed = [
    "AWS_LAMBDA_FUNCTION_NAME",
    "VERCEL",
    "K_SERVICE",
    "FUNCTIONS_WORKER_RUNTIME",
    "DYNO",
  ];
  if (deployed.some((m) => process.env[m])) return false;
  return true;
}

export { SCHEMA_VERSION };
