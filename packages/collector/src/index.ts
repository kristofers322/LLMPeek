// The local collector: a small loopback server that receives normalized events,
// appends them to an NDJSON log, and fans them out to the dashboard over a
// WebSocket. Auto-spawned by the llmpeek interceptor; runnable standalone via
// the ./cli entry.
export { COLLECTOR_HOST, DEFAULT_PORT, LOG_DIR, getPort } from "./config.js";
export { COLLECTOR_VERSION, startCollector, type Collector } from "./server.js";
export { EventStore } from "./store.js";
