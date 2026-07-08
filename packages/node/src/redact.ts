import type { RedactionEntry } from "@llmpeek/schema";

// Secrets stripped BEFORE any event leaves the process (redaction-at-the-boundary).
// Because provider detection wildcard-matches any `/chat/completions` host, the
// denylist alone cannot be complete — redaction also falls through to name- and
// value-shape heuristics so gateway/proxy auth headers (Helicone-Auth,
// cf-aig-authorization, x-auth-token, …) do not leak.
const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
]);

// Header NAME looks credential-bearing (substring match, lowercased).
const SECRET_HEADER_NAME =
  /(authorization|auth-token|api[-_]?key|access[-_]?token|secret|credential|-auth$|^auth-)/;
// Header/body VALUE looks like a token/secret.
const SECRET_VALUE = /^(bearer\s+\S|sk-[a-z0-9]|[a-z0-9._-]{40,}$)/i;

const SECRET_QUERY = new Set(["api_key", "api-key", "key", "access_token"]);

// Body keys whose STRING value is a credential. Matched exactly (anchored), so
// prompt fields like "max_tokens" or nested JSON-schema property names are not
// touched; message content lives under "content", never these keys. Values that
// are objects/arrays (e.g. a JSON-schema property literally named "key") recurse
// normally — only string leaves under these names are masked.
const SECRET_BODY_KEY =
  /^(api[_-]?key|apikey|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|aws[_-]?secret[_-]?access[_-]?key|authorization|x-api-key|key|token|secret|password|passwd|credential)$/;

/** Copy headers minus any secret ones; record what was stripped/masked. */
export function redactHeaders(
  headers: Headers,
  target: "request_headers" | "response_headers",
): { headers: Record<string, string>; entries: RedactionEntry[] } {
  const out: Record<string, string> = {};
  const entries: RedactionEntry[] = [];
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    const isCookie = lower === "cookie" || lower === "set-cookie";
    if (SECRET_HEADERS.has(lower)) {
      entries.push(
        entry(target, `/${lower}`, isCookie ? "cookie" : "auth_header", "removed", value.length),
      );
      return;
    }
    if (SECRET_HEADER_NAME.test(lower) || SECRET_VALUE.test(value)) {
      out[lower] = "***";
      entries.push(entry(target, `/${lower}`, "auth_header", "masked", value.length));
      return;
    }
    out[lower] = value;
  });
  return { headers: out, entries };
}

/** Mask secret query params (e.g. Gemini `?key=`) in the URL. */
export function redactUrl(url: URL): {
  url: string;
  query: Record<string, string>;
  entries: RedactionEntry[];
} {
  const u = new URL(url.href);
  const query: Record<string, string> = {};
  const entries: RedactionEntry[] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (SECRET_QUERY.has(k.toLowerCase())) {
      u.searchParams.set(k, "***");
      query[k] = "***";
      entries.push(entry("url", `/${k}`, "api_key", "masked", v.length));
    } else {
      query[k] = v;
    }
  }
  return { url: u.href, query, entries };
}

/**
 * Deep-copy a parsed JSON body with secret-bearing values masked. Prompt content
 * (message text, tool args) passes through untouched — only values under
 * credential-named keys are masked — so the dashboard still shows the prompt
 * while a key placed in the body (Azure "on your data", gateway credentials) is
 * never emitted verbatim.
 */
export function redactBody(
  value: unknown,
  target: "request_body" | "response_body",
): { body: unknown; entries: RedactionEntry[] } {
  const entries: RedactionEntry[] = [];
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path}/${i}`));
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const kl = k.toLowerCase();
        const secret = typeof v === "string" && SECRET_BODY_KEY.test(kl);
        const ptr = `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        if (secret) {
          out[k] = "***";
          entries.push(entry(target, ptr, "api_key", "masked", (v as string).length));
        } else {
          out[k] = walk(v, ptr);
        }
      }
      return out;
    }
    return node;
  };
  return { body: walk(value, ""), entries };
}

function entry(
  target: RedactionEntry["target"],
  path: string,
  category: RedactionEntry["category"],
  strategy: RedactionEntry["strategy"],
  originalLength: number,
): RedactionEntry {
  return { target, path, category, strategy, originalType: "string", originalLength };
}
