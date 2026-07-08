import { copyFile, cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Copy the runtime assets the (bundled) collector needs at load time into the
// llmpeek package so they ship in the tarball: the built Svelte dashboard and the
// vendored pricing table. Resolved as `<install>/dashboard` and
// `<install>/pricing.json` (see server.ts dashboardDir + pricing.ts).
const dashSrc = fileURLToPath(new URL("../../dashboard/dist", import.meta.url));
const dashDest = fileURLToPath(new URL("../dashboard", import.meta.url));
await rm(dashDest, { recursive: true, force: true });
await cp(dashSrc, dashDest, { recursive: true });

const priceSrc = fileURLToPath(new URL("../../collector/pricing.json", import.meta.url));
const priceDest = fileURLToPath(new URL("../pricing.json", import.meta.url));
await copyFile(priceSrc, priceDest);

console.log("copied dashboard + pricing.json into llmpeek");
