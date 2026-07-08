# LLMPeek

See every LLM API call your app makes. One import — or a local proxy — and every
request to OpenAI, Anthropic, or any OpenAI-compatible provider shows up live in a
dashboard on localhost: full prompts, tool calls, streaming as it happens, token
usage, latency, and cost.

Local-first. No account, no cloud, no config. Your prompts never leave your machine.

## Quick start

Two ways to run it — pick based on what you're observing.

### In a Node app

```bash
npm install --save-dev llmpeek
```

Import it once, as early as possible, before your LLM SDK is initialized:

```js
import "llmpeek";
```

Open http://127.0.0.1:4319. That's the whole setup — the dashboard and its collector
spin up on their own the first time a call is captured.

(Next.js needs the instrumentation hook instead of a bare import — see [Next.js](#nextjs).)

### Any other process — Python, Go, curl, …

Start the proxy; nothing needs to be installed into your app:

```bash
npx llmpeek
```

It prints a block of environment variables to paste into the shell where your program
runs:

```bash
export HTTPS_PROXY=http://127.0.0.1:4318
export HTTP_PROXY=http://127.0.0.1:4318
export SSL_CERT_FILE=<CA path printed by the CLI>
export REQUESTS_CA_BUNDLE=<same>
export CURL_CA_BUNDLE=<same>
export NODE_EXTRA_CA_CERTS=<same>
export NODE_OPTIONS="--import llmpeek"
```

Now anything in that shell that honors proxy env vars — the OpenAI Python SDK,
`requests`, `httpx`, `curl` — is captured. The proxy only decrypts known LLM hosts;
all other HTTPS is tunneled through untouched, and the CA it generates is scoped to
that shell, never added to your system trust store.

## What it captures

Per call: the request (model, params, system + messages, tools), the response (text,
tool calls, refusals, finish reason), streaming deltas as they arrive, token usage
(including cached and reasoning tokens), latency, and estimated cost.

Decoded end-to-end:

- **OpenAI** — chat completions and embeddings, streaming and non-streaming
- **Anthropic** — Messages API, streaming, extended thinking, cache usage
- **OpenAI-compatible** — Groq, OpenRouter, Together, DeepSeek, Perplexity, x.ai,
  Fireworks, Mistral, Azure OpenAI, plus self-hosted Ollama / vLLM — anything speaking
  the OpenAI `/chat/completions` or `/embeddings` shape

Cost comes from a vendored LiteLLM price snapshot; unknown models show no cost rather
than a wrong one. Embedding calls record dimensions and token counts, not the vectors.

Not yet decoded: Google Gemini's native API and Cohere's native API — those calls aren't
captured yet.

## Configuration

Everything works with zero config. To change something, use env vars or the
programmatic API.

| Env var | Default | Purpose |
| --- | --- | --- |
| `LLMPEEK` | on in dev | `1` / `0` to force capture on or off |
| `LLMPEEK_REDACT` | `credentials` | `content` also masks prompts, responses, and tool args |
| `LLMPEEK_PORT` | `4319` | Dashboard + collector port |
| `LLMPEEK_PROXY_PORT` | `4318` | Proxy listen port |
| `LLMPEEK_HOSTS` | — | Comma-separated extra hosts the proxy should intercept |
| `LLMPEEK_LOG_MAX_MB` | `100` | Rotate the event log past this size |

From code, in the in-process Node mode:

```js
import { configure } from "llmpeek";

configure({
  redact: "content",            // mask prompt/response text, keep tokens + cost
  enabled: true,                // force on/off, overriding the dev heuristic
  sink: (event) => { /* … */ }, // also receive every captured event
});
```

<a id="nextjs"></a>

### Next.js

A bare `import "llmpeek"` won't reliably load before your SDK, and must never run in
the Edge runtime. Use the instrumentation hook:

```js
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("llmpeek");
  }
}
```

```js
// next.config.js
module.exports = {
  serverExternalPackages: ["llmpeek"], // Next 15+ (13–14: experimental.serverComponentsExternalPackages)
};
```

## Privacy & safety

LLMPeek is meant to be safe to leave on while you develop:

- **Local only.** The collector binds to `127.0.0.1` and is never exposed off your
  machine. Nothing is uploaded anywhere.
- **Dev only by default.** Capture refuses to start under `NODE_ENV=production`, in CI,
  and on serverless runtimes (Vercel, Lambda, Cloud Run, …) — set `LLMPEEK=1` to override
  any of those. On the Edge runtime it's always off, since Edge lacks the Node built-ins
  it needs.
- **Your data stays put.** Captured events — which include prompt and response text —
  are appended to `./.llmpeek/events.ndjson`. Add `.llmpeek/` to your `.gitignore`. Set
  `LLMPEEK_REDACT=content` to keep only structure, tokens, and cost. API keys are always
  stripped from captured data.

## How it works

LLMPeek watches the wire, not your SDK. In-process it wraps `fetch` / `http.request` /
XHR with an observe-only interceptor that never modifies traffic; as a proxy it MITMs
only known LLM hosts using a locally-generated CA. Either way it normalizes the handful
of provider wire formats into one event schema — so it captures every SDK and language
for free instead of hooking each one.

## Development

An npm-workspaces monorepo:

| Package | Role |
| --- | --- |
| `packages/schema` | Canonical event contract — TS types + JSON Schema |
| `packages/node` | The published `llmpeek` package (interceptor + proxy) |
| `packages/collector` | Local server: HTTP + WebSocket + NDJSON log + cost enrichment |
| `packages/dashboard` | Svelte dashboard, served on localhost |

At publish time the collector and built dashboard are bundled into `llmpeek`, so
installing stays a single package.

```bash
npm install
npm run build   # tsc -b, bundle node, build dashboard
npm run lint    # biome
npm test        # vitest
```

Requires Node >= 18.19.

## License

MIT © 2026 [Kristofers Gulbis](https://github.com/kristofers322), co-authored with
[Mason Salter](https://github.com/masonsalter). See [LICENSE](LICENSE).
