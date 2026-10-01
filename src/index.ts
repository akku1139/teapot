#!/usr/bin/env node
/**
 * teapot master entry point.
 * Usage: teapot [--port N] [--host addr] [--config file.json] [config.json]
 * Config may also come from TEAPOT_* env vars (see src/master.ts).
 * First run (no config file): boot anyway and finish setup in the web UI.
 */
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { loadConfig, resolveConfigPath, Master } from "./master.ts";
import { buildApp, serveApp } from "./server/api.ts";

/**
 * Resolve once nothing is listening on port/host, i.e. the previous server has
 * released it. Used only by the live-update handover: binding while the old
 * process still holds the socket fails with EADDRINUSE (#35).
 *
 * Returns false on timeout so the caller can warn and try anyway, rather than
 * hanging a boot forever because of a wedged predecessor.
 */
async function waitForPortFree(
  port: number,
  host: string | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // 0.0.0.0 / :: means "all interfaces" — probe the loopback the old process
  // was actually reachable on.
  const probeHost = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  while (Date.now() < deadline) {
    const free = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false)); // still in use
      s.once("listening", () => s.close(() => resolve(true)));
      s.listen(port, probeHost);
    });
    if (free) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

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
    console.log("  --acp  speak the Agent Client Protocol on stdio instead of serving HTTP (#15)");
    console.log("  env: TEAPOT_PORT, TEAPOT_HOST, TEAPOT_CONFIG_DIR, TEAPOT_DATA_DIR, TEAPOT_API_TOKEN");
    return;
  }

  const configPath = resolveConfigPath(cfgArg);
  const configExisted = existsSync(configPath);
  const config = loadConfig(configPath);
  if (portOverride !== undefined && !Number.isNaN(portOverride)) config.port = portOverride;
  if (hostOverride) config.host = hostOverride;
  console.log(`[teapot] config: ${configPath}${configExisted ? "" : " (not found — first run)"}`);

  // Live update: the process we replace still holds the port. Ask it to release
  // it, then WAIT until the port is genuinely free before binding. Binding
  // into a live socket died with EADDRINUSE, and because index.ts swallows
  // uncaught exceptions ("the master survived") that left two processes running
  // while neither served anything — the port then answered nothing at all
  // (measured: 1150/1237 probes refused during handover) (#35).
  const fromPid = process.env.TEAPOT_RESTART_FROM
    ? parseInt(process.env.TEAPOT_RESTART_FROM, 10)
    : NaN;
  if (!Number.isNaN(fromPid) && fromPid !== process.pid) {
    console.log(`[teapot] restart: releasing port from old process ${fromPid}...`);
    try {
      // Flush the old process's agents and let it release the socket. It does
      // NOT wait for us (that would deadlock against our bind below) — it
      // lingers only long enough for its own HTTP response to flush, then exits.
      process.kill(fromPid, "SIGTERM");
    } catch {
      /* already gone */
    }
    // Wait until the socket is genuinely free. Binding while the old process
    // still holds it fails with EADDRINUSE, and because index.ts swallows
    // uncaught exceptions that left two processes running while neither served
    // anything (#35).
    if (!(await waitForPortFree(config.port, config.host, 30_000)))
      console.warn(
        `[teapot] warning: could not confirm ${config.host}:${config.port} is free — binding anyway`,
      );
  }

  const hasProviders = Object.keys(config.providers ?? {}).length > 0;
  if (!config.llm.apiKey && !hasProviders)
    console.warn("[teapot] warning: no API key configured — finish setup in the web UI");
  if (!config.llm.model && !hasProviders) console.warn("[teapot] warning: no model configured");

  const master = new Master(config, configPath);
  master.configFileExists = configExisted;
  await master.start();

  // ACP mode (#15): JSON-RPC over stdio, no HTTP server. Deliberately placed
  // AFTER the master is up (so config is resolved and agents work) but BEFORE
  // serveApp, so an editor launching `teapot --acp` never binds a port.
  if (process.argv.includes("--acp")) {
    const { AcpAdapter } = await import("./acp/adapter.ts");
    const acp = new AcpAdapter({ master });
    // nothing else may write to stdout — it carries the protocol
    console.error("[teapot] ACP mode: JSON-RPC over stdio");
    await acp.listen();
    return;
  }

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
    // During a live update the replacement SIGTERMs us to take the port. Linger
    // so our own in-flight HTTP responses flush first — notably
    // /api/update/restart, whose answer the browser is still waiting on; the
    // socket is released the moment we exit, which is what lets the replacement
    // bind. We must NOT wait for the replacement to come up: it is itself
    // waiting for this port to free, so that would deadlock the handover (#35).
    if (process.env.TEAPOT_RESTART_FROM) await new Promise((r) => setTimeout(r, 1_500));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
