import type { LLMPeekEvent } from "@llmpeek/schema";
import { costFor } from "./pricing.js";

// Correlate the model (only on request_started) with usage (only on terminal
// events) so we can attach cost. Bounded so a long-running collector can't leak.
const modelByRequest = new Map<string, string>();
const MAX = 10_000;

/** Enrich an event in place with computed cost, then return it. Best-effort. */
export function enrich(event: LLMPeekEvent): LLMPeekEvent {
  try {
    if (event.type === "request_started") {
      if (event.request.model) {
        modelByRequest.set(event.requestId, event.request.model);
        if (modelByRequest.size > MAX) {
          const oldest = modelByRequest.keys().next().value;
          if (oldest !== undefined) modelByRequest.delete(oldest);
        }
      }
    } else if (
      (event.type === "response_completed" || event.type === "error") &&
      !event.cost &&
      event.usage
    ) {
      const model = modelByRequest.get(event.requestId);
      if (model) {
        const cost = costFor(model, event.usage);
        if (cost) event.cost = cost;
      }
      if (event.type === "response_completed") modelByRequest.delete(event.requestId);
    }
  } catch {
    // enrichment must never break ingest
  }
  return event;
}
