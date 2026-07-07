import { SCHEMA_VERSION } from "@llmpeek/schema";

// `llmpeek` — the one published package and the single-import entry point.
// Importing it installs the observe-only HTTP interceptor (Phase 2) and, in dev,
// auto-spawns the local collector (Phase 3).
export const version = "0.0.0";
export const schemaVersion = SCHEMA_VERSION;
