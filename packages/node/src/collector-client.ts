import { spawn } from "node:child_process";
import { request } from "node:http";
import { createRequire } from "node:module";
import { COLLECTOR_HOST, getPort } from "@llmpeek/collector";
import type { LLMPeekEvent } from "@llmpeek/schema";

const PORT = getPort();
let started = false;

function healthy(timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host: COLLECTOR_HOST, port: PORT, path: "/health", method: "GET", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * Ensure a collector is running: attach if one already owns the port, otherwise
 * spawn one DETACHED so it survives app restarts / hot reloads. Idempotent and
 * best-effort — a failure here never affects capture.
 */
export async function ensureCollector(): Promise<void> {
  if (started) return;
  started = true;
  if (await healthy()) return;
  try {
    const require = createRequire(import.meta.url);
    const cliPath = require.resolve("@llmpeek/collector/cli");
    spawn(process.execPath, [cliPath], {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
    }).unref();
  } catch {
    return;
  }
  for (let i = 0; i < 40; i++) {
    if (await healthy()) return;
    await sleep(50);
  }
}

/**
 * Fire-and-forget ship one event to the collector over loopback HTTP. Uses
 * node:http (not fetch) and targets a non-LLM host, so it is never captured or
 * able to break the host app.
 */
export function ship(event: LLMPeekEvent): void {
  const payload = JSON.stringify(event);
  const req = request({
    host: COLLECTOR_HOST,
    port: PORT,
    path: "/ingest",
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
  });
  req.on("error", () => {});
  req.end(payload);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
