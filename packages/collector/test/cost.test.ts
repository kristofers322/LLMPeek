import { describe, expect, it } from "vitest";
import { costFor } from "../src/pricing.js";

describe("costFor", () => {
  it("prices a known OpenAI model", () => {
    const c = costFor("gpt-4o-mini", { promptTokens: 1000, completionTokens: 500 });
    expect(c?.source).toBe("litellm");
    expect(c?.inputCost).toBeCloseTo(1.5e-7 * 1000, 12);
    expect(c?.outputCost).toBeCloseTo(6e-7 * 500, 12);
  });

  it("applies the OpenAI cached-token discount", () => {
    const c = costFor("gpt-4o-mini", { promptTokens: 1000, cacheReadTokens: 400 });
    expect(c?.inputCost).toBeCloseTo(1.5e-7 * 600, 12);
    expect(c?.cacheReadCost).toBeCloseTo(7.5e-8 * 400, 12);
  });

  it("returns undefined for an unknown model", () => {
    expect(costFor("totally-made-up-9000", { promptTokens: 10 })).toBeUndefined();
  });
});
