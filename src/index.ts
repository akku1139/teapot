#!/usr/bin/env node
/**
 * teapot master entry point.
 * Usage: teapot [--port N] [--config file.json] [config.json]
 * Config may also come from TEAPOT_* env vars (see src/master.ts).
 * First run (no config file): boot anyway and finish setup in the web UI.
 */
import { existsSync } from "node:fs";
import { loadConfig, resolveConfigPath, Master } from "./master.ts";
import { buildApp, serveApp } from "./server/api.ts";

async function main(): Promise<void> {
  // CLI: teapot [--port N] [-p N] [--config file] [-c file] [config.json]
  let cfgArg: string | undefined;
  let portOverride: number | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--port" || a === "-p") portOverride = Number(args[++i]);
    else if (a === "--config" || a === "-c") cfgArg = args[++i];
    else if (!cfgArg && !a.startsWith("-")) cfgArg = a;
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("teapot [--port N] [--config file.json] [config.json]");
    console.log("  env: TEAPOT_PORT, TEAPOT_CONFIG_DIR, TEAPOT_DATA_DIR, TEAPOT_API_TOKEN");
    return;
  }

  const configPath = resolveConfigPath(cfgArg);
  const configExisted = existsSync(configPath);
  const config = loadConfig(configPath);
  if (portOverride !== undefined && !Number.isNaN(portOverride)) config.port = portOverride;
  console.log(`[teapot] config: ${configPath}${configExisted ? "" : " (not found — first run)"}`);
  const hasProviders = Object.keys(config.providers ?? {}).length > 0;
  if (!config.llm.apiKey && !hasProviders)
    console.warn("[teapot] warning: no API key configured — finish setup in the web UI");
  if (!config.llm.model && !hasProviders) console.warn("[teapot] warning: no model configured");

  const master = new Master(config, configPath);
  master.configFileExists = configExisted;
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
