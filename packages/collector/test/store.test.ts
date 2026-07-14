import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore } from "../src/store.js";

const ev = (requestId: string, seq: number) => ({
  type: "request_started",
  schemaVersion: "1.0.0",
  sessionId: "s",
  requestId,
  seq,
  timing: { startedAt: 1 },
  request: {
    provider: "openai",
    model: "m",
    operation: "chat",
    host: "h",
    path: "/p",
    messages: [],
  },
});

const ndjson = (...events: object[]) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
const ids = (store: EventStore) => store.backlog().map((e) => e.requestId);

describe("EventStore history replay", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "llmpeek-store-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replays events from an existing log on startup, in order", async () => {
    await writeFile(join(dir, "events.ndjson"), ndjson(ev("a", 0), ev("b", 0), ev("c", 0)));
    const store = new EventStore(dir);
    await store.whenReady();
    expect(ids(store)).toEqual(["a", "b", "c"]);
    expect(store.count()).toBe(3);
  });

  it("skips corrupt lines", async () => {
    await writeFile(
      join(dir, "events.ndjson"),
      `${JSON.stringify(ev("a", 0))}\nnot json\n${JSON.stringify(ev("b", 0))}\n`,
    );
    const store = new EventStore(dir);
    await store.whenReady();
    expect(ids(store)).toEqual(["a", "b"]);
  });

  it("keeps events that arrive during startup, after the replayed history", async () => {
    await writeFile(join(dir, "events.ndjson"), ndjson(ev("a", 0), ev("b", 0)));
    const store = new EventStore(dir);
    // Fires synchronously, before the async history load resolves.
    const pending = store.append(ev("live", 0) as never);
    await store.whenReady();
    await pending;
    expect(ids(store)).toEqual(["a", "b", "live"]);
  });

  it("starts with an empty backlog when no log exists", async () => {
    const store = new EventStore(dir);
    await store.whenReady();
    expect(store.backlog()).toEqual([]);
  });
});
