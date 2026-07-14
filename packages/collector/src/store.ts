import { appendFile, chmod, mkdir, open, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LLMPeekEvent } from "@llmpeek/schema";
import { LOG_DIR, LOG_KEEP, LOG_MAX_BYTES } from "./config.js";

// Read at most the last TAIL_BYTES of the log on startup — enough to recover the
// backlog without slurping a multi-hundred-MB file.
const TAIL_BYTES = 16 * 1024 * 1024;

/**
 * Persists events to a size-rotated NDJSON log and keeps a bounded in-memory
 * backlog so a newly-connected dashboard can catch up on recent history.
 */
export class EventStore {
  private recent: LLMPeekEvent[] = [];
  private readonly max = 2000;
  readonly logPath: string;
  private bytes = 0;
  private readonly ready: Promise<void>;

  constructor(baseDir: string = join(process.cwd(), LOG_DIR)) {
    this.logPath = join(baseDir, "events.ndjson");
    // The log holds captured prompt/response text, so keep the dir and file
    // owner-only (0700/0600). chmod enforces it even on a pre-existing dir/log.
    // Also seed the byte counter from any existing log so rotation survives restarts.
    this.ready = mkdir(baseDir, { recursive: true, mode: 0o700 })
      .then(() => chmod(baseDir, 0o700).catch(() => {}))
      .then(() => stat(this.logPath))
      .then(async (s) => {
        this.bytes = s.size;
        await chmod(this.logPath, 0o600).catch(() => {});
        await this.loadRecent(s.size);
      })
      .catch(() => {});
  }

  /** Resolves once startup (dir setup + history replay) has finished. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Replay the tail of the on-disk log into the in-memory backlog so a dashboard
   *  connecting after a collector restart still sees recent history. Best-effort:
   *  a missing or partly-corrupt log just yields a smaller backlog. */
  private async loadRecent(size: number): Promise<void> {
    try {
      const history = await readTailEvents(this.logPath, size, this.max);
      if (history.length) {
        // Prepend history BEFORE any live events that arrived during startup, then
        // keep only the newest `max` so the backlog bound still holds.
        this.recent = [...history, ...this.recent].slice(-this.max);
      }
    } catch {
      // best-effort: an unreadable log just means an empty backlog
    }
  }

  async append(event: LLMPeekEvent): Promise<void> {
    this.recent.push(event);
    if (this.recent.length > this.max) this.recent.shift();
    await this.ready;
    const line = `${JSON.stringify(event)}\n`;
    const len = Buffer.byteLength(line);
    if (this.bytes + len > LOG_MAX_BYTES) await this.rotate();
    this.bytes += len;
    await appendFile(this.logPath, line, { mode: 0o600 }).catch(() => {});
  }

  /** events.ndjson.(N-1) -> .N, … , events.ndjson -> .1, then start fresh. */
  private async rotate(): Promise<void> {
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      await rename(`${this.logPath}.${i}`, `${this.logPath}.${i + 1}`).catch(() => {});
    }
    await rename(this.logPath, `${this.logPath}.1`).catch(() => {});
    this.bytes = 0;
  }

  backlog(): readonly LLMPeekEvent[] {
    return this.recent;
  }

  count(): number {
    return this.recent.length;
  }
}

/** Parse the trailing complete NDJSON lines of the log (up to `max` events). */
async function readTailEvents(path: string, size: number, max: number): Promise<LLMPeekEvent[]> {
  if (size === 0) return [];
  const start = Math.max(0, size - TAIL_BYTES);
  const fh = await open(path, "r");
  try {
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    await fh.read(buf, 0, length, start);
    let text = buf.toString("utf8");
    // If we began mid-file, the first line is a fragment — drop it.
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    const events: LLMPeekEvent[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as LLMPeekEvent);
      } catch {
        // skip a corrupt/partial line
      }
    }
    return events.slice(-max);
  } finally {
    await fh.close();
  }
}
