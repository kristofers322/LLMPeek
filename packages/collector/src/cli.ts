import { startCollector } from "./server.js";

// Spawned as a detached process by the llmpeek interceptor. If another instance
// already owns the port, startCollector rejects (EADDRINUSE) and we exit quietly
// so the caller attaches to the already-running collector.
startCollector()
  .then((c) => {
    process.stdout.write(`llmpeek collector on http://127.0.0.1:${c.port} (log: ${c.logPath})\n`);
  })
  .catch(() => {
    process.exit(0);
  });
