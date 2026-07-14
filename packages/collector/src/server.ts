import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION } from "@llmpeek/schema";
import type { LLMPeekEvent } from "@llmpeek/schema";
import { type WebSocket, WebSocketServer } from "ws";
import { COLLECTOR_HOST, getPort } from "./config.js";
import { enrich } from "./enrich.js";
import { EventStore } from "./store.js";

export const COLLECTOR_VERSION = (() => {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

export interface Collector {
  port: number;
  logPath: string;
  close(): Promise<void>;
}

/**
 * Start the local collector: HTTP ingest + health/events, a WebSocket live feed,
 * and NDJSON persistence. Rejects with EADDRINUSE when another instance already
 * owns the port — the single-instance lock IS the port, so the caller attaches
 * to the running collector instead of spawning a duplicate.
 */
export function startCollector(): Promise<Collector> {
  const port = getPort();
  const store = new EventStore();
  const clients = new Set<WebSocket>();

  const broadcast = (event: LLMPeekEvent): void => {
    const frame = JSON.stringify({ type: "event", event });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res, store, broadcast, port);
  });
  const wss = new WebSocketServer({ server, path: "/stream" });
  wss.on("connection", (ws, req) => {
    // A cross-origin page can open a WebSocket without CORS, so gate the live
    // feed on the same Host/Origin check as the HTTP endpoints.
    if (!isTrustedRequest(req.headers, port)) {
      ws.close();
      return;
    }
    clients.add(ws);
    // Catch a new dashboard up on recent history before live events.
    for (const event of store.backlog()) ws.send(JSON.stringify({ type: "event", event }));
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });
  wss.on("error", () => {});

  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, COLLECTOR_HOST, () => {
      server.removeListener("error", onError);
      resolve({
        port,
        logPath: store.logPath,
        close: () =>
          new Promise<void>((r) => {
            wss.close();
            server.close(() => r());
          }),
      });
    });
  });
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The Host header must be exactly one of our loopback authorities. Blocks DNS
 *  rebinding, where a page on evil.com resolves its own name to 127.0.0.1. */
export function isLoopbackAuthority(authority: string | undefined, port: number): boolean {
  if (!authority) return false;
  return (
    authority === `127.0.0.1:${port}` ||
    authority === `localhost:${port}` ||
    authority === `[::1]:${port}`
  );
}

/** An Origin header, when present, must point at one of our loopback origins. */
export function isLoopbackOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return LOOPBACK_HOSTNAMES.has(u.hostname) && u.port === String(port);
  } catch {
    return false;
  }
}

/**
 * Guard the loopback collector against browser-driven attacks. The collector
 * serves captured prompt text, so a page in the user's browser must not be able
 * to read /events or forge /ingest. Host must be our exact loopback authority
 * (blocks DNS rebinding); any Origin present must also be loopback (blocks a
 * cross-origin page). Trusted Node clients send Host: 127.0.0.1 and no Origin.
 */
export function isTrustedRequest(
  headers: { host?: string; origin?: string },
  port: number,
): boolean {
  if (!isLoopbackAuthority(headers.host, port)) return false;
  if (headers.origin !== undefined && !isLoopbackOrigin(headers.origin, port)) return false;
  return true;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: EventStore,
  broadcast: (e: LLMPeekEvent) => void,
  port: number,
): Promise<void> {
  const url = req.url ?? "/";

  if (!isTrustedRequest(req.headers, port)) {
    res.writeHead(403).end();
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method === "GET" && url.startsWith("/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        name: "llmpeek-collector",
        version: COLLECTOR_VERSION,
        schemaVersion: SCHEMA_VERSION,
        pid: process.pid,
        events: store.count(),
      }),
    );
    return;
  }
  if (req.method === "GET" && url.startsWith("/events")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(store.backlog()));
    return;
  }
  if (req.method === "POST" && url.startsWith("/ingest")) {
    try {
      const body = await readBody(req);
      // Accept a single event or an NDJSON batch.
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const event = enrich(JSON.parse(trimmed) as LLMPeekEvent);
        await store.append(event);
        broadcast(event);
      }
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
    return;
  }
  if (req.method === "GET") {
    await serveStatic(url, res);
    return;
  }
  res.writeHead(404).end();
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

let cachedDir: string | null | undefined;
function dashboardDir(): string | null {
  if (cachedDir !== undefined) return cachedDir;
  const candidates: string[] = [];
  // Bundled: the dashboard ships as <llmpeek>/dashboard next to the running file.
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard"));
  } catch {}
  // Dev (monorepo): resolve the workspace @llmpeek/dashboard package's dist.
  try {
    const require = createRequire(import.meta.url);
    candidates.push(join(dirname(require.resolve("@llmpeek/dashboard/package.json")), "dist"));
  } catch {}
  cachedDir = candidates.find((c) => existsSync(join(c, "index.html"))) ?? null;
  return cachedDir;
}

/** Serve the built dashboard (if present) so the whole tool is one localhost
 *  URL. Guards against path traversal outside the dashboard dist directory. */
async function serveStatic(url: string, res: ServerResponse): Promise<void> {
  const dir = dashboardDir();
  if (!dir) {
    res.writeHead(404, { "content-type": "text/plain" }).end("llmpeek dashboard not built");
    return;
  }
  const path = (url.split("?")[0] ?? "/") || "/";
  const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  const full = normalize(join(dir, rel));
  if (full !== dir && !full.startsWith(dir + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(full);
    res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
}

// Cap the ingest body so a forged or runaway POST can't exhaust collector memory.
// Comfortably above any real event batch (raw bodies are already capped upstream).
const MAX_INGEST_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_INGEST_BYTES) {
        req.destroy();
        reject(new Error("ingest body too large"));
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
