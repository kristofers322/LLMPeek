import { ensureCollector, ship } from "./collector-client.js";
import { install, uninstall } from "./interceptor.js";
import {
  SCHEMA_VERSION,
  clearEvents,
  getEvents,
  isEnabled,
  sessionId,
  subscribe,
} from "./runtime.js";
import type { Sink } from "./runtime.js";
import { VERSION } from "./version.js";

// `llmpeek` — the one published package and the single-import entry point.
// Importing it installs the observe-only HTTP interceptor and auto-spawns the
// local collector. The import IS the opt-in; install() still refuses to run in
// obviously-deployed environments (see isEnabled()).
export {
  install,
  uninstall,
  subscribe,
  getEvents,
  clearEvents,
  sessionId,
  SCHEMA_VERSION,
  ensureCollector,
};
export type { Sink };
// Re-export the event schema types so consumers can type their sinks/events.
export type * from "@llmpeek/schema";

/** llmpeek package version (single-sourced from package.json). */
export const version = VERSION;

if (isEnabled()) {
  install();
  // Spawn/attach the collector, then stream captured events to it. Best-effort:
  // capture works even if the collector never comes up.
  void (async () => {
    await ensureCollector();
    subscribe(ship);
  })();
}
