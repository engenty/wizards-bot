import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the home runs beside the app (`pnpm dev`); `HOME_PORT` names another one.
const home = `http://127.0.0.1:${process.env.HOME_PORT ?? 4747}`;

export default defineConfig({
  // The home serves the built app at its own root.
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: {
      "/v1": { target: home, changeOrigin: false },
      // The libraries an artifact's page loads from the home.
      "/artifact-lib": { target: home, changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
