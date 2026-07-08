import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LLMPeekEvent } from "@llmpeek/schema";
import { LOG_DIR, LOG_KEEP, LOG_MAX_BYTES } from "./config.js";

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
    // Seed the byte counter from any existing log so rotation survives restarts.
    this.ready = mkdir(baseDir, { recursive: true })
      .then(() => stat(this.logPath))
      .then((s) => {
        this.bytes = s.size;
      })
      .catch(() => {});
  }

  async append(event: LLMPeekEvent): Promise<void> {
    this.recent.push(event);
    if (this.recent.length > this.max) this.recent.shift();
    await this.ready;
    const line = `${JSON.stringify(event)}\n`;
    const len = Buffer.byteLength(line);
    if (this.bytes + len > LOG_MAX_BYTES) await this.rotate();
    this.bytes += len;
    await appendFile(this.logPath, line).catch(() => {});
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
