import { describe, expect, it } from "vitest";
import { createStreamAggregator } from "../src/decoders/registry.js";
import {
  ResponsesStreamAggregator,
  decodeResponsesRequest,
  decodeResponsesResponse,
} from "../src/decoders/responses.js";
import { SSEParser } from "../src/sse.js";

describe("Responses request decoder", () => {
  it("lifts instructions to a synthetic system message and a string input to a user message", () => {
    const d = decodeResponsesRequest({
      model: "gpt-5",
      instructions: "be terse",
      input: "hello",
      max_output_tokens: 256,
      reasoning: { effort: "medium" },
    });
    expect(d.model).toBe("gpt-5");
    expect(d.messages[0]).toMatchObject({ role: "system", syntheticSystem: true });
    expect(d.messages[0].content[0]).toMatchObject({ type: "text", text: "be terse" });
    expect(d.messages[1]).toMatchObject({ role: "user" });
    expect(d.messages[1].content[0]).toMatchObject({ type: "text", text: "hello" });
    expect(d.params.maxTokens).toBe(256);
    expect(d.params.reasoning?.effort).toBe("medium");
  });

  it("decodes an input-item array (message parts, function_call, function_call_output)", () => {
    const d = decodeResponsesRequest({
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "hi" },
            { type: "input_image", image_url: "https://x/y.png", detail: "high" },
          ],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"Riga"}',
        },
        { type: "function_call_output", call_id: "call_1", output: "sunny, 20C" },
      ],
    });
    // user message with text + image
    expect(d.messages[0].content.map((p) => p.type)).toEqual(["text", "image"]);
    expect(d.messages[0].content[1]).toMatchObject({
      type: "image",
      url: "https://x/y.png",
      detail: "high",
    });
    // function_call -> assistant tool_use, args parsed
    const tool = d.messages[1].content[0];
    expect(tool).toMatchObject({ type: "tool_use", toolCallId: "call_1", name: "get_weather" });
    if (tool.type === "tool_use") expect(tool.arguments).toEqual({ city: "Riga" });
    // function_call_output -> tool role tool_result
    expect(d.messages[2]).toMatchObject({ role: "tool" });
    expect(d.messages[2].content[0]).toMatchObject({ type: "tool_result", toolCallId: "call_1" });
  });

  it("decodes the flat tools shape and the flattened text.format", () => {
    const d = decodeResponsesRequest({
      model: "gpt-4o",
      input: "x",
      tools: [
        { type: "function", name: "lookup", description: "d", parameters: { type: "object" } },
        { type: "web_search_preview" },
      ],
      text: {
        format: { type: "json_schema", name: "Result", schema: { type: "object" }, strict: true },
      },
    });
    expect(d.params.tools?.[0]).toMatchObject({
      type: "function",
      name: "lookup",
      description: "d",
    });
    expect(d.params.tools?.[1]).toMatchObject({
      type: "web_search_preview",
      name: "web_search_preview",
    });
    expect(d.params.responseFormat).toMatchObject({ type: "json_schema", schemaName: "Result" });
  });
});

describe("Responses non-streaming response decoder", () => {
  it("decodes output text + reasoning summary + usage, finish=stop", () => {
    const d = decodeResponsesResponse({
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "thinking..." }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello there" }],
        },
      ],
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 8 },
        total_tokens: 30,
      },
    });
    const types = d.messages?.[0].content.map((p) => p.type);
    expect(types).toEqual(["thinking", "text"]);
    expect(d.finishReason).toBe("stop");
    expect(d.usage).toMatchObject({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      cacheReadTokens: 4,
      reasoningTokens: 8,
    });
  });

  it("maps a function_call output item to finish=tool_calls", () => {
    const d = decodeResponsesResponse({
      status: "completed",
      output: [
        { type: "function_call", id: "fc_1", call_id: "call_9", name: "f", arguments: "{}" },
      ],
    });
    expect(d.finishReason).toBe("tool_calls");
    const tool = d.messages?.[0].content[0];
    expect(tool).toMatchObject({ type: "tool_use", toolCallId: "call_9", name: "f" });
  });

  it("maps incomplete/max_output_tokens to finish=length", () => {
    const d = decodeResponsesResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] },
      ],
    });
    expect(d.finishReason).toBe("length");
    expect(d.rawFinishReason).toBe("max_output_tokens");
  });
});

describe("Responses stream aggregator", () => {
  const feed = (agg: ResponsesStreamAggregator, type: string, o: Record<string, unknown>) =>
    agg.handleChunk({ type, ...o }, type);

  it("reassembles streamed text + a tool call + reasoning, with terminal usage", () => {
    const agg = new ResponsesStreamAggregator();
    // reasoning item at index 0
    feed(agg, "response.output_item.added", {
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", summary: [] },
    });
    feed(agg, "response.reasoning_summary_text.delta", {
      output_index: 0,
      summary_index: 0,
      delta: "let me ",
    });
    feed(agg, "response.reasoning_summary_text.delta", {
      output_index: 0,
      summary_index: 0,
      delta: "think",
    });
    // message item at index 1
    feed(agg, "response.output_item.added", {
      output_index: 1,
      item: { type: "message", id: "msg_1", role: "assistant" },
    });
    feed(agg, "response.output_text.delta", { output_index: 1, content_index: 0, delta: "Hel" });
    const midInfos = feed(agg, "response.output_text.delta", {
      output_index: 1,
      content_index: 0,
      delta: "lo",
    });
    expect(midInfos[0]).toMatchObject({ textDelta: "lo", blockIndex: 1 });
    // function_call item at index 2 (args stream with NO content_index)
    feed(agg, "response.output_item.added", {
      output_index: 2,
      item: { type: "function_call", id: "fc_1", call_id: "call_7", name: "get_time" },
    });
    feed(agg, "response.function_call_arguments.delta", {
      output_index: 2,
      item_id: "fc_1",
      delta: '{"tz":',
    });
    feed(agg, "response.function_call_arguments.delta", {
      output_index: 2,
      item_id: "fc_1",
      delta: '"UTC"}',
    });
    feed(agg, "response.completed", {
      response: {
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 12, total_tokens: 17 },
      },
    });

    const fin = agg.finalize();
    const content = fin.messages?.[0].content ?? [];
    expect(content[0]).toMatchObject({ type: "thinking", text: "let me think" });
    expect(content[1]).toMatchObject({ type: "text", text: "Hello" });
    const tool = content[2];
    expect(tool).toMatchObject({ type: "tool_use", toolCallId: "call_7", name: "get_time" });
    if (tool.type === "tool_use") {
      expect(tool.argumentsRaw).toBe('{"tz":"UTC"}');
      expect(tool.arguments).toEqual({ tz: "UTC" });
    }
    expect(fin.finishReason).toBe("tool_calls");
    expect(fin.usage).toMatchObject({ promptTokens: 5, completionTokens: 12, totalTokens: 17 });
  });

  it("captures a streamed refusal", () => {
    const agg = new ResponsesStreamAggregator();
    feed(agg, "response.output_item.added", {
      output_index: 0,
      item: { type: "message", role: "assistant" },
    });
    feed(agg, "response.refusal.delta", { output_index: 0, content_index: 0, delta: "I can't " });
    feed(agg, "response.refusal.delta", {
      output_index: 0,
      content_index: 0,
      delta: "help with that",
    });
    feed(agg, "response.completed", { response: { status: "completed" } });
    const fin = agg.finalize();
    expect(fin.messages?.[0].content[0]).toMatchObject({
      type: "refusal",
      refusal: "I can't help with that",
    });
    expect(fin.finishReason).toBe("refusal");
  });
});

describe("Responses end-to-end: raw SSE through the interceptor's stream path", () => {
  // Mirrors what interceptor.consumeStream does: split raw SSE bytes into frames,
  // dispatch via the registry (which must pick the Responses aggregator), fold.
  it("dispatches openai_responses to the right aggregator and reassembles the stream", () => {
    const match = {
      provider: "openai",
      wireFormat: "openai_responses",
      operation: "chat",
    } as const;
    const agg = createStreamAggregator(match);
    expect(agg).toBeInstanceOf(ResponsesStreamAggregator);

    const raw = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"The capital "}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"of Latvia is Riga."}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":9,"output_tokens":7,"total_tokens":16}}}\n\n',
    ].join("");

    const parser = new SSEParser();
    for (const frame of parser.push(raw)) {
      agg.handleChunk(JSON.parse(frame.data), frame.event);
    }
    const fin = agg.finalize();
    expect(fin.messages?.[0].content[0]).toMatchObject({
      type: "text",
      text: "The capital of Latvia is Riga.",
    });
    expect(fin.finishReason).toBe("stop");
    expect(fin.usage).toMatchObject({ promptTokens: 9, completionTokens: 7, totalTokens: 16 });
  });
});
