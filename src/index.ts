#!/usr/bin/env node
/**
 * teapot master entry point.
 * Usage: teapot [--port N] [--host addr] [--config file.json] [config.json]
 * Config may also come from TEAPOT_* env vars (see src/master.ts).
 * First run (no config file): boot anyway and finish setup in the web UI.
 */
import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
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
 * first: forward the signal so the replacement actually stops, and leave once
 * it exits — otherwise the shell waits on a supervisor with nothing left to
 * supervise and Ctrl-C looks broken.
 *
 * shutdown() cannot be reused for this: its `shuttingDown` latch is already set
 * by the SIGTERM that started the handover, so a later Ctrl-C would be swallowed
 * and this process would never exit.
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

/**
 * Parse `teapot [--port N] [-p N] [--host addr] [--config file] [config.json]`.
 *
 * Exported so it can be tested: the parser decides which config file is read and
 * which port is bound, so a regression here starts the wrong server on the wrong
 * port with no error anyone would read.
 *
 * The bare-word rule keeps the FIRST positional as the config path: a later bare
 * word is a stray argument, not an override, and silently replacing the config
 * with it would be worse than ignoring it.
 */
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
    if (a === "--port" || a === "-p") {
      const raw = argv[++i];
      const n = Number(raw);
      // NaN is dropped rather than applied: `config.port = NaN` would fall through
      // to the listen call and produce a far more confusing failure than ignoring
      // a mistyped flag
      if (!Number.isNaN(n)) portOverride = n;
    } else if (a === "--host") {
      hostOverride = argv[++i];
    } else if (a === "--config" || a === "-c") {
      cfgArg = argv[++i];
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
      // Flush the old process's agents and let it release the socket. It must
      // NOT wait for us — that would deadlock against our bind below.
      process.kill(fromPid, "SIGTERM");
    } catch {
      /* already gone */
    }
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
    // SUPERVISOR MODE. When a live update replaced us we are no longer the
    // server, but we are still the process the SHELL waits on and the one that
    // owns the terminal; exiting here dumped the operator back to the prompt
    // mid-session while the new server kept running in the background (#35). So
    // we keep the job slot, forward signals to the replacement, and leave only
    // once it is gone. The replacement is the child we spawned ourselves, so we
    // hold it directly — no pid through the environment for the two processes to
    // disagree over.
    if (master.replacementPid !== null) {
      const replacement = master.replacementPid;
      console.log(`[teapot] handing the terminal to the new server (pid ${replacement})...`);
      // Release the port FIRST: the replacement is blocked in waitForPortFree
      // waiting for exactly this, and it will SIGTERM us again if we do not go.
      await server.close();
      console.log("[teapot] port released; supervising the new server");
      supervise(replacement);
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

// Only when RUN, not when imported: `void main()` at module scope meant importing
// this file for `parseArgs` started a whole server. `node
// --experimental-strip-types src/index.ts` and `node dist/index.js` both take
// this branch.
function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  // `npm i -g teapot-coding-agent` puts a SYMLINK at node_modules/.bin/teapot and
  // npm invokes the target THROUGH it, so `process.argv[1]` is the symlink path,
  // NOT the file it points at: the installed command then exited 0 in silence.
  // `realpathSync` is what resolves it.
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const entry = realpathSync(arg);
    if (self === entry) return true;
    // `self === entry` is the ONLY correct test: it is the definition of being the
    // entry point. A suffix check such as `endsWith("/index.ts")` is true for
    // EVERY test file that imports this module, so importing it booted a real
    // server on port 7788 and `cli-args.test.ts` failed with EADDRINUSE.
    return false;
  } catch {
    return false;
  }
}

if (isEntryPoint()) void main();
