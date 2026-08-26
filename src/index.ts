#!/usr/bin/env node
/**
 * teapot master entry point.
 * Usage: teapot [--port N] [--host addr] [--config file.json] [config.json]
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
  let hostOverride: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--port" || a === "-p") portOverride = Number(args[++i]);
    else if (a === "--host") hostOverride = args[++i];
    else if (a === "--config" || a === "-c") cfgArg = args[++i];
    else if (!cfgArg && !a.startsWith("-")) cfgArg = a;
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("teapot [--port N] [--host addr] [--config file.json] [config.json]");
    console.log("  --host 127.0.0.1 (default) · 0.0.0.0 exposes the UI to your network");
    console.log("  env: TEAPOT_PORT, TEAPOT_HOST, TEAPOT_CONFIG_DIR, TEAPOT_DATA_DIR, TEAPOT_API_TOKEN");
    return;
  }

  // Handle restart-from-old-process: if we're the new process spawned by a
  // live update, wait for the old process to release the port and exit.
  const restartFromPid = process.env.TEAPOT_RESTART_FROM
    ? parseInt(process.env.TEAPOT_RESTART_FROM, 10)
    : null;
  if (restartFromPid && !Number.isNaN(restartFromPid)) {
    // Give the old process time to gracefully shut down and release the port
    console.log(`[teapot] restart: waiting for old process ${restartFromPid} to exit...`);
    try {
      // Send SIGTERM to old process (it handles graceful shutdown)
      process.kill(restartFromPid, "SIGTERM");
      // Wait for it to exit (max 5 seconds)
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(restartFromPid, 0); // check if alive
          await new Promise((r) => setTimeout(r, 100));
        } catch {
          // Process no longer exists
          break;
        }
      }
    } catch {
      // Old process might already be gone
    }
  }

  const configPath = resolveConfigPath(cfgArg);
  const configExisted = existsSync(configPath);
  const config = loadConfig(configPath);
  if (portOverride !== undefined && !Number.isNaN(portOverride)) config.port = portOverride;
  if (hostOverride) config.host = hostOverride;
  console.log(`[teapot] config: ${configPath}${configExisted ? "" : " (not found — first run)"}`);
  const hasProviders = Object.keys(config.providers ?? {}).length > 0;
  if (!config.llm.apiKey && !hasProviders)
    console.warn("[teapot] warning: no API key configured — finish setup in the web UI");
  if (!config.llm.model && !hasProviders) console.warn("[teapot] warning: no model configured");

  const master = new Master(config, configPath);
  master.configFileExists = configExisted;
  await master.start();

  const app = buildApp(master);
  serveApp(app, config.port, config.host);

  // agent crash isolation: an agent error never escapes its own loop; here we
  // also make sure the process survives unexpected rejections.
  process.on("uncaughtException", (err) => {
    console.error("[teapot] uncaught exception (master survived):", err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[teapot] unhandled rejection (master survived):", err);
  });

  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[teapot] shutting down${signal ? ` (${signal})` : ""}...`);
    await Promise.allSettled([...master.agents.values()].map((a) => a.dispose()));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
