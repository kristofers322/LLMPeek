#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPort } from "@llmpeek/collector";
import { CA_CERT_PATH, ensureCA } from "./ca.js";
import { ensureCollector } from "./collector-client.js";
import { startProxy } from "./proxy.js";

const PROXY_PORT = Number(process.env.LLMPEEK_PROXY_PORT) || 4318;

await ensureCA();
await ensureCollector();
const collectorPort = getPort();
const proxy = await startProxy(await ensureCA(), PROXY_PORT);

const ca = CA_CERT_PATH;
const proxyUrl = `http://127.0.0.1:${proxy.port}`;

// Write a ready-to-source env file so capturing another process is one command
// (`source .llmpeek/env.sh`) instead of pasting a wall of exports.
const envFile = join(process.cwd(), ".llmpeek", "env.sh");
const envBody = `# LLMPeek: capture LLM API calls made from this shell.
# Usage:  source .llmpeek/env.sh    (then run your program in the SAME shell)
export HTTPS_PROXY=${proxyUrl}
export HTTP_PROXY=${proxyUrl}
export SSL_CERT_FILE=${ca}
export REQUESTS_CA_BUNDLE=${ca}
export CURL_CA_BUNDLE=${ca}
export NODE_EXTRA_CA_CERTS=${ca}
export NODE_OPTIONS="--import llmpeek"
`;
try {
  mkdirSync(join(process.cwd(), ".llmpeek"), { recursive: true });
  writeFileSync(envFile, envBody);
} catch {
  // best-effort: fall back to the printed exports below
}

process.stdout.write(`
  LLMPeek is running.

    dashboard   http://127.0.0.1:${collectorPort}/
    proxy       ${proxyUrl}

  ── Capture any program (Python, curl, Go, Ruby, …) ────────────────────────
  In the shell that runs your app:

    source .llmpeek/env.sh
    python your_app.py            # curl / node / go / … all work the same

  ── Already in a Node app? ─────────────────────────────────────────────────
  You don't need the proxy. Add one line, as early as possible:

    import "llmpeek";

  Only known LLM hosts (api.openai.com, api.anthropic.com, …) are decrypted; every
  other site is tunneled through untouched. Extra hosts: LLMPEEK_HOSTS=a.com,b.com
  Ctrl+C to stop.

`);

process.on("SIGINT", () => {
  proxy.close();
  process.exit(0);
});
