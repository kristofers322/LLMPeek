// Safe accessors for parsing untrusted JSON wire payloads. Observe-only code
// must never throw on an unexpected shape, so every field read is defensive.

export type JsonObject = Record<string, unknown>;

export function asObject(v: unknown): JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : {};
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
