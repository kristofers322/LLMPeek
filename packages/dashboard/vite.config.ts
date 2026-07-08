import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// `base: "./"` emits relative asset paths so the built app works when the
// collector serves it from `/`. The dev-server proxy lets `npm run dev` talk to
// a running collector while iterating on the UI.
export default defineConfig({
  plugins: [svelte()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/stream": { target: "ws://127.0.0.1:4319", ws: true },
      "/events": "http://127.0.0.1:4319",
      "/health": "http://127.0.0.1:4319",
    },
  },
});
