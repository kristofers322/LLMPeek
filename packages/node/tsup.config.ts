import { defineConfig } from "tsup";

// Bundle llmpeek so the published tarball is SELF-CONTAINED: @llmpeek/schema and
// @llmpeek/collector are inlined (noExternal); ws / node-forge / @mswjs
// stay external (declared runtime deps). Three entries: the public import
// surface, the proxy CLI (bin), and the collector process (spawned).
export default defineConfig({
  entry: ["src/index.ts", "src/proxy-cli.ts", "src/collector-entry.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  dts: { entry: "src/index.ts" },
  clean: true,
  splitting: false,
  shims: false,
  noExternal: [/^@llmpeek\//],
});
