#!/usr/bin/env node
/**
 * teapot master entry point.
 * Usage: teapot [--port N] [--host addr] [--config file.json] [config.json]
 * Config may also come from TEAPOT_* env vars (see src/master.ts).
 * First run (no config file): boot anyway and finish setup in the web UI.
 */
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveConfigPath, Master } from "./master.ts";
import { buildApp, serveApp } from "./server/api.ts";

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
 *
 * BOTH spellings are accepted: `--host 0.0.0.0` and `--host=0.0.0.0`. Only the
 * space-separated form used to parse, so `--host=0.0.0.0` — the spelling people
 * reach for, and the one every other CLI accepts — was silently DISCARDED and the
 * server came up on loopback with nothing readable to say why. Reported as
 * "--host が効いてない、0.0.0.0 にしても他デバイスからアクセスできない", and a
 * silently-ignored flag is the worst possible shape for this: the operator sees a
 * server that started fine and blames their network.
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
    // `--name=value` and `--name value` both work. Splitting here means every
    // branch below sees the plain name and reads its value the same way, so a
    // future flag cannot repeat the `--host=` omission.
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq === -1 ? a : a.slice(0, eq);
    // for `--name=value` the value is already in `a`; otherwise take the next word
    const value = () => (eq === -1 ? argv[++i] : a.slice(eq + 1));
    if (name === "--port" || name === "-p") {
      const raw = value();
      const n = Number(raw);
      // NaN is dropped rather than applied: `config.port = NaN` would fall through
      // to the listen call and produce a far more confusing failure than ignoring
      // a mistyped flag
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

  /**
   * NO PORT HANDOVER DANCE.
   *
   * This used to read `TEAPOT_RESTART_FROM`, SIGTERM the predecessor and poll until the port was
   * free, because the successor was a SEPARATE process racing the old one for one socket. The live
   * update now replaces the process in place with `process.execve`, so the pid never changes: the
   * exec releases the listener as part of replacing the image (verified) and this process is the
   * only one that ever binds. The whole EADDRINUSE window #35 worked around cannot occur.
   */
  const hasProviders = Object.keys(config.providers ?? {}).length > 0;
  if (!config.llm.apiKey && !hasProviders)
    console.warn("[teapot] warning: no API key configured — finish setup in the web UI");
  if (!config.llm.model && !hasProviders) console.warn("[teapot] warning: no model configured");

  const master = new Master(config, configPath);
  master.configFileExists = configExisted;
  await master.start();

  /**
   * LIVE UPDATE: resume what the previous image was running.
   *
   * The set was written to the config by `restartServer()` immediately before the exec, because
   * after a restart the log cannot tell "was working when the update hit" from "finished" or
   * "stopped by the operator" — resuming every configured agent would start work nobody asked for,
   * and resuming none is the bug being fixed ("サーバーを再起動して動作中だったセッションのエージェント
   * ループを再開").
   *
   * Deliberately AFTER `start()` so the agents exist, and BEFORE the port is served so the operator
   * reloading the page sees the resumed sessions already moving.
   */
  if (process.env.TEAPOT_RESUMED) {
    delete process.env.TEAPOT_RESUMED;
    const resumed = await master.resumeAfterUpdate();
    if (resumed.length) console.log(`[teapot] live update: ${resumed.length} session(s) resumed`);
  }

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
  // kept for the process lifetime; nothing closes it explicitly any more (the supervisor
  // branch that did is gone — `process.execve` replaces the image and releases the socket)
  serveApp(app, config.port, config.host);
  /**
   * Say out loud when the API has no auth, and when it is reachable beyond loopback.
   *
   * The OpenCode advisory (CVE-2026-22812) was not just "a server was open" — it was open and
   * nobody knew. `apiToken()` is empty on a fresh install because the setup wizard sets the
   * password THROUGH the API, so a token cannot be demanded before one exists; the honest response
   * is to make the state visible on every start rather than to pretend it is protected.
   *
   * See docs/security-advisories.md.
   */
  const noAuth = !(process.env.TEAPOT_API_TOKEN || master.config.password);
  const beyondLoopback = !!config.host && config.host !== "127.0.0.1" && config.host !== "localhost";
  if (noAuth) {
    /**
     * On LOOPBACK this is the normal, safe default — so say so plainly instead of printing an
     * alarming "no API token set" on every start.
     *
     * Asked as "no API token setはなんだろう": nothing is wrong. A fresh install has no password
     * because the setup wizard has to reach the API to set one, and binding 127.0.0.1 means only
     * processes on this machine can connect. The message now states that, and is written to stdout
     * at info level — `console.error` made a healthy start look like a fault.
     *
     * The WARNING branch is unchanged and still goes to stderr: that one IS a problem.
     */
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
    /**
     * THERE IS NO SUPERVISOR MODE ANY MORE — and removing it IS the memory-leak fix.
     *
     * The old live update spawned a successor and stayed resident as its supervisor, polling
     * `pidAlive(replacement)` every 500ms for the ENTIRE lifetime of the new server. Everything
     * this process owned stayed alive with it: every agent object and its log handles, every `bus`
     * listener, the 15s master tick, plus three MORE signal handlers that `supervise()` added on
     * top of the ones `shutdown()` had already registered. Each update therefore left another full
     * copy of the server resident, which is the reported leak.
     *
     * `restartServer()` now replaces the image in place with `process.execve`, so there is no
     * successor to supervise: the exec reuses this pid, this process group and this terminal, so
     * nothing is orphaned and nothing lingers. `execve` only resolves if it FAILED, and that path
     * throws inside `restartServer`, so nothing is left trusting this branch.
     */
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
