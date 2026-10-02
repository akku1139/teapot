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

/* ---------- live-update handover: keeping the operator's terminal (#35) ---------- */

/**
 * The pid of the process that replaced US, or null if we are the server.
 *
 * `Master.restartServer()` spawns the replacement and records its pid here, so
 * the outgoing process can supervise its own successor instead of exiting and
 * handing the shell a prompt. A field on the master rather than an env var: both
 * processes are separate, but this value is written and read in the SAME
 * process, so there is no environment for the two of them to disagree over.
 */

/** is `pid` still running? (EPERM means alive but not ours to signal) */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Watch the replacement on the operator's behalf.
 *
 * The terminal is still wired to THIS process, so their Ctrl-C arrives here
 * first. Two things must happen, and the old one-shot shutdown() could do
 * neither:
 *
 *  1. forward the signal, so the replacement actually stops; and
 *  2. when the replacement does exit, leave too — otherwise the shell waits on
 *     a supervisor with nothing left to supervise and Ctrl-C looks broken.
 *
 * The original shutdown() cannot be reused for this: its `shuttingDown` latch
 * is already set by the SIGTERM that started the handover, so a later Ctrl-C
 * would be swallowed and this process would never exit.
 */
function supervise(pid: number): void {
  let signalled = false;
  const forward = (sig: NodeJS.Signals) => {
    // Once the replacement is on its way out, stop bouncing signals: a second
    // SIGINT arriving during its shutdown would re-raise the same failure and
    // the operator would have to press Ctrl-C several times to be heard.
    if (signalled) return;
    signalled = true;
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone — the poll loop below notices and exits */
    }
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => forward(sig));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const server = serveApp(app, config.port, config.host);

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
    // SUPERVISOR MODE. When a live update replaced us, we are no longer the
    // server — but we are still the process the SHELL is waiting on, and it
    // is still this process group that owns the terminal. Exiting here ended
    // the shell's foreground job, so the operator was dumped back to the
    // prompt mid-session while the new server kept running in the background
    // ("teapot live restart returns to the shell", #35).
    //
    // So instead of exiting we hand over: keep the job slot, forward signals
    // to the replacement, and only leave once it is gone. The operator's
    // terminal — and their Ctrl-C — follow the server across the restart.
    //
    // The replacement is the child we spawned ourselves, so we hold it directly:
    // no pid passed through the environment, and no way for the two processes
    // to disagree about who supervises whom.
    if (master.replacementPid !== null) {
      const replacement = master.replacementPid;
      console.log(`[teapot] handing the terminal to the new server (pid ${replacement})...`);
      // Release the port FIRST. The replacement is blocked in waitForPortFree
      // waiting for exactly this, and it will SIGTERM us again if we do not go
      // — but the difference now is that we stop SERVING rather than exiting,
      // so the shell's foreground job survives the handover.
      await server.close();
      console.log("[teapot] port released; supervising the new server");
      supervise(replacement);
      // Stay attached until the replacement exits. The shell is still waiting
      // on US, so leaving early is exactly the bug.
      while (pidAlive(replacement)) await sleep(500);
      console.log("[teapot] new server exited; releasing the terminal");
      process.exit(0);
    }
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
