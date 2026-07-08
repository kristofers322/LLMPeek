import type {
  ContentPart,
  LLMPeekEvent,
  NormalizedMessage,
  RawPayload,
  RedactionEntry,
  RedactionInfo,
} from "@llmpeek/schema";

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

// Name looks credential-bearing (substring match, lowercased) — used for headers
// AND url query params so the two paths stay consistent.
const SECRET_NAME =
  /(authorization|auth-token|api[-_]?key|apikey|access[-_]?token|access[-_]?key|refresh[-_]?token|client[-_]?secret|secret|credential|token|password|-auth$|^auth-)/;
// A value that looks like a token/secret.
const SECRET_VALUE = /^(bearer\s+\S|sk-[a-z0-9]|[a-z0-9._-]{40,}$)/i;
// Body/query key names matched EXACTLY (anchored) so bare `key`/`token` catch
// Gemini `?key=` and Azure `authentication.key` without over-matching "monkey".
const SECRET_KEY =
  /^(authorization|api[-_]?key|apikey|access[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret[-_]?key|secret|credential|key|token|password|passwd|x-api-key)$/;

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
    if (SECRET_NAME.test(lower) || SECRET_VALUE.test(value)) {
      out[lower] = "***";
      entries.push(entry(target, `/${lower}`, "auth_header", "masked", value.length));
      return;
    }
    out[lower] = value;
  });
  return { headers: out, entries };
}

/** Mask secret query params (name- or value-shaped) in the URL — same heuristic
 *  as headers/body so a credential in `?apikey=` / `?token=` never leaks. */
export function redactUrl(url: URL): {
  url: string;
  query: Record<string, string>;
  entries: RedactionEntry[];
} {
  const u = new URL(url.href);
  const query: Record<string, string> = {};
  const entries: RedactionEntry[] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (SECRET_KEY.test(k.toLowerCase()) || SECRET_VALUE.test(v)) {
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
 * passes through untouched — only string values under credential-named keys are
 * masked — so the dashboard still shows the prompt while a key placed in the body
 * (Azure "on your data", gateway credentials) is never emitted verbatim.
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
        const secret = typeof v === "string" && SECRET_KEY.test(k.toLowerCase());
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

/** Scrub token-shaped substrings from free text (e.g. a provider error message
 *  that echoes the submitted credential). */
export function scrubText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "***");
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

// -------------------------------------------------------- content redaction ---

const REDACTED = "[content redacted]";

/**
 * Return a copy of an event with all prompt/response CONTENT masked — message
 * text, tool arguments, thinking, refusals, and raw bodies — for `redact:
 * 'content'`. Structure and metadata (roles, token counts, timing, provider,
 * finish reason) are preserved so the dashboard still works, but nothing that
 * could contain user data reaches the collector or the on-disk log.
 */
export function redactContent(event: LLMPeekEvent): LLMPeekEvent {
  const e = JSON.parse(JSON.stringify(event)) as LLMPeekEvent;
  switch (e.type) {
    case "request_started":
      maskMessages(e.request.messages);
      if (e.request.input) e.request.input = [];
      maskRaw(e.request.raw);
      noteRedacted(e.redaction);
      break;
    case "stream_delta":
      if (e.textDelta) e.textDelta = REDACTED;
      if (e.thinkingDelta) e.thinkingDelta = REDACTED;
      if (e.refusalDelta) e.refusalDelta = REDACTED;
      if (e.toolCallDelta && e.toolCallDelta.argumentsRaw !== undefined) {
        e.toolCallDelta.argumentsRaw = REDACTED;
      }
      maskRaw(e.raw);
      break;
    case "response_completed":
      maskMessages(e.messages);
      maskRaw(e.raw);
      noteRedacted(e.redaction);
      break;
    case "error":
      maskMessages(e.partialMessages);
      maskRaw(e.raw);
      noteRedacted(e.redaction);
      break;
  }
  return e;
}

function maskMessages(msgs?: NormalizedMessage[]): void {
  if (msgs) for (const m of msgs) maskParts(m.content);
}

function maskParts(parts?: ContentPart[]): void {
  if (!parts) return;
  for (const p of parts) {
    if (p.type === "text" && p.text) p.text = REDACTED;
    else if (p.type === "refusal") p.refusal = REDACTED;
    else if (p.type === "thinking") {
      if (p.text) p.text = REDACTED;
    } else if (p.type === "tool_use") {
      if (p.argumentsRaw !== undefined) p.argumentsRaw = REDACTED;
      if (p.arguments) p.arguments = {};
    } else if (p.type === "tool_result") {
      maskParts(p.content);
    }
    if (p.raw !== undefined) p.raw = undefined;
  }
}

function maskRaw(raw?: RawPayload): void {
  if (raw && raw.encoding !== "omitted") {
    raw.body = undefined;
    raw.encoding = "omitted";
    raw.omittedReason = "fully_redacted";
  }
}

function noteRedacted(info?: RedactionInfo): void {
  if (!info) return;
  info.redacted = true;
  info.entries.push(entry("messages", "/messages", "message_content", "removed", 0));
}
