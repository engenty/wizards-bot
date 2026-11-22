import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The app's logic without a browser.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
