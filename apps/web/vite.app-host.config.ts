import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * The host of a connection's view (MCP Apps): one HTML file with its script inline, which the
 * home serves closed off at `/v1/artifacts/:id/host`. Built after the app into
 * `dist/app-host.html`; `emptyOutDir` stays off so the app beside it is kept.
 */
const outDir = fileURLToPath(new URL("./dist", import.meta.url));

export default defineConfig({
  base: "/",
  publicDir: false,
  plugins: [viteSingleFile()],
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: { input: fileURLToPath(new URL("./app-host.html", import.meta.url)) },
  },
});
