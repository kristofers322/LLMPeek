/** The collector always binds loopback only — never exposed off the machine. */
export const COLLECTOR_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4319;

/** Port the collector listens on / the client connects to. Override with LLMPEEK_PORT. */
export function getPort(): number {
  const p = Number(process.env.LLMPEEK_PORT);
  return Number.isInteger(p) && p > 0 ? p : DEFAULT_PORT;
}

/** Directory (relative to the app cwd) for the NDJSON capture log. Gitignored. */
export const LOG_DIR = ".llmpeek";

/** Rotate the NDJSON log once it exceeds this size. Override LLMPEEK_LOG_MAX_MB. */
export const LOG_MAX_BYTES = (() => {
  const mb = Number(process.env.LLMPEEK_LOG_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 100) * 1024 * 1024;
})();

/** Number of rotated log generations to keep (events.ndjson.1 … .N). */
export const LOG_KEEP = 3;
