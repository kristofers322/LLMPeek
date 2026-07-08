#!/usr/bin/env node
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
process.stdout.write(`
  llmpeek proxy   http://127.0.0.1:${proxy.port}
  dashboard       http://127.0.0.1:${collectorPort}/

  Capture LLM calls from any shell (Python, curl, and other proxy-aware tools) —
  paste this, then run your program in the same shell:

    export HTTPS_PROXY=http://127.0.0.1:${proxy.port}
    export HTTP_PROXY=http://127.0.0.1:${proxy.port}
    export SSL_CERT_FILE=${ca}
    export REQUESTS_CA_BUNDLE=${ca}
    export CURL_CA_BUNDLE=${ca}
    export NODE_EXTRA_CA_CERTS=${ca}
    export NODE_OPTIONS="--import llmpeek"     # Node fetch is captured in-process

  Only known LLM hosts (api.openai.com, api.anthropic.com, …) are decrypted;
  all other HTTPS is tunneled through untouched. Add hosts with LLMPEEK_HOSTS=a,b.
  Ctrl+C to stop.

`);

process.on("SIGINT", () => {
  proxy.close();
  process.exit(0);
});
