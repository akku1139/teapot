#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveConfigPath, Master } from "./master.ts";
import { buildApp, serveApp } from "./server/api.ts";

export function parseArgs(argv: string[]): {
  cfgArg?: string;
  portOverride?: number;
  hostOverride?: string;
  help: boolean;
} {
  let cfgArg: string | undefined;
  let portOverride: number | undefined;
  let hostOverride: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq === -1 ? a : a.slice(0, eq);
    const value = () => (eq === -1 ? argv[++i] : a.slice(eq + 1));
    if (name === "--port" || name === "-p") {
      const raw = value();
      const n = Number(raw);
      if (!Number.isNaN(n)) portOverride = n;
    } else if (name === "--host") {
      hostOverride = value();
    } else if (name === "--config" || name === "-c") {
      cfgArg = value();
    } else if (!a.startsWith("-") && cfgArg === undefined) {
      cfgArg = a;
    }
  }
  return { cfgArg, portOverride, hostOverride, help: argv.includes("--help") || argv.includes("-h") };
}

async function main(): Promise<void> {
  const { cfgArg, portOverride, hostOverride, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log("teapot [--port N] [--host addr] [--config file.json] [config.json]");
    console.log("  --host 127.0.0.1 (default) · 0.0.0.0 exposes the UI to your network");
    console.log("  --acp  speak the Agent Client Protocol on stdio instead of serving HTTP");
    console.log("  env: TEAPOT_PORT, TEAPOT_HOST, TEAPOT_CONFIG_DIR, TEAPOT_DATA_DIR, TEAPOT_API_TOKEN");
    return;
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

  if (process.env.TEAPOT_RESUMED) {
    delete process.env.TEAPOT_RESUMED;
    const resumed = await master.resumeAfterUpdate();
    if (resumed.length) console.log(`[teapot] live update: ${resumed.length} session(s) resumed`);
  }

  if (process.argv.includes("--acp")) {
    const { AcpAdapter } = await import("./acp/adapter.ts");
    const acp = new AcpAdapter({ master });
    console.error("[teapot] ACP mode: JSON-RPC over stdio");
    await acp.listen();
    return;
  }

  const app = buildApp(master);
  serveApp(app, config.port, config.host);
  const noAuth = !(process.env.TEAPOT_API_TOKEN || master.config.password);
  const beyondLoopback = !!config.host && config.host !== "127.0.0.1" && config.host !== "localhost";
  if (noAuth) {
    if (!beyondLoopback) {
      console.log(
        "[teapot] auth: none needed — bound to loopback only, so only this machine can reach /api. " +
          "Set TEAPOT_API_TOKEN or config.password before exposing this port.",
      );
    }
    if (beyondLoopback) {
      console.error(
        `[teapot] WARNING: bound to ${config.host} with NO auth — anyone who can reach this port can ` +
          "drive the agents. Set TEAPOT_API_TOKEN or config.password now.",
      );
    }
  }

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
    const updating = master.updateInFlight === true;
    if (updating && signal === "SIGINT" && !process.env.TEAPOT_FORCE_SHUTDOWN) {
      console.log("\n[teapot] live update is in progress — press ^C again to abort it and stop");
      process.env.TEAPOT_FORCE_SHUTDOWN = "1";
      shuttingDown = false;
      return;
    }
    console.log(`\n[teapot] shutting down${signal ? ` (${signal})` : ""}...`);
    await Promise.allSettled([...master.agents.values()].map((a) => a.dispose()));
    if (process.env.TEAPOT_RESTART_FROM) await new Promise((r) => setTimeout(r, 1_500));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const entry = realpathSync(arg);
    if (self === entry) return true;
    return false;
  } catch {
    return false;
  }
}

if (isEntryPoint()) void main();
