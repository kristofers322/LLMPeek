import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { SCHEMA_VERSION } from "@llmpeek/schema";
import type { LLMPeekEvent } from "@llmpeek/schema";
import { type WebSocket, WebSocketServer } from "ws";
import { COLLECTOR_HOST, getPort } from "./config.js";
import { EventStore } from "./store.js";

export const COLLECTOR_VERSION = "0.0.0";

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
    void handle(req, res, store, broadcast);
  });
  const wss = new WebSocketServer({ server, path: "/stream" });
  wss.on("connection", (ws) => {
    clients.add(ws);
    // Catch a new dashboard up on recent history before live events.
    for (const event of store.backlog()) ws.send(JSON.stringify({ type: "event", event }));
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

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

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: EventStore,
  broadcast: (e: LLMPeekEvent) => void,
): Promise<void> {
  res.setHeader("access-control-allow-origin", "*");
  const url = req.url ?? "/";

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
        const event = JSON.parse(trimmed) as LLMPeekEvent;
        await store.append(event);
        broadcast(event);
      }
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
    return;
  }
  res.writeHead(404).end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
