import { spawn } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { COLLECTOR_HOST, getPort } from "@llmpeek/collector";
import type { LLMPeekEvent } from "@llmpeek/schema";

const PORT = getPort();
let started = false;
// Only true once we've confirmed OUR collector owns the port — never ship prompt
// data to some unrelated process that happens to listen there.
let collectorOk = false;

/** Resolve true only if OUR collector answers /health (checks the name, not just 200). */
function healthy(timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host: COLLECTOR_HOST, port: PORT, path: "/health", method: "GET", timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(false);
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body).name === "llmpeek-collector");
          } catch {
            resolve(false);
          }
        });
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
 * spawn one DETACHED so it survives app restarts. Idempotent and best-effort — a
 * failure here never affects capture.
 */
export async function ensureCollector(): Promise<void> {
  if (started) return;
  started = true;
  if (await healthy()) {
    collectorOk = true;
    return;
  }
  try {
    const cliPath = fileURLToPath(new URL("./collector-entry.js", import.meta.url));
    spawn(process.execPath, [cliPath], {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
    }).unref();
  } catch {
    return;
  }
  for (let i = 0; i < 40; i++) {
    if (await healthy()) {
      collectorOk = true;
      return;
    }
    await sleep(50);
  }
}

/**
 * Fire-and-forget ship one event to the collector over loopback HTTP. No-ops
 * until OUR collector is confirmed. Uses node:http with a timeout so a wedged
 * collector can't leak sockets, and targets a non-LLM host so it's never captured.
 */
export function ship(event: LLMPeekEvent): void {
  if (!collectorOk) return;
  const payload = JSON.stringify(event);
  const req = request({
    host: COLLECTOR_HOST,
    port: PORT,
    path: "/ingest",
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    timeout: 2000,
  });
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.end(payload);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
