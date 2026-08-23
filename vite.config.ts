import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: "frontend",
  plugins: [solid()],
  build: {
    outDir: "../public",
    emptyOutDir: true,
    // ship source maps with the release bundle — production stack traces and
    // minified crash reports stay debuggable
    sourcemap: true,
  },
  server: { proxy: { "/api": "http://localhost:7788" } },
});
