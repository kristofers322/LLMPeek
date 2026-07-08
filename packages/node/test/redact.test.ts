import { describe, expect, it } from "vitest";
import { redactBody, redactContent, redactHeaders, redactUrl, scrubText } from "../src/redact.js";

describe("redactHeaders", () => {
  it("strips denylisted secrets, masks by name/value-shape, keeps benign", () => {
    const h = new Headers();
    h.set("authorization", "Bearer sk-abc");
    h.set("helicone-auth", "Bearer sk-xyz");
    h.set("content-type", "application/json");
    const { headers, entries } = redactHeaders(h, "request_headers");
    expect(headers.authorization).toBeUndefined();
    expect(headers["helicone-auth"]).toBe("***");
    expect(headers["content-type"]).toBe("application/json");
    expect(entries).toHaveLength(2);
  });
});

describe("redactBody", () => {
  it("masks credential-named keys (incl. Azure authentication.key), keeps prompt", () => {
    const { body } = redactBody(
      {
        api_key: "sk-x",
        messages: [{ role: "user", content: "hi" }],
        data_sources: [{ parameters: { authentication: { key: "AZKEY" } } }],
      },
      "request_body",
    );
    expect(body.api_key).toBe("***");
    expect(body.messages[0].content).toBe("hi");
    expect(body.data_sources[0].parameters.authentication.key).toBe("***");
  });
});

describe("redactUrl", () => {
  it("masks secret query params (Gemini ?key=), keeps others", () => {
    const { url, query } = redactUrl(new URL("https://x.com/v1?key=SEKRET&model=g"));
    expect(query.key).toBe("***");
    expect(query.model).toBe("g");
    expect(url).not.toContain("SEKRET");
  });
});

describe("scrubText", () => {
  it("masks token-shaped substrings", () => {
    expect(scrubText("bad key sk-abcdefghijklmnop")).toContain("sk-***");
    expect(scrubText("auth Bearer abc.def-ghi")).toContain("Bearer ***");
  });
});

describe("redactContent", () => {
  it("masks message content + raw body, preserves structure", () => {
    const ev = {
      type: "request_started",
      schemaVersion: "1.0.0",
      requestId: "r",
      seq: 0,
      timestamp: 1,
      sessionId: "s",
      source: { language: "node", sdk: "raw_fetch", transport: "fetch" },
      request: {
        provider: "openai",
        wireFormat: "openai_chat",
        host: "h",
        path: "/p",
        method: "POST",
        params: {},
        raw: { format: "openai_chat", encoding: "json", body: { x: 1 } },
        messages: [{ role: "user", content: [{ type: "text", text: "SECRET PROMPT" }] }],
      },
      redaction: { redacted: false, entries: [] },
      timing: { startedAt: 1 },
    };
    const r = redactContent(ev);
    expect(JSON.stringify(r)).not.toContain("SECRET PROMPT");
    expect(r.request.messages[0].content[0].text).toBe("[content redacted]");
    expect(r.request.raw.encoding).toBe("omitted");
    expect(r.request.provider).toBe("openai");
    expect(r.redaction.redacted).toBe(true);
  });
});
