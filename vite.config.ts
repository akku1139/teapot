import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  root: "frontend",
  plugins: [solid()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: "../public",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: { proxy: { "/api": "http://localhost:7788" } },
});
