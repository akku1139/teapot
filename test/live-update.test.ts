import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markPosixOnly } from "./helpers/posix-only.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

markPosixOnly("spawns a detached server and tears it down with a POSIX process-group kill (ECONNRESET on windows-latest)");

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = path.join(root, "src", "index.ts");

interface Boot {
  proc: ChildProcess;
  port: number;
  dir: string;
  readonly out: string;
}

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

async function bootOnFreePort(
  tag: string,
  extraEnv: NodeJS.ProcessEnv = {},
  seed: Record<string, unknown> = {},
): Promise<Boot> {
  let last: Boot | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const b = await boot(tag, await freePort(), extraEnv, seed);
    const settled = await waitFor(async () => {
      if (b.proc.exitCode !== null || b.proc.signalCode !== null) return true;
      return (await get(b.port, "/api/version")).status === 200;
    }, 8_000);
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killTree(proc: ChildProcess): void {
  try { process.kill(-proc.pid!, "SIGKILL"); } catch {}
  try { proc.kill("SIGKILL"); } catch {}
}

async function boot(
  tag: string,
  port: number,
  extraEnv: NodeJS.ProcessEnv = {},
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
    cwd: root, 
    stdio: ["ignore", "pipe", "pipe"],
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

async function get(
  port: number,
  p: string,
  method = "GET",
): Promise<{ status: number; body: string }> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      signal: AbortSignal.timeout(2_000),
    });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { status: 0, body: String((e as Error).cause ?? e) };
  }
}

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

  assert.ok(
    await waitFor(() => a.out.includes("replacing this process in place"), 30_000),
    `the live update never started its exec:\n${a.out}`,
  );
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

  a.proc.kill("SIGINT");
  assert.ok(
    await waitFor(() => !pidAlive(pidBefore), 30_000),
    `Ctrl-C must stop the server after an in-place update (#35):\n${a.out}`,
  );
});

test("live update: a session that was WORKING is resumed by the new image (#resume)", async (t) => {
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
