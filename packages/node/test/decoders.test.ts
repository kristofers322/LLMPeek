import { describe, expect, it } from "vitest";
import {
  AnthropicStreamAggregator,
  decodeMessagesRequest,
  decodeMessagesResponse,
} from "../src/decoders/anthropic.js";
import { OpenAIStreamAggregator } from "../src/decoders/openai.js";

describe("OpenAI decoder", () => {
  it("reassembles streaming text + tool calls, guards array args", () => {
    const agg = new OpenAIStreamAggregator();
    agg.handleChunk({ choices: [{ index: 0, delta: { role: "assistant" } }] });
    agg.handleChunk({ choices: [{ index: 0, delta: { content: "Hi" } }] });
    agg.handleChunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "t", function: { name: "f", arguments: "[1,2]" } }],
          },
        },
      ],
    });
    const fin = agg.finalize();
    expect(fin.messages?.[0].content[0].text).toBe("Hi");
    const tool = fin.messages?.[0].content.find((p) => p.type === "tool_use");
    expect(tool?.argumentsRaw).toBe("[1,2]");
    expect(tool?.arguments).toBeUndefined();
  });

  it("emits one delta per tool fragment in a chunk", () => {
    const agg = new OpenAIStreamAggregator();
    const infos = agg.handleChunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "a", function: { arguments: "{" } },
              { index: 1, id: "b", function: { arguments: "{" } },
            ],
          },
        },
      ],
    });
    expect(infos.filter((i) => i.toolCallDelta)).toHaveLength(2);
  });
});

describe("Anthropic decoder", () => {
  it("lifts top-level system to a synthetic message", () => {
    const d = decodeMessagesRequest({
      model: "claude",
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(d.messages[0].role).toBe("system");
    expect(d.messages[0].syntheticSystem).toBe(true);
  });

  it("maps stop_reason + cache-aware usage", () => {
    const d = decodeMessagesResponse({
      role: "assistant",
      content: [{ type: "text", text: "x" }],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
    });
    expect(d.finishReason).toBe("tool_calls");
    expect(d.usage?.cacheReadTokens).toBe(2);
    expect(d.usage?.totalTokens).toBe(15);
  });

  it("reassembles an event-typed stream", () => {
    const agg = new AnthropicStreamAggregator();
    const feed = (type: string, o: Record<string, unknown>) =>
      agg.handleChunk({ type, ...o }, type);
    feed("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    feed("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Sun" } });
    feed("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ny" } });
    feed("message_delta", { delta: { stop_reason: "end_turn" } });
    const fin = agg.finalize();
    expect(fin.messages?.[0].content[0].text).toBe("Sunny");
    expect(fin.finishReason).toBe("stop");
  });
});
