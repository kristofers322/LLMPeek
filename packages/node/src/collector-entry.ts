// The collector process, spawned detached by collector-client.ts. This entry
// exists so the collector (bundled from @llmpeek/collector) ships inside llmpeek's
// own dist and can be launched with `node <llmpeek>/dist/collector-entry.js` —
// no separately-installed @llmpeek/collector package required.
import "@llmpeek/collector/cli";
