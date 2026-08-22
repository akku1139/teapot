#!/usr/bin/env node
/**
 * teapot master entry point.
 * Usage: teapot [config.json]
 * Config may also come from TEAPOT_* env vars (see src/master.ts).
 */
import path from "node:path";
import { loadConfig, resolveConfigPath, Master } from "./master.js";
import { buildApp, serveApp } from "./server/api.js";

async function main(): Promise<void> {
  const configPath = resolveConfigPath(process.argv[2]);
  const config = loadConfig(configPath);
  console.log(`[teapot] config: ${configPath}`);
  const hasProviders = Object.keys(config.providers ?? {}).length > 0;
  if (!config.llm.apiKey && !hasProviders) console.warn("[teapot] warning: no API key configured");
  if (!config.llm.model && !hasProviders) console.warn("[teapot] warning: no model configured");

  const master = new Master(config);
  await master.start();

  const app = buildApp(master);
  serveApp(app, config.port);

  // agent crash isolation: an agent error never escapes its own loop; here we
  // also make sure the process survives unexpected rejections.
  process.on("uncaughtException", (err) => {
    console.error("[teapot] uncaught exception (master survived):", err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[teapot] unhandled rejection (master survived):", err);
  });

  const shutdown = async () => {
    console.log("\n[teapot] shutting down...");
    await Promise.allSettled([...master.agents.values()].map((a) => a.dispose()));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
