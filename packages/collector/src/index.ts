import { SCHEMA_VERSION } from "@llmpeek/schema";

// The local collector: a small server that receives normalized events over the
// wire, appends them to an NDJSON log, and fans them out to the dashboard over
// WebSocket. Implemented in Phase 3.
export const collectorSchemaVersion = SCHEMA_VERSION;
