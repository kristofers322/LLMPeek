import type {
  ContentPart,
  EmbeddingResult,
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

export interface DecodedRequest {
  model?: string;
  params: RequestParams;
  messages: NormalizedMessage[];
  input?: string[] | number[][];
}

export interface DecodedResponse {
  messages?: NormalizedMessage[];
  embeddings?: EmbeddingResult[];
  usage?: Usage;
  finishReason?: FinishReason;
  rawFinishReason?: string;
  systemFingerprint?: string;
  serviceTier?: string;
}

// ---------------------------------------------------------------- requests ---

export function decodeChatRequest(bodyUnknown: unknown): DecodedRequest {
  const body = asObject(bodyUnknown);
  const params: RequestParams = {};
  setNum(params, "temperature", body.temperature);
  setNum(params, "maxTokens", body.max_tokens ?? body.max_completion_tokens);
  setNum(params, "topP", body.top_p);
  setNum(params, "presencePenalty", body.presence_penalty);
  setNum(params, "frequencyPenalty", body.frequency_penalty);
  setNum(params, "seed", body.seed);
  setNum(params, "n", body.n);
  setNum(params, "topLogProbs", body.top_logprobs);
  const logprobs = asBoolean(body.logprobs);
  if (logprobs !== undefined) params.logProbs = logprobs;
  const stream = asBoolean(body.stream);
  if (stream !== undefined) params.stream = stream;
  const user = asString(body.user);
  if (user !== undefined) params.user = user;
  if (Array.isArray(body.stop)) {
    params.stop = body.stop.filter((s): s is string => typeof s === "string");
  } else {
    const stop = asString(body.stop);
    if (stop !== undefined) params.stop = [stop];
  }
  const rf = decodeResponseFormat(body.response_format);
  if (rf) params.responseFormat = rf;
  if (Array.isArray(body.tools)) {
    const tools = body.tools
      .map(decodeToolDefinition)
      .filter((t): t is ToolDefinition => t !== undefined);
    if (tools.length) params.tools = tools;
  }
  if (body.tool_choice !== undefined) {
    params.toolChoice =
      typeof body.tool_choice === "string" ? body.tool_choice : asObject(body.tool_choice);
  }
  const effort = asString(body.reasoning_effort);
  if (effort) params.reasoning = { effort };

  return {
    model: asString(body.model),
    params,
    messages: asArray(body.messages).map(decodeRequestMessage),
  };
}

export function decodeEmbeddingRequest(bodyUnknown: unknown): DecodedRequest {
  const body = asObject(bodyUnknown);
  return {
    model: asString(body.model),
    params: {},
    messages: [],
    input: normalizeEmbeddingInput(body.input),
  };
}

function normalizeEmbeddingInput(v: unknown): string[] | number[][] | undefined {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === "string")) return v as string[];
    if (v.every((x) => Array.isArray(x))) return v as number[][];
    if (v.every((x) => typeof x === "number")) return [v as number[]];
  }
  return undefined;
}

function decodeResponseFormat(v: unknown): ResponseFormat | undefined {
  const rf = asObject(v);
  const type = asString(rf.type);
  if (!type) return undefined;
  const out: ResponseFormat = { type };
  const js = asObject(rf.json_schema);
  const name = asString(js.name);
  if (name) out.schemaName = name;
  if (js.schema !== undefined) out.jsonSchema = js.schema;
  return out;
}

function decodeToolDefinition(v: unknown): ToolDefinition | undefined {
  const t = asObject(v);
  const fn = asObject(t.function);
  const name = asString(fn.name) ?? asString(t.name);
  if (!name) return undefined;
  const def: ToolDefinition = { type: asString(t.type) ?? "function", name };
  const description = asString(fn.description) ?? asString(t.description);
  if (description) def.description = description;
  const parameters = fn.parameters ?? t.parameters;
  if (parameters !== undefined) def.parameters = parameters;
  return def;
}

function decodeRequestMessage(v: unknown): NormalizedMessage {
  const m = asObject(v);
  const role = asString(m.role) ?? "user";
  const content: ContentPart[] = [];
  if (role === "tool") {
    const part: ContentPart = { type: "tool_result", toolCallId: asString(m.tool_call_id) ?? "" };
    const text = asString(m.content);
    if (text) part.content = [{ type: "text", text }];
    content.push(part);
  } else {
    const text = asString(m.content);
    if (text) {
      content.push({ type: "text", text });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        const part = decodeRequestContentPart(p);
        if (part) content.push(part);
      }
    }
    for (const tc of asArray(m.tool_calls)) content.push(decodeToolCall(tc));
    const refusal = asString(m.refusal);
    if (refusal) content.push({ type: "refusal", refusal });
  }
  const msg: NormalizedMessage = { role, content };
  const name = asString(m.name);
  if (name) msg.name = name;
  return msg;
}

function decodeRequestContentPart(v: unknown): ContentPart | undefined {
  const p = asObject(v);
  const type = asString(p.type);
  if (type === "text") return { type: "text", text: asString(p.text) ?? "" };
  if (type === "image_url") {
    const img = asObject(p.image_url);
    const part: ContentPart = { type: "image" };
    const url = asString(img.url);
    if (url) part.url = url;
    const detail = asString(img.detail);
    if (detail) part.detail = detail;
    return part;
  }
  if (type === "input_audio") return { type: "audio" };
  return { type: "unknown", raw: v };
}

function decodeToolCall(v: unknown): ToolUsePart {
  const tc = asObject(v);
  const fn = asObject(tc.function);
  const part: ToolUsePart = {
    type: "tool_use",
    toolCallId: asString(tc.id) ?? "",
    name: asString(fn.name) ?? "",
  };
  const argsRaw = asString(fn.arguments);
  if (argsRaw !== undefined) {
    part.argumentsRaw = argsRaw;
    const parsed = tryParseJson(argsRaw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      part.arguments = parsed as JsonObject;
  }
  return part;
}

// ------------------------------------------------- non-streaming responses ---

export function decodeChatResponse(bodyUnknown: unknown): DecodedResponse {
  const body = asObject(bodyUnknown);
  const messages: NormalizedMessage[] = [];
  let finishReason: FinishReason | undefined;
  let rawFinishReason: string | undefined;
  for (const c of asArray(body.choices)) {
    const choice = asObject(c);
    messages.push(decodeResponseMessage(choice.message, asNumber(choice.index)));
    const fr = asString(choice.finish_reason);
    if (fr && rawFinishReason === undefined) {
      rawFinishReason = fr;
      finishReason = mapFinishReason(fr);
    }
  }
  const out: DecodedResponse = { messages };
  if (finishReason) out.finishReason = finishReason;
  if (rawFinishReason) out.rawFinishReason = rawFinishReason;
  const usage = mapUsage(body.usage);
  if (usage) out.usage = usage;
  const sf = asString(body.system_fingerprint);
  if (sf) out.systemFingerprint = sf;
  const st = asString(body.service_tier);
  if (st) out.serviceTier = st;
  return out;
}

function decodeResponseMessage(v: unknown, choiceIndex?: number): NormalizedMessage {
  const m = asObject(v);
  const content: ContentPart[] = [];
  const text = asString(m.content);
  if (text) content.push({ type: "text", text });
  for (const tc of asArray(m.tool_calls)) content.push(decodeToolCall(tc));
  const refusal = asString(m.refusal);
  if (refusal) content.push({ type: "refusal", refusal });
  const msg: NormalizedMessage = { role: asString(m.role) ?? "assistant", content };
  if (choiceIndex !== undefined) msg.choiceIndex = choiceIndex;
  return msg;
}

export function decodeEmbeddingResponse(bodyUnknown: unknown): DecodedResponse {
  const body = asObject(bodyUnknown);
  const embeddings: EmbeddingResult[] = [];
  for (const d of asArray(body.data)) {
    const item = asObject(d);
    embeddings.push({
      index: asNumber(item.index) ?? embeddings.length,
      dimensions: asArray(item.embedding).length,
      vectorOmitted: true,
    });
  }
  const out: DecodedResponse = { embeddings };
  const usage = mapUsage(body.usage);
  if (usage) out.usage = usage;
  return out;
}

// ----------------------------------------------------------------- streaming ---

interface ToolAcc {
  id?: string;
  name?: string;
  args: string;
}
interface ChoiceAcc {
  role?: string;
  text: string;
  refusal?: string;
  tools: Map<number, ToolAcc>;
  finishRaw?: string;
}

export interface StreamDeltaInfo {
  index?: number;
  blockIndex?: number;
  textDelta?: string;
  thinkingDelta?: string;
  refusalDelta?: string;
  roleDelta?: string;
  toolCallDelta?: { index?: number; toolCallId?: string; name?: string; argumentsRaw?: string };
  finishReason?: FinishReason;
  usage?: Usage;
}

/**
 * Folds OpenAI chat streaming chunks into per-chunk deltas (to emit live) and,
 * at the end, the reassembled messages + final usage.
 */
export class OpenAIStreamAggregator {
  private choices = new Map<number, ChoiceAcc>();
  private usage?: Usage;
  private systemFingerprint?: string;
  private serviceTier?: string;

  handleChunk(chunkUnknown: unknown, _eventType?: string): StreamDeltaInfo[] {
    const chunk = asObject(chunkUnknown);
    const sf = asString(chunk.system_fingerprint);
    if (sf) this.systemFingerprint = sf;
    const st = asString(chunk.service_tier);
    if (st) this.serviceTier = st;
    const chunkUsage = mapUsage(chunk.usage);
    if (chunkUsage) this.usage = chunkUsage;

    const infos: StreamDeltaInfo[] = [];
    for (const c of asArray(chunk.choices)) {
      const choice = asObject(c);
      const index = asNumber(choice.index) ?? 0;
      const acc = this.choice(index);
      const delta = asObject(choice.delta);
      const base: StreamDeltaInfo = { index };

      const role = asString(delta.role);
      if (role) {
        acc.role = role;
        base.roleDelta = role;
      }
      const text = asString(delta.content);
      if (text) {
        acc.text += text;
        base.textDelta = text;
      }
      const refusal = asString(delta.refusal);
      if (refusal) {
        acc.refusal = (acc.refusal ?? "") + refusal;
        base.refusalDelta = refusal;
      }
      const fr = asString(choice.finish_reason);
      if (fr) {
        acc.finishRaw = fr;
        base.finishReason = mapFinishReason(fr);
      }
      if (base.roleDelta || base.textDelta || base.refusalDelta || base.finishReason)
        infos.push(base);

      // One delta PER tool-call fragment — never collapse multiple fragments in
      // a single chunk into one delta (each targets a distinct block index).
      for (const t of asArray(delta.tool_calls)) {
        const tc = asObject(t);
        const tIdx = asNumber(tc.index) ?? 0;
        const fn = asObject(tc.function);
        const acct = acc.tools.get(tIdx) ?? { args: "" };
        const id = asString(tc.id);
        if (id) acct.id = id;
        const name = asString(fn.name);
        if (name) acct.name = name;
        const argFrag = asString(fn.arguments);
        if (argFrag) acct.args += argFrag;
        acc.tools.set(tIdx, acct);
        infos.push({
          index,
          blockIndex: tIdx,
          toolCallDelta: {
            index: tIdx,
            ...(id ? { toolCallId: id } : {}),
            ...(name ? { name } : {}),
            ...(argFrag ? { argumentsRaw: argFrag } : {}),
          },
        });
      }
    }

    // usage-only chunk (empty choices) — surface it as a delta carrying usage
    if (infos.length === 0 && chunkUsage) infos.push({ usage: chunkUsage });
    return infos;
  }

  finalize(): DecodedResponse {
    const messages: NormalizedMessage[] = [];
    let finishReason: FinishReason | undefined;
    let rawFinishReason: string | undefined;
    for (const [index, acc] of [...this.choices.entries()].sort((a, b) => a[0] - b[0])) {
      const content: ContentPart[] = [];
      if (acc.text) content.push({ type: "text", text: acc.text });
      for (const [, t] of [...acc.tools.entries()].sort((a, b) => a[0] - b[0])) {
        const part: ToolUsePart = { type: "tool_use", toolCallId: t.id ?? "", name: t.name ?? "" };
        if (t.args) {
          part.argumentsRaw = t.args;
          const parsed = tryParseJson(t.args);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
            part.arguments = parsed as JsonObject;
        }
        content.push(part);
      }
      if (acc.refusal) content.push({ type: "refusal", refusal: acc.refusal });
      messages.push({ role: acc.role ?? "assistant", choiceIndex: index, content });
      if (acc.finishRaw && rawFinishReason === undefined) {
        rawFinishReason = acc.finishRaw;
        finishReason = mapFinishReason(acc.finishRaw);
      }
    }
    const out: DecodedResponse = { messages };
    if (finishReason) out.finishReason = finishReason;
    if (rawFinishReason) out.rawFinishReason = rawFinishReason;
    if (this.usage) out.usage = this.usage;
    if (this.systemFingerprint) out.systemFingerprint = this.systemFingerprint;
    if (this.serviceTier) out.serviceTier = this.serviceTier;
    return out;
  }

  private choice(index: number): ChoiceAcc {
    let acc = this.choices.get(index);
    if (!acc) {
      acc = { text: "", tools: new Map() };
      this.choices.set(index, acc);
    }
    return acc;
  }
}

// -------------------------------------------------------------------- shared ---

function mapUsage(v: unknown): Usage | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const u = asObject(v);
  const usage: Usage = {};
  setNum(usage, "promptTokens", u.prompt_tokens ?? u.input_tokens);
  setNum(usage, "completionTokens", u.completion_tokens ?? u.output_tokens);
  setNum(usage, "totalTokens", u.total_tokens);
  setNum(usage, "cacheReadTokens", asObject(u.prompt_tokens_details).cached_tokens);
  setNum(usage, "reasoningTokens", asObject(u.completion_tokens_details).reasoning_tokens);
  setNum(usage, "audioTokens", asObject(u.completion_tokens_details).audio_tokens);
  if (Object.keys(usage).length === 0) return undefined;
  usage.raw = v;
  return usage;
}

function mapFinishReason(r: string): FinishReason {
  switch (r) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return r; // open union tolerates unknown provider reasons
  }
}

function setNum<T extends object>(target: T, key: keyof T & string, v: unknown): void {
  const n = asNumber(v);
  if (n !== undefined) (target as Record<string, unknown>)[key] = n;
}
