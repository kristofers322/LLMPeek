import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cost, Usage } from "@llmpeek/schema";

// Vendored, filtered LiteLLM pricing (per-token USD). Swap pricing.json for a
// fresh LiteLLM export to update. Stamp bumped when the data is refreshed.
const PRICING_VERSION = "litellm-2026-07";

interface Price {
  in?: number;
  out?: number;
  cr?: number; // cache read per token
  cw?: number; // cache write/creation per token
  p?: string; // litellm_provider
}

let table: Record<string, Price> | null = null;
function load(): Record<string, Price> {
  if (table) return table;
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // .../collector/dist
    table = JSON.parse(readFileSync(join(here, "..", "pricing.json"), "utf8"));
  } catch {
    table = {};
  }
  return table ?? {};
}

function lookup(model: string): Price | undefined {
  const t = load();
  return t[model] ?? t[model.replace(/^[^/]+\//, "")] ?? t[model.replace(/-latest$/, "")];
}

/**
 * Compute per-request cost from a model + usage using the vendored pricing.
 * Returns undefined for unknown models (cost stays unset — graceful). Handles the
 * OpenAI convention (prompt_tokens INCLUDES cached tokens, billed at a discount)
 * vs Anthropic (cache tokens counted separately from input_tokens).
 */
export function costFor(model: string, usage: Usage): Cost | undefined {
  const p = lookup(model);
  if (!p) return undefined;

  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const isAnthropic = p.p === "anthropic";

  const inputBillable = isAnthropic ? prompt : Math.max(0, prompt - cacheRead);
  const inputCost = (p.in ?? 0) * inputBillable;
  const outputCost = (p.out ?? 0) * completion;
  const cacheReadCost = (p.cr ?? p.in ?? 0) * cacheRead;
  const cacheWriteCost = (p.cw ?? 0) * cacheWrite;

  const cost: Cost = {
    currency: "USD",
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    inputCost,
    outputCost,
    source: "litellm",
    pricingVersion: PRICING_VERSION,
  };
  if (p.in !== undefined) cost.pricePer1kInput = p.in * 1000;
  if (p.out !== undefined) cost.pricePer1kOutput = p.out * 1000;
  if (cacheRead) cost.cacheReadCost = cacheReadCost;
  if (cacheWrite) cost.cacheWriteCost = cacheWriteCost;
  return cost;
}
