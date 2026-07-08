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
