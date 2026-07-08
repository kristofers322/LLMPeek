// The canonical LLMPeek normalized event schema — the language-neutral contract
// shared by every capture layer (the Node interceptor, the future Python httpx
// shim) and every consumer (the local collector, the dashboard). The concrete
// event types live in ./events.ts and mirror ./events.schema.json.
export * from "./events.js";
