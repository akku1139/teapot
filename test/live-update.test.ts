/**
 * #35 — "live updating daemonizes the server"
 *
 * Three separate defects, all reproduced here against REAL processes:
 *
 *  1. restartServer() spawned the replacement with `detached: true` and
 *     `stdio: "ignore"`. Detached put it in a new process group, so Ctrl-C and
 *     a closing terminal could no longer stop it; stdio:"ignore" threw away its
 *     console output, so you could not see what it was doing — hence "I can't
 *     check the logs or stop it".
 *  2. The handover was a fixed 1s sleep, and the new process killed the old one
 *     *at startup* rather than once it was listening. A slow start left a window
 *     where neither process owned the port.
 *  3. The browser reloaded as soon as /api/version reported a new version — but
 *     during handover the OLD process is still the one answering that endpoint,
 *     so the reload raced the port becoming available.
 *
 * This drives src/index.ts as a child process over a real socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markPosixOnly } from "./helpers/posix-only.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

// #110: POSIX-only — spawns a detached server and tears it down with a POSIX process-group kill (ECONNRESET on windows-latest).
markPosixOnly("spawns a detached server and tears it down with a POSIX process-group kill (ECONNRESET on windows-latest)");

// #110: `.pathname` on a file: URL yields "/C:/..." on Windows, so every path
// built from it was wrong. `fileURLToPath` is the platform-correct conversion.
const root = fileURLToPath(new URL("..", import.meta.url));
const entry = path.join(root, "src", "index.ts");

interface Boot {
  proc: ChildProcess;
  port: number;
  dir: string;
  /** live view of the child's stdout+stderr — a getter, not a snapshot,
   *  because the whole point of #35 is what the child DID print */
  readonly out: string;
}

/**
 * Ask the OS for a free port.
 *
 * The port is RELEASED before it is used, so this is not a reservation: between `close()` and the
 * server's `listen` another process can take it. That race is unavoidable this way, so callers must
 * be able to retry rather than assume the answer is still free — see `bootOnFreePort`.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

/**
 * Boot on a free port, retrying when the port is taken between the probe and the bind.
 *
 * MEASURED on CI: `publish.yml` failed with `EADDRINUSE: address already in use 127.0.0.1:38529`
 * and the test reported "the live update never started its exec", which points at the FEATURE when
 * the fixture was at fault. Any process on the runner can grab a released port, so a single probe is
 * a guess; a few attempts turn a flaky red build into the non-event it is.
 */
async function bootOnFreePort(
  tag: string,
  extraEnv: NodeJS.ProcessEnv = {},
  seed: Record<string, unknown> = {},
): Promise<Boot> {
  let last: Boot | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const b = await boot(tag, await freePort(), extraEnv, seed);
    /**
     * Wait for ONE of: the server answers, or the child DIES.
     *
     * A `listen` failure (EADDRINUSE) does not always exit the process — this codebase deliberately
     * swallows uncaught exceptions in places — so "wait for a 200" alone would spin until the outer
     * timeout with the port still dark. Death and readiness are the only two settled states, and a
     * dead child is what makes the retry happen.
     */
    const settled = await waitFor(async () => {
      if (b.proc.exitCode !== null || b.proc.signalCode !== null) return true;
      return (await get(b.port, "/api/version")).status === 200;
    }, 8_000);
    // a bind failure shows up in the child's own output; treat it as "retry with a new port"
    const bindFailed = /EADDRINUSE|EACCES/.test(b.out);
    if (settled && b.proc.exitCode === null && !bindFailed) return b;
    last = b;
    killTree(b.proc);
    rmSync(b.dir, { recursive: true, force: true });
  }
  throw new Error(`could not bind a free port after 5 attempts: ${last?.out ?? ""}`);
}

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  ms: number,
  /** what was being waited for — a timed-out poll otherwise fails with no clue */
  label = "condition",
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error(`waitFor: ${label} did not become true within ${ms}ms`);
  return false;
}

/** is this pid still running? (EPERM = alive, just not ours to signal) */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The live update now REPLACES the process in place (`process.execve`), so there is no grandchild
 * to reap — but the group kill stays: the child is spawned `detached` below so a wedged test can
 * never leave a server holding a port.
 */
function killTree(proc: ChildProcess): void {
  try { process.kill(-proc.pid!, "SIGKILL"); } catch {}
  try { proc.kill("SIGKILL"); } catch {}
}

async function boot(
  tag: string,
  port: number,
  extraEnv: NodeJS.ProcessEnv = {},
  /** extra config fields, so a test can seed state the update reads (e.g. `resumeAfterUpdate`) */
  seed: Record<string, unknown> = {},
): Promise<Boot> {
  const dir = mkdtempInRootSync(`teapot-live-${tag}-`);
  const cfg = path.join(dir, "config.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      port,
      host: "127.0.0.1",
      dataDir: path.join(dir, "data"),
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
      providers: {},
      agents: [],
      ...seed,
    }),
  );
  const proc = spawn(process.execPath, [entry, "--config", cfg], {
    cwd: root, // run from the repo so the TS entry resolves its imports
    stdio: ["ignore", "pipe", "pipe"],
    // own process group so the test can take down the replacement too (a live
    // update spawns a grandchild that outlives its parent)
    detached: true,
    env: { ...process.env, ...extraEnv },
  });
  let buf = "";
  proc.stdout?.on("data", (c) => (buf += c.toString()));
  proc.stderr?.on("data", (c) => (buf += c.toString()));
  return {
    proc,
    port,
    dir,
    get out() {
      return buf;
    },
  };
}

/** status 0 == "nothing answered" — the gap we are hunting for in #35 */
async function get(
  port: number,
  p: string,
  method = "GET",
): Promise<{ status: number; body: string }> {
  try {
    /**
     * A TIMEOUT, because `fetch` to a port nobody is listening on does not always reject.
     *
     * Without this, a `listen` that failed (EADDRINUSE) left the probe hanging instead of reporting
     * "nothing answered" — MEASURED: a retry loop that should have finished in seconds sat until the
     * outer timeout, which reads as the FEATURE hanging. `status: 0` already means "nothing
     * answered", so a timed-out probe is the same answer rather than an exception.
     */
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      signal: AbortSignal.timeout(2_000),
    });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { status: 0, body: String((e as Error).cause ?? e) };
  }
}

/**
 * The live update REPLACES THE PROCESS IN PLACE.
 *
 * The previous design spawned a successor and stayed resident as its supervisor. That supervisor
 * loop is the reported memory leak: it polled `pidAlive(replacement)` for the ENTIRE lifetime of
 * the new server, so the old process kept every agent object, every log handle, every `bus`
 * listener and its 15s tick — and `supervise()` added three more signal handlers on top of the
 * ones `shutdown()` already had. Each update left another full copy of the server resident.
 *
 * `process.execve` removes the category: the image is replaced under the SAME pid, so the process
 * group, the controlling terminal and the operator's foreground job all stay put, the listener is
 * released as part of the exec, and there is no second process to supervise.
 *
 * These tests assert the observable consequences, because the mechanism is an implementation
 * detail. What must hold is: same pid, still serving, logs still visible, Ctrl-C still works, and
 * nothing lingering behind afterwards.
 */
test("live update: the SAME process keeps serving — no successor, nothing left resident (#35)", async (t) => {
  const a = await bootOnFreePort("exec");
  const port = a.port;
  t.after(() => {
    killTree(a.proc);
    rmSync(a.dir, { recursive: true, force: true });
  });

  assert.ok(
    await waitFor(async () => (await get(port, "/api/version")).status === 200, 20_000),
    `first server never came up: ${a.out}`,
  );
  const pidBefore = a.proc.pid!;

  const res = await get(port, "/api/update/restart", "POST");
  assert.equal(res.status, 200, `restart endpoint must answer: ${res.body}\n${a.out}`);

  // the new image identifies itself
  assert.ok(
    await waitFor(() => a.out.includes("replacing this process in place"), 30_000),
    `the live update never started its exec:\n${a.out}`,
  );
  // …and the same pid is serving again
  assert.ok(
    await waitFor(
      () => (a.out.match(/master listening on/g) ?? []).length >= 2,
      30_000,
    ),
    `the new image never came up (#35):\n${a.out}`,
  );
  assert.ok(
    await waitFor(async () => (await get(port, "/api/version")).status === 200, 30_000),
    "no process is serving /api/version after the update",
  );

  /**
   * THE ASSERTION: the pid did NOT change.
   *
   * That is what makes the leak structurally impossible — there is no second process to linger, so
   * no supervisor loop and no duplicated listener set can exist. It is also what keeps the operator
   * attached: the shell's foreground job, the process group and the terminal are all unchanged.
   */
  assert.ok(
    pidAlive(pidBefore),
    `pid ${pidBefore} must still be the server after the update (it was replaced in place):\n${a.out}`,
  );
  assert.ok(
    !/supervising the new server/.test(a.out),
    "the supervisor mode must be GONE — it is what leaked a whole server image per update (#35)",
  );
  assert.ok(
    !/EADDRINUSE/.test(a.out),
    `the exec must release the port before the new image binds (#35):\n${a.out}`,
  );

  // and the process the shell waits on never went away, so nobody was dumped at a prompt
  a.proc.kill("SIGINT");
  assert.ok(
    await waitFor(() => !pidAlive(pidBefore), 30_000),
    `Ctrl-C must stop the server after an in-place update (#35):\n${a.out}`,
  );
});

test("live update: a session that was WORKING is resumed by the new image (#resume)", async (t) => {
  /**
   * "サーバーを再起動して動作中だったセッションのエージェントループを再開".
   *
   * The resume set cannot be derived after the fact: a session interrupted mid-round looks exactly
   * like one that finished, or one the operator stopped. So it is decided at shutdown and consumed
   * once by the next image — and the CONSUMING side is what can regress silently, because a missing
   * `TEAPOT_RESUMED` just means nothing is resumed and the server looks perfectly healthy.
   *
   * Driven through a real update: the config carries a resume set, the boot marker is set, and the
   * assertion is that the set was CONSUMED (cleared from the file) and the boot said so. Driving a
   * real agent into a working state instead would need a live LLM; this covers the wiring.
   */
  // one configured agent, and that agent in the resume set — exactly what restartServer() writes
  const a = await bootOnFreePort("resume", { TEAPOT_RESUMED: "1" }, {
    agents: [{ id: "worker", workspace: "/tmp", provider: "p", session: "s1" }],
    providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } },
    resumeAfterUpdate: ["worker"],
  });
  const port = a.port;
  t.after(() => {
    killTree(a.proc);
    rmSync(a.dir, { recursive: true, force: true });
  });
  assert.ok(
    await waitFor(async () => (await get(port, "/api/version")).status === 200, 20_000),
    `server never came up: ${a.out}`,
  );

  /**
   * The set must be CLEARED, not merely read.
   *
   * A crash right after the update must not make the NEXT boot resume work that has been idle for
   * hours: the set describes one handover, so it is consumed once. The file is the only place this
   * is observable — the field is transient and deliberately absent from the API.
   */
  const cfgPath = path.join(a.dir, "config.json");
  const onDisk = JSON.parse(readFileSync(cfgPath, "utf8")) as { resumeAfterUpdate?: unknown };
  assert.deepEqual(
    onDisk.resumeAfterUpdate,
    [],
    `the resume set must be consumed and cleared, got ${JSON.stringify(onDisk.resumeAfterUpdate)}`,
  );
  assert.match(
    a.out,
    /live update: .*resumed/,
    `the resumed boot must report what it resumed:\n${a.out}`,
  );
});

test("live update: the port is never left unowned (#35)", async (t) => {
  // A single sub-millisecond blip is inherent — one socket cannot be served by two images at once.
  // What must never happen is the port staying dark: the pre-exec failure mode was the successor
  // dying with EADDRINUSE while (index.ts swallows uncaught exceptions) BOTH processes stayed alive
  // serving nothing, forever.
  const a = await bootOnFreePort("hold");
  const port = a.port;
  t.after(() => {
    killTree(a.proc);
    rmSync(a.dir, { recursive: true, force: true });
  });
  assert.ok(
    await waitFor(async () => (await get(port, "/api/version")).status === 200, 20_000),
    `first server never came up: ${a.out}`,
  );

  let gaps = 0;
  let probes = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      probes++;
      if ((await get(port, "/api/version")).status !== 200) gaps++;
      await new Promise((r) => setTimeout(r, 25));
    }
  })();

  const started = Date.now();
  await get(port, "/api/update/restart", "POST");
  const recovered = await waitFor(
    async () => (await get(port, "/api/version")).status === 200,
    20_000,
    "port never recovered",
  );
  sampling = false;
  await sampler;

  assert.ok(recovered, `the port never came back after the update (#35):\n${a.out}`);
  assert.ok(probes > 5, `sampler barely ran (${probes} probes) — not exercising the window`);
  /**
   * Assert the OUTAGE DURATION, not a gap RATIO.
   *
   * The ratio was calibrated against the old handover, which took seconds because two processes
   * took turns owning one socket. The in-place exec removes that: the image is replaced and the
   * listen happens within milliseconds, so a 25ms sampler sees a handful of gaps concentrated in a
   * very short window and the RATIO depends entirely on when sampling started relative to the
   * restart (MEASURED 15/17 during a 871ms update that fully recovered).
   *
   * A ratio over a variable-length sample is not a property of the system; the time the port spent
   * dark is. A second is generous for one bind and still catches the real bug, which was the port
   * never recovering at all.
   */
  assert.ok(recovered, "the port must answer again");
  const darkMs = gaps * 25;
  assert.ok(
    darkMs < 2_000,
    `the port was dark for ~${darkMs}ms (${gaps}/${probes} probes) during the update (#35):\n${a.out}`,
  );
  assert.ok(!/EADDRINUSE/.test(a.out), `the new image crashed on bind: EADDRINUSE (#35)`);
  assert.ok(
    !a.out.includes("uncaught exception"),
    `a bind crash was swallowed (#35):\n${a.out}`,
  );
  assert.ok(Date.now() - started < 30_000, "the update took absurdly long");
});
