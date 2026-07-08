import { ensureCollector, ship } from "./collector-client.js";
import { install, uninstall } from "./interceptor.js";
import {
  SCHEMA_VERSION,
  type Sink,
  clearEvents,
  getEvents,
  isContentRedaction,
  isEnabled,
  sessionId,
  setContentRedaction,
  subscribe,
} from "./runtime.js";
import { VERSION } from "./version.js";

// `llmpeek` — the one published package and the single-import entry point.
// Importing it installs the observe-only HTTP interceptor and auto-spawns the
// local collector. The import IS the opt-in; install() still refuses to run in
// obviously-deployed environments (see isEnabled()).

/** Options for {@link configure}. */
export interface LLMPeekOptions {
  /** Force capture on/off, overriding the environment heuristic. */
  enabled?: boolean;
  /**
   * `'credentials'` (default) strips secrets from headers/url/body but keeps
   * prompt & response content. `'content'` ALSO masks all message content, tool
   * arguments, thinking, and raw bodies before anything leaves the process —
   * use it when prompts may contain PII or sensitive data.
   */
  redact?: "credentials" | "content";
  /** Register a sink that receives every captured event. */
  sink?: Sink;
}

/**
 * Configure capture at runtime. Safe to call before or after the auto-install
 * (the redaction policy and sinks apply to all subsequent events).
 */
export function configure(options: LLMPeekOptions = {}): void {
  if (options.redact !== undefined) setContentRedaction(options.redact === "content");
  if (options.sink) subscribe(options.sink);
  if (options.enabled === false) uninstall();
  else if (options.enabled === true) activate();
}

function activate(): void {
  install();
  // Spawn/attach the collector, then stream captured events to it. Best-effort:
  // capture works even if the collector never comes up.
  void (async () => {
    await ensureCollector();
    subscribe(ship);
  })();
}

export {
  install,
  uninstall,
  subscribe,
  getEvents,
  clearEvents,
  sessionId,
  SCHEMA_VERSION,
  ensureCollector,
  isEnabled,
  isContentRedaction,
};
export type { Sink };
// Re-export the event schema types so consumers can type their sinks/events.
export type * from "@llmpeek/schema";

/** llmpeek package version (single-sourced from package.json). */
export const version = VERSION;

if (isEnabled()) activate();
