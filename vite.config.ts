import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: "frontend",
  plugins: [solid()],
  build: { outDir: "../public", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:7788" } },
});
