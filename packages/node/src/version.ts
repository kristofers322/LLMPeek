import { createRequire } from "node:module";

// Single source of truth for the version stamped on every event and printed by
// the CLI: read from the package's own package.json at runtime. Works both in
// dev (dist/ sits next to package.json) and bundled (dist/ under the install root).
function read(): string {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

export const VERSION = read();
