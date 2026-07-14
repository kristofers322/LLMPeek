import type { ProviderMatch } from "../providers.js";
import {
  AnthropicStreamAggregator,
  decodeMessagesRequest,
  decodeMessagesResponse,
} from "./anthropic.js";
import {
  type DecodedRequest,
  type DecodedResponse,
  OpenAIStreamAggregator,
  type StreamDeltaInfo,
  decodeChatRequest,
  decodeChatResponse,
  decodeEmbeddingRequest,
  decodeEmbeddingResponse,
} from "./openai.js";
import {
  ResponsesStreamAggregator,
  decodeResponsesRequest,
  decodeResponsesResponse,
} from "./responses.js";

/** Provider-agnostic streaming aggregator: feed decoded frames (with the SSE
 *  `event` name for event-typed streams like Anthropic), then finalize. */
export interface StreamAggregator {
  handleChunk(json: unknown, eventType?: string): StreamDeltaInfo[];
  finalize(): DecodedResponse;
}

/** Normalize a request body by wire format. */
export function decodeRequest(match: ProviderMatch, body: unknown): DecodedRequest {
  if (match.wireFormat === "anthropic_messages") return decodeMessagesRequest(body);
  if (match.wireFormat === "openai_responses") return decodeResponsesRequest(body);
  if (match.operation === "embedding") return decodeEmbeddingRequest(body);
  return decodeChatRequest(body);
}

/** Normalize a non-streaming response body by wire format. */
export function decodeResponse(match: ProviderMatch, body: unknown): DecodedResponse {
  if (match.wireFormat === "anthropic_messages") return decodeMessagesResponse(body);
  if (match.wireFormat === "openai_responses") return decodeResponsesResponse(body);
  if (match.operation === "embedding") return decodeEmbeddingResponse(body);
  return decodeChatResponse(body);
}

/** The streaming aggregator for a wire format. */
export function createStreamAggregator(match: ProviderMatch): StreamAggregator {
  if (match.wireFormat === "anthropic_messages") return new AnthropicStreamAggregator();
  if (match.wireFormat === "openai_responses") return new ResponsesStreamAggregator();
  return new OpenAIStreamAggregator();
}
