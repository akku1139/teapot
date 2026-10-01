/**
 * #34 — "the bash tool's cwd is maybe not the workspace directory?"
 *
 * Two independent defects made `pwd` differ from the agent's workspace:
 *
 *  A. a relative `"workspace"` in the config was resolved against
 *     `process.cwd()`, i.e. wherever the daemon happened to be started, not
 *     against the config file's directory (the shipped example config even
 *     documents the relative form);
 *  B. shells were spawned as `bash -lc`, so ~/.bash_profile or /etc/profile
 *     could `cd` the agent out of its workspace.
 *
 * Both are silent — no error, just a plausible-looking wrong directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { executeTool, type ToolContext } from "../src/agent/tools.ts";
import { resolveWorkspace, loadConfig, Master } from "../src/master.ts";
import { useTempDirs } from "./helpers/tmp.ts";

/* ---------- A: relative workspaces anchor to the config dir ---------- */

test("resolveWorkspace: a relative workspace anchors to the config dir (#34)", () => {
  const base = "/srv/teapot-config";
  assert.equal(resolveWorkspace("workspaces/alpha", base), path.join(base, "workspaces/alpha"));
  assert.equal(resolveWorkspace(".", base), base);
  assert.equal(resolveWorkspace("  spaced/dir  ", base), path.join(base, "spaced/dir"));
});

test("resolveWorkspace: absolute workspaces and ~ are left alone (#34)", () => {
  assert.equal(resolveWorkspace("/abs/ws", "/srv/teapot-config"), path.resolve("/abs/ws"));
  // an absolute path must NOT be re-anchored onto the config dir
  assert.notEqual(resolveWorkspace("/abs/ws", "/somewhere/else"), "/srv/teapot-config/abs/ws");
  const home = process.env.HOME;
  if (home) {
    assert.equal(resolveWorkspace("~/proj", "/srv/teapot-config"), path.join(home, "proj"));
  }
});

test("a config with a relative workspace gives the agent the config-dir path (#34)", async () => {
  await useTempDirs(["wsrel-root-", "wsrel-out-"], async ([dataDir, _ws]) => {
    // config lives in dataDir; its "workspace" entry is relative, exactly like
    // teapot.config.example.json ships it
    const configDir = path.join(dataDir, "cfgdir");
    const configPath = path.join(configDir, "config.json");
    mkdirSync(configDir, { recursive: true });
    const target = path.join(configDir, "workspaces", "alpha");
    mkdirSync(target, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        port: 0,
        dataDir,
        llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
        providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } },
        defaultProvider: "p",
        agents: [{ id: "alpha", workspace: "workspaces/alpha", provider: "p" }],
      }),
    );
    const m = new Master(loadConfig(configPath), configPath);
    const agent = await m.addAgent(
      { id: "alpha", workspace: "workspaces/alpha", provider: "p" },
      { persist: false },
    );
    // the agent's workspace must be the config-relative one, NOT process.cwd()
    assert.equal(agent.snapshot().workspace, target, "workspace anchored to the config dir");
    await m.stopAllAgents(2_000);
  });
});

/* ---------- B: the shell actually starts in the workspace ---------- */

function ctxIn(dir: string): ToolContext {
  return { cwd: dir, defaultTimeoutMs: 10_000, maxOutputBytes: 10_000 };
}

/** strip the "[took Ns]" suffix the bash result now ends with (#26) */
function stdoutOf(result: string): string {
  return result.replace(/\n?\[took [\d.]+s\]\s*$/, "").trim();
}

test("bash runs with pwd == the workspace (#34)", async () => {
  await useTempDirs(["wsbash-root-", "wsbash-ws-"], async ([dataDir, ws]) => {
    const ctx = ctxIn(ws);
    const r = await executeTool("bash", JSON.stringify({ command: "pwd" }), ctx);
    assert.ok(r.ok, r.result);
    assert.equal(stdoutOf(r.result), ws, "cwd is the workspace, not process.cwd()");
    void dataDir;
  });
});


/**
 * Temporarily point $HOME at a directory holding a `.bash_profile` that cds
 * to `/`. A login shell (`bash -lc`) sources it and leaves the workspace;
 * `bash -c` does not. Hermetic: it does not depend on whatever profile the
 * machine running the suite happens to have.
 */
async function withCdProfile<T>(home: string, fn: () => Promise<T>): Promise<T> {
  writeFileSync(path.join(home, ".bash_profile"), "#!/bin/bash\ncd /\n");
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

test("a login profile's cd cannot drag bash out of the workspace (#34)", async () => {
  await useTempDirs(["wslogin-root-", "wslogin-ws-", "wslogin-home-"], async ([_d, ws, home]) => {
    writeFileSync(path.join(ws, "marker.txt"), "MARKER\n");
    const r = await withCdProfile(home, async () =>
      executeTool("bash", JSON.stringify({ command: "cat marker.txt; pwd" }), ctxIn(ws)),
    );
    assert.ok(r.ok, r.result);
    assert.match(r.result, /^MARKER$/m, "relative path resolved inside the workspace");
    assert.equal(stdoutOf(r.result).split("\n").pop(), ws, "still in the workspace");
  });
});

test("a backgrounded bash job also stays in the workspace (#34)", async () => {
  await useTempDirs(["wsbg-root-", "wsbg-ws-", "wsbg-home-"], async ([_d, ws, home]) => {
    const start = await withCdProfile(home, async () =>
      executeTool(
        "bash",
        JSON.stringify({ command: "pwd > .bgcwd", background: true }),
        ctxIn(ws),
      ),
    );
    assert.ok(start.ok, start.result);
    assert.match(start.result, /bg\d+/, `job id in ${start.result}`);
    // Poll for the file the background shell writes from ITS cwd. If the login
    // profile won, the shell cd'd to / and wrote /.bgcwd — which never appears
    // here — so "not found" must FAIL the test, not quietly pass it.
    let seen: string | null = null;
    for (let i = 0; i < 100 && seen === null; i++) {
      try {
        seen = readFileSync(path.join(ws, ".bgcwd"), "utf8").trim();
      } catch {
        await new Promise((res) => setTimeout(res, 50));
      }
    }
    assert.equal(seen, ws, "background shell ran in the workspace (never cd'd away)");
  });
});

