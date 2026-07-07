# LLMPeek

Local-first devtools for LLM apps. One `npm install`, one import, and every LLM API
call your app makes — any SDK, any provider — shows up in a live dashboard on
localhost: full prompts, tool calls, streaming as it happens, tokens, latency, cost.
No account, no server to run, no config.

It works by intercepting the **wire** (fetch / `http.request` / XHR), observe-only,
and normalizing the handful of wire formats (OpenAI-compatible, Anthropic, Gemini) —
so it captures every SDK for free instead of hooking each one.

## Monorepo layout

| Package | Name | Role |
| --- | --- | --- |
| `packages/schema` | `@llmpeek/schema` | Canonical normalized event contract (TS types + JSON Schema) |
| `packages/node` | `llmpeek` | The published one-import package (HTTP interceptor) |
| `packages/collector` | `@llmpeek/collector` | Local server: HTTP + WebSocket + NDJSON log |
| `packages/dashboard` | `@llmpeek/dashboard` | Svelte dashboard served on localhost |

At publish time the collector and the built dashboard are bundled into `llmpeek` so
that installing the tool stays a single package.

## Status

Early scaffolding. Development uses npm workspaces; `npm run build` compiles the
TypeScript packages via project references.
