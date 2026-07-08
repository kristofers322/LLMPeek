import { describe, expect, it } from "vitest";
import { type RequestView, applyEvent, emptyView } from "../src/lib/fold.js";

const seq = [
  {
    type: "request_started",
    requestId: "r",
    seq: 0,
    timing: { startedAt: 1 },
    request: {
      provider: "openai",
      model: "gpt-4o-mini",
      operation: "chat",
      host: "h",
      path: "/p",
      messages: [],
    },
  },
  { type: "stream_start", requestId: "r", seq: 1, firstByteAt: 2 },
  { type: "stream_delta", requestId: "r", seq: 2, textDelta: "He" },
  { type: "stream_delta", requestId: "r", seq: 3, textDelta: "llo" },
  {
    type: "response_completed",
    requestId: "r",
    seq: 4,
    streamed: true,
    timing: { startedAt: 1, totalMs: 5 },
    usage: { promptTokens: 5, completionTokens: 2 },
    messages: [{ role: "assistant", content: [{ type: "text", text: "Hello" }] }],
    finishReason: "stop",
  },
] as const;

function fold(): RequestView {
  const v = emptyView("r");
  for (const e of seq) applyEvent(v, e as never);
  return v;
}

describe("fold reducer", () => {
  it("folds a streaming lifecycle into a view", () => {
    const v = fold();
    expect(v.status).toBe("completed");
    expect(v.streamingText).toBe("Hello");
    expect(v.usage?.promptTokens).toBe(5);
    expect(v.model).toBe("gpt-4o-mini");
  });

  it("is idempotent on backlog replay (no duplicated text)", () => {
    const v = fold();
    const text = v.streamingText;
    const count = v.events.length;
    for (const e of seq) applyEvent(v, e as never);
    expect(v.streamingText).toBe(text);
    expect(v.events.length).toBe(count);
  });
});
