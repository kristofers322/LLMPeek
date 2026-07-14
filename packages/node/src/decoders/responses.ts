import type {
  ContentPart,
  FinishReason,
  NormalizedMessage,
  RequestParams,
  ResponseFormat,
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

// The OpenAI Responses API (POST /v1/responses) is a distinct wire format from
// Chat Completions: `input` items instead of `messages`, an `output` array
// instead of `choices`, renamed usage fields, and an event-typed SSE stream with
// its own `response.*` event names. This decoder normalizes it into the same
// shapes as the other providers so the dashboard renders it uniformly.

// ------------------------------------------------------------------ request ---

export function decodeResponsesRequest(bodyUnknown: unknown): DecodedRequest {
  const body = asObject(bodyUnknown);
  const params: RequestParams = {};
  setNum(params, "maxTokens", body.max_output_tokens);
  setNum(params, "temperature", body.temperature);
  setNum(params, "topP", body.top_p);
  setNum(params, "topLogProbs", body.top_logprobs);
  const stream = asBoolean(body.stream);
  if (stream !== undefined) params.stream = stream;
  const user = asString(body.user) ?? asString(body.safety_identifier);
  if (user) params.user = user;
  const effort = asString(asObject(body.reasoning).effort);
  if (effort) params.reasoning = { effort };
  const rf = decodeResponsesFormat(body.text);
  if (rf) params.responseFormat = rf;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.map(decodeTool).filter((t): t is ToolDefinition => t !== undefined);
    if (tools.length) params.tools = tools;
  }
  if (body.tool_choice !== undefined) {
    params.toolChoice =
      typeof body.tool_choice === "string" ? body.tool_choice : asObject(body.tool_choice);
  }

  const messages: NormalizedMessage[] = [];
  // `instructions` is a separate top-level field (the Responses analogue of a
  // system message); lift it into a synthetic system message like Anthropic's.
  const instructions = asString(body.instructions);
  if (instructions) {
    messages.push({
      role: "system",
      content: [{ type: "text", text: instructions }],
      syntheticSystem: true,
    });
  }
  if (typeof body.input === "string") {
    if (body.input) messages.push({ role: "user", content: [{ type: "text", text: body.input }] });
  } else {
    for (const item of asArray(body.input)) {
      const m = decodeInputItem(item);
      if (m) messages.push(m);
    }
  }

  return { model: asString(body.model), params, messages };
}

/** Responses flattens structured-output config to `text.format.{type,name,schema}`
 *  (Chat Completions nests it under `response_format.json_schema`). */
function decodeResponsesFormat(v: unknown): ResponseFormat | undefined {
  const fmt = asObject(asObject(v).format);
  const type = asString(fmt.type);
  if (!type) return undefined;
  const out: ResponseFormat = { type };
  const name = asString(fmt.name);
  if (name) out.schemaName = name;
  if (fmt.schema !== undefined) out.jsonSchema = fmt.schema;
  return out;
}

/** Function tools use a FLAT shape here ({type,name,parameters}) vs Chat
 *  Completions' nested `function` object. Hosted tools carry only a `type`. */
function decodeTool(v: unknown): ToolDefinition | undefined {
  const t = asObject(v);
  const type = asString(t.type) ?? "function";
  const name = asString(t.name);
  if (type === "function") {
    if (!name) return undefined;
    const def: ToolDefinition = { type: "function", name };
    const description = asString(t.description);
    if (description) def.description = description;
    if (t.parameters !== undefined) def.parameters = t.parameters;
    return def;
  }
  // Built-in/hosted tool (web_search_preview, file_search, code_interpreter, …):
  // name it by its type so it's visible in the dashboard.
  return { type, name: name ?? type };
}

function decodeInputItem(v: unknown): NormalizedMessage | undefined {
  const item = asObject(v);
  const type = asString(item.type);

  // Message: explicit {type:"message",role,content} or shorthand {role,content}.
  if (type === "message" || (!type && asString(item.role))) return decodeInputMessage(item);

  if (type === "function_call") {
    return { role: "assistant", content: [toolUseFrom(item)] };
  }
  if (type === "function_call_output") {
    const part: ContentPart = { type: "tool_result", toolCallId: asString(item.call_id) ?? "" };
    const output = asString(item.output);
    if (output) part.content = [{ type: "text", text: output }];
    return { role: "tool", content: [part] };
  }
  if (type === "reasoning") {
    const parts = decodeReasoning(item);
    return { role: "assistant", content: parts };
  }
  return { role: "user", content: [{ type: "unknown", raw: v }] };
}

function decodeInputMessage(item: JsonObject): NormalizedMessage {
  const role = asString(item.role) ?? "user";
  const content: ContentPart[] = [];
  if (typeof item.content === "string") {
    if (item.content) content.push({ type: "text", text: item.content });
  } else {
    for (const p of asArray(item.content)) {
      const part = decodeInputContentPart(p);
      if (part) content.push(part);
    }
  }
  return { role, content };
}

function decodeInputContentPart(v: unknown): ContentPart | undefined {
  const p = asObject(v);
  const type = asString(p.type);
  if (type === "input_text" || type === "output_text" || type === "text") {
    return { type: "text", text: asString(p.text) ?? "" };
  }
  if (type === "input_image") {
    const part: ContentPart = { type: "image" };
    // Responses sends image_url as a bare string (Chat Completions uses an object).
    const url = asString(p.image_url);
    if (url) part.url = url;
    const detail = asString(p.detail);
    if (detail) part.detail = detail;
    return part;
  }
  if (type === "input_file") {
    const part: ContentPart = { type: "file" };
    const filename = asString(p.filename);
    if (filename) part.filename = filename;
    const url = asString(p.file_url);
    if (url) part.url = url;
    return part;
  }
  if (type === "refusal") return { type: "refusal", refusal: asString(p.refusal) ?? "" };
  return { type: "unknown", raw: v };
}

// ----------------------------------------------------- non-streaming response ---

export function decodeResponsesResponse(bodyUnknown: unknown): DecodedResponse {
  const body = asObject(bodyUnknown);
  const content: ContentPart[] = [];
  for (const it of asArray(body.output)) {
    for (const part of decodeOutputItem(it)) content.push(part);
  }
  const out: DecodedResponse = {
    messages: [{ role: "assistant", choiceIndex: 0, content }],
  };
  const fr = deriveFinish(
    asString(body.status),
    asString(asObject(body.incomplete_details).reason),
    asString(asObject(body.error).code),
    content.some((p) => p.type === "tool_use"),
    content.some((p) => p.type === "refusal"),
  );
  if (fr.finishReason) out.finishReason = fr.finishReason;
  if (fr.rawFinishReason) out.rawFinishReason = fr.rawFinishReason;
  const usage = mapUsage(body.usage);
  if (usage) out.usage = usage;
  const st = asString(body.service_tier);
  if (st) out.serviceTier = st;
  return out;
}

function decodeOutputItem(v: unknown): ContentPart[] {
  const item = asObject(v);
  const type = asString(item.type);
  if (type === "message") {
    const parts: ContentPart[] = [];
    for (const c of asArray(item.content)) {
      const cp = asObject(c);
      const ct = asString(cp.type);
      if (ct === "output_text" || ct === "text")
        parts.push({ type: "text", text: asString(cp.text) ?? "" });
      else if (ct === "refusal")
        parts.push({ type: "refusal", refusal: asString(cp.refusal) ?? "" });
      else parts.push({ type: "unknown", raw: c });
    }
    return parts;
  }
  if (type === "function_call") return [toolUseFrom(item)];
  if (type === "reasoning") return decodeReasoning(item);
  // Built-in tool calls (web_search_call, file_search_call, …): surface as a
  // tool_use named by the call type so the activity is visible.
  if (type?.endsWith("_call")) {
    return [{ type: "tool_use", toolCallId: asString(item.id) ?? "", name: type }];
  }
  return [{ type: "unknown", raw: v }];
}

function decodeReasoning(item: JsonObject): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const s of asArray(item.summary)) {
    const text = asString(asObject(s).text);
    if (text) parts.push({ type: "thinking", text });
  }
  // Reasoning present but withheld by the provider (encrypted for stateless chaining).
  if (!parts.length && asString(item.encrypted_content)) {
    parts.push({ type: "thinking", redactedThinking: true });
  }
  return parts;
}

// ----------------------------------------------------------------- streaming ---

interface OutputItemAcc {
  type: string;
  text: string;
  refusal: string;
  reasoning: string;
  toolId?: string;
  toolName?: string;
  toolArgs: string;
}

/**
 * Folds the Responses API's event-typed SSE stream. Every event has a `type`
 * (matching the SSE event name); the incremental text/arguments are always in a
 * field literally named `delta`. All events carry `output_index`, so items are
 * keyed by that. Final usage arrives only on `response.completed`.
 */
export class ResponsesStreamAggregator {
  private items = new Map<number, OutputItemAcc>();
  private usage?: Usage;
  private status?: string;
  private incompleteReason?: string;
  private errorCode?: string;

  handleChunk(json: unknown, eventType?: string): StreamDeltaInfo[] {
    const ev = asObject(json);
    const type = asString(ev.type) ?? eventType ?? "";
    const idx = asNumber(ev.output_index) ?? 0;
    const infos: StreamDeltaInfo[] = [];

    switch (type) {
      case "response.output_item.added":
      case "response.output_item.done": {
        const item = asObject(ev.item);
        const acc = this.item(idx);
        const itype = asString(item.type);
        if (itype) acc.type = itype;
        if (itype === "function_call") {
          const id = asString(item.call_id) ?? asString(item.id);
          const name = asString(item.name);
          if (id) acc.toolId = id;
          if (name) acc.toolName = name;
          // A finalized item may carry the full arguments even if no delta arrived.
          const args = asString(item.arguments);
          if (type === "response.output_item.done" && args && !acc.toolArgs) acc.toolArgs = args;
          if (type === "response.output_item.added") {
            infos.push({
              index: 0,
              blockIndex: idx,
              toolCallDelta: {
                ...(id ? { toolCallId: id } : {}),
                ...(name ? { name } : {}),
              },
            });
          }
        }
        return infos;
      }
      case "response.output_text.delta": {
        const d = asString(ev.delta) ?? "";
        this.item(idx).text += d;
        if (d) infos.push({ index: 0, blockIndex: idx, textDelta: d });
        return infos;
      }
      case "response.refusal.delta": {
        const d = asString(ev.delta) ?? "";
        this.item(idx).refusal += d;
        if (d) infos.push({ index: 0, blockIndex: idx, refusalDelta: d });
        return infos;
      }
      case "response.function_call_arguments.delta": {
        const d = asString(ev.delta) ?? "";
        this.item(idx).toolArgs += d;
        if (d) infos.push({ index: 0, blockIndex: idx, toolCallDelta: { argumentsRaw: d } });
        return infos;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const d = asString(ev.delta) ?? "";
        this.item(idx).reasoning += d;
        if (d) infos.push({ index: 0, blockIndex: idx, thinkingDelta: d });
        return infos;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const resp = asObject(ev.response);
        this.status = asString(resp.status) ?? type.slice("response.".length);
        this.incompleteReason = asString(asObject(resp.incomplete_details).reason);
        this.errorCode = asString(asObject(resp.error).code);
        const u = mapUsage(resp.usage);
        if (u) {
          this.usage = u;
          infos.push({ usage: u });
        }
        const fr = deriveFinish(
          this.status,
          this.incompleteReason,
          this.errorCode,
          this.hasToolCall(),
          this.hasRefusal(),
        );
        if (fr.finishReason) infos.push({ finishReason: fr.finishReason });
        return infos;
      }
      case "error": {
        // Bare in-stream error frame (distinct from response.failed).
        this.status = "failed";
        this.errorCode = asString(ev.code);
        return infos;
      }
      default:
        return infos;
    }
  }

  finalize(): DecodedResponse {
    const content: ContentPart[] = [];
    for (const idx of [...this.items.keys()].sort((a, b) => a - b)) {
      const acc = this.items.get(idx);
      if (!acc) continue;
      if (acc.type === "reasoning") {
        if (acc.reasoning) content.push({ type: "thinking", text: acc.reasoning });
      } else if (acc.type === "function_call") {
        const part: ToolUsePart = {
          type: "tool_use",
          toolCallId: acc.toolId ?? "",
          name: acc.toolName ?? "",
        };
        if (acc.toolArgs) {
          part.argumentsRaw = acc.toolArgs;
          const parsed = tryParseJson(acc.toolArgs);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            part.arguments = parsed as JsonObject;
          }
        }
        content.push(part);
      } else {
        if (acc.text) content.push({ type: "text", text: acc.text });
        if (acc.refusal) content.push({ type: "refusal", refusal: acc.refusal });
      }
    }
    const out: DecodedResponse = { messages: [{ role: "assistant", choiceIndex: 0, content }] };
    const fr = deriveFinish(
      this.status,
      this.incompleteReason,
      this.errorCode,
      this.hasToolCall(),
      this.hasRefusal(),
    );
    if (fr.finishReason) out.finishReason = fr.finishReason;
    if (fr.rawFinishReason) out.rawFinishReason = fr.rawFinishReason;
    if (this.usage) out.usage = this.usage;
    return out;
  }

  private item(idx: number): OutputItemAcc {
    let acc = this.items.get(idx);
    if (!acc) {
      acc = { type: "message", text: "", refusal: "", reasoning: "", toolArgs: "" };
      this.items.set(idx, acc);
    }
    return acc;
  }

  private hasToolCall(): boolean {
    for (const acc of this.items.values()) if (acc.type === "function_call") return true;
    return false;
  }

  private hasRefusal(): boolean {
    for (const acc of this.items.values()) if (acc.refusal) return true;
    return false;
  }
}

// -------------------------------------------------------------------- shared ---

function toolUseFrom(item: JsonObject): ToolUsePart {
  const part: ToolUsePart = {
    type: "tool_use",
    toolCallId: asString(item.call_id) ?? asString(item.id) ?? "",
    name: asString(item.name) ?? "",
  };
  const argsRaw = asString(item.arguments);
  if (argsRaw !== undefined) {
    part.argumentsRaw = argsRaw;
    const parsed = tryParseJson(argsRaw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      part.arguments = parsed as JsonObject;
    }
  }
  return part;
}

/** Responses has no per-item finish_reason; derive one from `status` +
 *  `incomplete_details.reason` and the presence of tool calls / refusals. */
function deriveFinish(
  status: string | undefined,
  incompleteReason: string | undefined,
  errorCode: string | undefined,
  hasToolCall: boolean,
  hasRefusal: boolean,
): { finishReason?: FinishReason; rawFinishReason?: string } {
  if (status === "incomplete") {
    if (incompleteReason === "max_output_tokens")
      return { finishReason: "length", rawFinishReason: incompleteReason };
    if (incompleteReason === "content_filter")
      return { finishReason: "content_filter", rawFinishReason: incompleteReason };
    return {
      finishReason: incompleteReason ?? "incomplete",
      rawFinishReason: incompleteReason ?? status,
    };
  }
  if (status === "failed") return { finishReason: "error", rawFinishReason: errorCode ?? "failed" };
  if (hasToolCall) return { finishReason: "tool_calls", rawFinishReason: status ?? "completed" };
  if (hasRefusal) return { finishReason: "refusal", rawFinishReason: status ?? "completed" };
  if (status) return { finishReason: "stop", rawFinishReason: status };
  return {};
}

function mapUsage(v: unknown): Usage | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const u = asObject(v);
  const usage: Usage = {};
  setNum(usage, "promptTokens", u.input_tokens);
  setNum(usage, "completionTokens", u.output_tokens);
  setNum(usage, "totalTokens", u.total_tokens);
  setNum(usage, "cacheReadTokens", asObject(u.input_tokens_details).cached_tokens);
  setNum(usage, "reasoningTokens", asObject(u.output_tokens_details).reasoning_tokens);
  if (Object.keys(usage).length === 0) return undefined;
  usage.raw = v;
  return usage;
}

function setNum<T extends object>(target: T, key: keyof T & string, v: unknown): void {
  const n = asNumber(v);
  if (n !== undefined) (target as Record<string, unknown>)[key] = n;
}
