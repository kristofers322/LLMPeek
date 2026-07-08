import type { Operation, Provider, SdkKind, WireFormat } from "@llmpeek/schema";

export interface ProviderMatch {
  provider: Provider;
  wireFormat: WireFormat;
  operation: Operation;
}

/**
 * Identify LLM traffic by host + path. Returns null for everything else, so
 * non-LLM requests are ignored entirely. Only POST is considered (generation,
 * embeddings); GETs like /v1/models are skipped.
 */
export function detectProvider(url: URL, method: string): ProviderMatch | null {
  if (method.toUpperCase() !== "POST") return null;
  const host = url.hostname;
  const path = url.pathname;

  if (host === "api.openai.com" || host.endsWith(".openai.azure.com")) {
    const provider: Provider = host === "api.openai.com" ? "openai" : "azure_openai";
    if (path.endsWith("/chat/completions"))
      return { provider, wireFormat: "openai_chat", operation: "chat" };
    if (path.endsWith("/responses"))
      return { provider, wireFormat: "openai_responses", operation: "chat" };
    if (path.endsWith("/embeddings"))
      return { provider, wireFormat: "openai_embeddings", operation: "embedding" };
    if (path.endsWith("/completions"))
      return { provider, wireFormat: "openai_completions", operation: "completion" };
    return null;
  }

  if (host === "api.anthropic.com" && path.endsWith("/messages")) {
    return { provider: "anthropic", wireFormat: "anthropic_messages", operation: "chat" };
  }

  // OpenAI-compatible long tail (Groq, OpenRouter, Together, Ollama, vLLM, …).
  if (path.endsWith("/chat/completions")) {
    return { provider: "openai_compatible", wireFormat: "openai_chat", operation: "chat" };
  }
  if (path.endsWith("/embeddings")) {
    return {
      provider: "openai_compatible",
      wireFormat: "openai_embeddings",
      operation: "embedding",
    };
  }
  return null;
}

/** Best-effort SDK fingerprint from request headers (OpenAI/Anthropic SDKs send
 *  `x-stainless-lang`). Falls back to a raw fetch/httpx classification. */
export function detectSdk(headers: Headers, provider: Provider): SdkKind {
  const lang = headers.get("x-stainless-lang");
  const isAnthropic = provider === "anthropic";
  const isOpenAiish =
    provider === "openai" || provider === "azure_openai" || provider === "openai_compatible";
  if (lang === "js")
    return isAnthropic ? "anthropic_node" : isOpenAiish ? "openai_node" : "raw_fetch";
  if (lang === "python")
    return isAnthropic ? "anthropic_python" : isOpenAiish ? "openai_python" : "raw_httpx";
  return "raw_fetch";
}
