import { describe, expect, it } from "vitest";
import { detectProvider, isLlmHost } from "../src/providers.js";

describe("detectProvider", () => {
  it("detects OpenAI chat + embeddings", () => {
    expect(
      detectProvider(new URL("https://api.openai.com/v1/chat/completions"), "POST")?.wireFormat,
    ).toBe("openai_chat");
    expect(detectProvider(new URL("https://api.openai.com/v1/embeddings"), "POST")?.operation).toBe(
      "embedding",
    );
  });
  it("detects Anthropic messages", () => {
    expect(
      detectProvider(new URL("https://api.anthropic.com/v1/messages"), "POST")?.wireFormat,
    ).toBe("anthropic_messages");
  });
  it("matches OpenAI-compatible gateways by path", () => {
    expect(
      detectProvider(new URL("https://gw.internal/v1/chat/completions"), "POST")?.provider,
    ).toBe("openai_compatible");
  });
  it("ignores GET and non-LLM paths", () => {
    expect(detectProvider(new URL("https://api.openai.com/v1/models"), "GET")).toBeNull();
    expect(detectProvider(new URL("https://example.com/"), "POST")).toBeNull();
  });
});

describe("isLlmHost", () => {
  it("matches known hosts + azure wildcard, rejects others", () => {
    expect(isLlmHost("api.openai.com")).toBe(true);
    expect(isLlmHost("my.openai.azure.com")).toBe(true);
    expect(isLlmHost("example.com")).toBe(false);
  });
});
