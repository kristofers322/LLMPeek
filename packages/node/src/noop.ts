// Edge/worker-runtime entry (resolved via the "edge-light"/"worker" export
// conditions). Those runtimes have no `node:` builtins, so importing the real
// llmpeek would throw at load. This dependency-free no-op surface lets a stray
// `import 'llmpeek'` in an edge route resolve harmlessly. Actual Node capture
// runs via `instrumentation.ts` register() on the nodejs runtime — see README.

export type Sink = (event: unknown) => void;
export interface LLMPeekOptions {
  enabled?: boolean;
  redact?: "credentials" | "content";
  sink?: Sink;
}

export function install(): void {}
export function uninstall(): void {}
export function configure(_options?: LLMPeekOptions): void {}
export function subscribe(_sink: Sink): () => void {
  return () => {};
}
export function getEvents(): readonly unknown[] {
  return [];
}
export function clearEvents(): void {}
export function ensureCollector(): Promise<void> {
  return Promise.resolve();
}
export function isEnabled(): boolean {
  return false;
}
export function isContentRedaction(): boolean {
  return false;
}
export const sessionId = "";
export const SCHEMA_VERSION = "1.0.0";
export const version = "0.0.0";
