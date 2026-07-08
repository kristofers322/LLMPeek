import type {
  ContentPart,
  FinishReason,
  NormalizedMessage,
  RequestParams,
  ToolDefinition,
  ToolUsePart,
  Usage,
} from "@llmpeek/schema";
import {
  type JsonObject,
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  tryParseJson,
} from "../json.js";
import type { DecodedRequest, DecodedResponse, StreamDeltaInfo } from "./openai.js";

// ------------------------------------------------------------------ request ---

export function decodeMessagesRequest(bodyUnknown: unknown): DecodedRequest {
  const body = asObject(bodyUnknown);
  const params: RequestParams = {};
  setNum(params, "maxTokens", body.max_tokens);
  setNum(params, "temperature", body.temperature);
  setNum(params, "topP", body.top_p);
  setNum(params, "topK", body.top_k);
  const stream = asBoolean(body.stream);
  if (stream !== undefined) params.stream = stream;
  if (Array.isArray(body.stop_sequences)) {
    params.stop = body.stop_sequences.filter((s): s is string => typeof s === "string");
  }
  if (Array.isArray(body.tools)) {
    const tools = body.tools.map(decodeTool).filter((t): t is ToolDefinition => t !== undefined);
    if (tools.length) params.tools = tools;
  }
  if (body.tool_choice !== undefined) {
    params.toolChoice =
      typeof body.tool_choice === "string" ? body.tool_choice : asObject(body.tool_choice);
  }
  const thinking = asObject(body.thinking);
  if (thinking.type === "enabled" || thinking.budget_tokens !== undefined) {
    params.reasoning = { enabled: thinking.type === "enabled" };
    const budget = asNumber(thinking.budget_tokens);
    if (budget !== undefined) params.reasoning.maxTokens = budget;
  }
  const user = asString(asObject(body.metadata).user_id);
  if (user) params.user = user;

  const messages: NormalizedMessage[] = [];
  const system = decodeSystem(body.system);
  if (system) messages.push(system);
  for (const m of asArray(body.messages)) messages.push(decodeMessage(m));

  return { model: asString(body.model), params, messages };
}

/** Anthropic's top-level `system` is lifted into a synthetic system message. */
function decodeSystem(v: unknown): NormalizedMessage | undefined {
  if (typeof v === "string") {
    return v
      ? { role: "system", content: [{ type: "text", text: v }], syntheticSystem: true }
      : undefined;
  }
  if (Array.isArray(v)) {
    const content: ContentPart[] = [];
    for (const p of v) {
      const text = asString(asObject(p).text);
      if (text) content.push({ type: "text", text });
    }
    if (content.length) return { role: "system", content, syntheticSystem: true };
  }
  return undefined;
}

function decodeMessage(v: unknown): NormalizedMessage {
  const m = asObject(v);
  const role = asString(m.role) ?? "user";
  const content: ContentPart[] = [];
  if (typeof m.content === "string") {
    if (m.content) content.push({ type: "text", text: m.content });
  } else {
    for (const p of asArray(m.content)) {
      const part = decodeContentPart(p);
      if (part) content.push(part);
    }
  }
  return { role, content };
}

function decodeContentPart(v: unknown): ContentPart | undefined {
  const p = asObject(v);
  const type = asString(p.type);
  if (type === "text") return { type: "text", text: asString(p.text) ?? "" };
  if (type === "image") {
    const part: ContentPart = { type: "image" };
    const mime = asString(asObject(p.source).media_type);
    if (mime) part.mimeType = mime;
    return part;
  }
  if (type === "tool_use") {
    const part: ToolUsePart = {
      type: "tool_use",
      toolCallId: asString(p.id) ?? "",
      name: asString(p.name) ?? "",
    };
    if (p.input !== undefined && typeof p.input === "object") {
      part.arguments = asObject(p.input);
      part.argumentsRaw = JSON.stringify(p.input);
    }
    return part;
  }
  if (type === "tool_result") {
    const part: ContentPart = { type: "tool_result", toolCallId: asString(p.tool_use_id) ?? "" };
    const isError = asBoolean(p.is_error);
    if (isError !== undefined) part.isError = isError;
    if (typeof p.content === "string") {
      part.content = [{ type: "text", text: p.content }];
    } else if (Array.isArray(p.content)) {
      const nested: ContentPart[] = [];
      for (const c of p.content) {
        const np = decodeContentPart(c);
        if (np) nested.push(np);
      }
      if (nested.length) part.content = nested;
    }
    return part;
  }
  if (type === "thinking") {
    const part: ContentPart = { type: "thinking", text: asString(p.thinking) ?? "" };
    const sig = asString(p.signature);
    if (sig) part.signature = sig;
    return part;
  }
  if (type === "redacted_thinking") return { type: "thinking", redactedThinking: true };
  return { type: "unknown", raw: v };
}

function decodeTool(v: unknown): ToolDefinition | undefined {
  const t = asObject(v);
  const name = asString(t.name);
  if (!name) return undefined;
  const def: ToolDefinition = { type: "function", name };
  const description = asString(t.description);
  if (description) def.description = description;
  if (t.input_schema !== undefined) def.parameters = t.input_schema;
  return def;
}

// --------------------------------------------------- non-streaming response ---

export function decodeMessagesResponse(bodyUnknown: unknown): DecodedResponse {
  const body = asObject(bodyUnknown);
  const content: ContentPart[] = [];
  for (const p of asArray(body.content)) {
    const part = decodeContentPart(p);
    if (part) content.push(part);
  }
  const out: DecodedResponse = {
    messages: [{ role: asString(body.role) ?? "assistant", choiceIndex: 0, content }],
  };
  const raw = asString(body.stop_reason);
  if (raw) {
    out.rawFinishReason = raw;
    out.finishReason = mapStop(raw);
  }
  const usage = mapUsage(body.usage);
  if (usage) out.usage = usage;
  return out;
}

// ----------------------------------------------------------------- streaming ---

interface BlockAcc {
  type: string;
  text: string;
  toolId?: string;
  toolName?: string;
  toolArgs: string;
  signature?: string;
}

/** Folds Anthropic's event-typed SSE stream (message_start / content_block_* /
 *  message_delta / message_stop) into deltas and a reassembled message. */
export class AnthropicStreamAggregator {
  private blocks = new Map<number, BlockAcc>();
  private role = "assistant";
  private usage?: Usage;
  private finishRaw?: string;

  handleChunk(json: unknown, _eventType?: string): StreamDeltaInfo[] {
    const ev = asObject(json);
    const type = asString(ev.type) ?? _eventType ?? "";
    const infos: StreamDeltaInfo[] = [];

    if (type === "message_start") {
      const msg = asObject(ev.message);
      this.role = asString(msg.role) ?? "assistant";
      const u = mapUsage(msg.usage);
      if (u) this.usage = u;
      return infos;
    }
    if (type === "content_block_start") {
      const idx = asNumber(ev.index) ?? 0;
      const cb = asObject(ev.content_block);
      const acc: BlockAcc = { type: asString(cb.type) ?? "text", text: "", toolArgs: "" };
      if (acc.type === "tool_use") {
        acc.toolId = asString(cb.id);
        acc.toolName = asString(cb.name);
        infos.push({
          index: 0,
          blockIndex: idx,
          toolCallDelta: {
            ...(acc.toolId ? { toolCallId: acc.toolId } : {}),
            ...(acc.toolName ? { name: acc.toolName } : {}),
          },
        });
      }
      this.blocks.set(idx, acc);
      return infos;
    }
    if (type === "content_block_delta") {
      const idx = asNumber(ev.index) ?? 0;
      const acc = this.block(idx);
      const d = asObject(ev.delta);
      const dt = asString(d.type);
      if (dt === "text_delta") {
        const t = asString(d.text) ?? "";
        acc.text += t;
        if (t) infos.push({ index: 0, blockIndex: idx, textDelta: t });
      } else if (dt === "thinking_delta") {
        const t = asString(d.thinking) ?? "";
        acc.text += t;
        if (t) infos.push({ index: 0, blockIndex: idx, thinkingDelta: t });
      } else if (dt === "input_json_delta") {
        const j = asString(d.partial_json) ?? "";
        acc.toolArgs += j;
        if (j) infos.push({ index: 0, blockIndex: idx, toolCallDelta: { argumentsRaw: j } });
      } else if (dt === "signature_delta") {
        acc.signature = (acc.signature ?? "") + (asString(d.signature) ?? "");
      }
      return infos;
    }
    if (type === "message_delta") {
      const sr = asString(asObject(ev.delta).stop_reason);
      if (sr) {
        this.finishRaw = sr;
        infos.push({ index: 0, finishReason: mapStop(sr) });
      }
      const u = mapUsage(ev.usage);
      if (u) {
        this.usage = { ...this.usage, ...u };
        infos.push({ usage: this.usage });
      }
      return infos;
    }
    // content_block_stop / message_stop / ping → nothing to emit
    return infos;
  }

  finalize(): DecodedResponse {
    const content: ContentPart[] = [];
    for (const [, b] of [...this.blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (b.type === "thinking") {
        const part: ContentPart = { type: "thinking", text: b.text };
        if (b.signature) part.signature = b.signature;
        content.push(part);
      } else if (b.type === "tool_use") {
        const part: ToolUsePart = {
          type: "tool_use",
          toolCallId: b.toolId ?? "",
          name: b.toolName ?? "",
        };
        if (b.toolArgs) {
          part.argumentsRaw = b.toolArgs;
          const parsed = tryParseJson(b.toolArgs);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            part.arguments = parsed as JsonObject;
          }
        }
        content.push(part);
      } else if (b.text) {
        content.push({ type: "text", text: b.text });
      }
    }
    const out: DecodedResponse = { messages: [{ role: this.role, choiceIndex: 0, content }] };
    if (this.finishRaw) {
      out.rawFinishReason = this.finishRaw;
      out.finishReason = mapStop(this.finishRaw);
    }
    if (this.usage) out.usage = this.usage;
    return out;
  }

  private block(idx: number): BlockAcc {
    let acc = this.blocks.get(idx);
    if (!acc) {
      acc = { type: "text", text: "", toolArgs: "" };
      this.blocks.set(idx, acc);
    }
    return acc;
  }
}

// -------------------------------------------------------------------- shared ---

function mapStop(r: string): FinishReason {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "refusal";
    default:
      return r;
  }
}

function mapUsage(v: unknown): Usage | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const u = asObject(v);
  const usage: Usage = {};
  setNum(usage, "promptTokens", u.input_tokens);
  setNum(usage, "completionTokens", u.output_tokens);
  setNum(usage, "cacheReadTokens", u.cache_read_input_tokens);
  setNum(usage, "cacheWriteTokens", u.cache_creation_input_tokens);
  if (Object.keys(usage).length === 0) return undefined;
  usage.raw = v;
  if (usage.promptTokens !== undefined && usage.completionTokens !== undefined) {
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
  }
  return usage;
}

function setNum<T extends object>(target: T, key: keyof T & string, v: unknown): void {
  const n = asNumber(v);
  if (n !== undefined) (target as Record<string, unknown>)[key] = n;
}
