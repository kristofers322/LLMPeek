import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LLMPeekEvent } from "@llmpeek/schema";
import { LOG_DIR } from "./config.js";

/**
 * Persists events to an append-only NDJSON log and keeps a bounded in-memory
 * backlog so a newly-connected dashboard can catch up on recent history.
 */
export class EventStore {
  private recent: LLMPeekEvent[] = [];
  private readonly max = 2000;
  readonly logPath: string;
  private readonly ready: Promise<void>;

  constructor(baseDir: string = join(process.cwd(), LOG_DIR)) {
    this.logPath = join(baseDir, "events.ndjson");
    this.ready = mkdir(baseDir, { recursive: true }).then(() => undefined);
  }

  async append(event: LLMPeekEvent): Promise<void> {
    this.recent.push(event);
    if (this.recent.length > this.max) this.recent.shift();
    await this.ready;
    await appendFile(this.logPath, `${JSON.stringify(event)}\n`).catch(() => {});
  }

  backlog(): readonly LLMPeekEvent[] {
    return this.recent;
  }

  count(): number {
    return this.recent.length;
  }
}
