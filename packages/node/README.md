# llmpeek

**Local-first devtools for LLM apps.** One `npm install`, one import (or one proxy),
and every LLM API call your app makes — any SDK, any provider — shows up live in a
dashboard on `localhost`: full prompts, tool calls, streaming as it happens, tokens,
latency, cost. No account, no server to run, no config.

It works by intercepting the **wire** (OpenAI + Anthropic formats), so it captures
every SDK for free instead of hooking each one. Everything stays on `127.0.0.1`;
nothing is ever sent anywhere.

```bash
npm install --save-dev llmpeek
```

## Two ways to capture

### 1. In-process (Node apps) — one import

Add this **once, as early as possible** in your app's entry, before your LLM SDK is
used:

```ts
import "llmpeek";
```

Then run your app and open **http://127.0.0.1:4319/**. That's it — the collector and
dashboard start automatically.

### 2. Proxy (any language / any process) — `npx llmpeek`

To capture LLM calls from Python, `curl`, or anything that honors proxy env vars:

```bash
npx llmpeek
```

It prints an env block to paste into any shell. Everything you launch in that shell
is captured — cross-language. Only known LLM hosts are decrypted (via a local CA);
all other HTTPS is tunneled through untouched.

## Next.js

`import 'llmpeek'` at the top of app code does **not** reliably run before your SDK
in Next.js, and it must never load in the Edge runtime. Use the `instrumentation`
hook, which Next runs before anything else, guarded to the Node.js runtime:

```ts
// instrumentation.ts (project root, or src/)
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("llmpeek");
  }
}
```

And tell Next not to bundle it (it spawns a process and generates certs):

```js
// next.config.js
module.exports = {
  serverExternalPackages: ["llmpeek"], // Next 15+  (13–14: experimental.serverComponentsExternalPackages)
};
```

Edge routes are safe without any extra work — `llmpeek` resolves to a no-op there.
Note that Next's fetch cache may dedupe/skip some fetches, so those won't appear.

## Configuration

Environment variables (read by both modes):

| Variable | Default | Effect |
| --- | --- | --- |
| `LLMPEEK` | _(on in dev)_ | `0`/`1` to force capture off/on |
| `LLMPEEK_REDACT` | `credentials` | `content` also masks all prompt/response content |
| `LLMPEEK_HOSTS` | – | comma-separated extra hosts the **proxy** should intercept |
| `LLMPEEK_PORT` | `4319` | collector + dashboard port |
| `LLMPEEK_PROXY_PORT` | `4318` | proxy port |

Programmatic API (in-process mode):

```ts
import { configure, subscribe } from "llmpeek";

configure({
  redact: "content",        // mask prompts/responses, keep structure + tokens + cost
  sink: (event) => {        // receive every captured event
    /* … */
  },
  enabled: true,            // force on/off, overriding the env heuristic
});
```

## Security & privacy

- **Loopback only.** The collector and proxy bind `127.0.0.1`; nothing leaves the
  machine and there is no telemetry.
- **Secrets are redacted before egress.** API keys, auth headers, cookies, and
  credential-named body/URL fields are stripped before any event reaches the
  collector or the on-disk log. `redact: 'content'` additionally masks all prompt
  and response content.
- **Prompts hit disk.** By default, events (including prompt/response text) are
  appended to `./.llmpeek/events.ndjson`. It's gitignored by the tool's convention,
  but treat it as sensitive — or set `redact: 'content'`.
- **Proxy CA.** The proxy generates a local CA in `.llmpeek/ca/` (private key
  `0600`) used only to intercept known LLM hosts. It is **not** installed into any
  system trust store — tools opt in via the printed env vars, and it decrypts
  nothing else.
- **Capture never runs in production by default.** It refuses to start when
  `NODE_ENV=production`, in CI, on Edge/serverless runtimes, or when `LLMPEEK=0`.

## Supported runtimes

Node.js **≥ 18.19** only. Bun/Deno are untested. Edge/Workers resolve to a no-op.

## License

MIT
