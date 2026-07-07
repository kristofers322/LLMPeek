// The canonical LLMPeek normalized event schema.
//
// This is the language-neutral contract shared by every capture layer (the Node
// interceptor today, the Python httpx shim later) and every consumer (the local
// collector and the dashboard). The concrete event types are produced by the
// schema-design phase and land in ./events.ts; this placeholder keeps the
// package's public surface stable until then.
export const SCHEMA_VERSION = 1;
