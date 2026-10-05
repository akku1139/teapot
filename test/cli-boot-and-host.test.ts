/**
 * #140 — two bugs in the shipped package, both reported against v0.28.0.
 *
 * ## 1. `teapot` was not bootable from the `teapot` command
 *
 * `npm i -g teapot-coding-agent` creates a SYMLINK at `node_modules/.bin/teapot`
 * and npm invokes the target THROUGH it, so `process.argv[1]` is the symlink path
 * — `…/node_modules/.bin/teapot` — not the file it points at.
 *
 * My entry-point guard (added when `parseArgs` was extracted, so the module could
 * be imported for testing without booting a server) compared `argv[1]` against
 * `import.meta.url`'s pathname and two `endsWith` suffixes. A symlink path matches
 * none of them, so `main()` never ran and the command exited 0 in silence.
 *
 * ## 2. `--host` was meaningless — the default was the opposite of the documented
 *
 * `--help` says "127.0.0.1 (default) · 0.0.0.0 exposes the UI to your network".
 * The default was `process.env.TEAPOT_HOST`, i.e. UNDEFINED, and an undefined
 * hostname makes `@hono/node-server` bind EVERY interface. So the default DID
 * expose the UI to the network.
 *
 * Measured before the fix, with no `--host` at all: the server answered on the
 * machine's LAN address as well as loopback.
 *
 * These are behavioural and are exercised by actually starting the built server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { useTempDirs } from "./helpers/tmp.ts";
import { freePort } from "./helpers/free-port.ts";
import { readSource } from "./helpers/source.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const indexSrc = readSource(path.join(repo, "src", "index.ts"));
const masterSrc = readSource(path.join(repo, "src", "master.ts"));

/** a non-loopback IPv4 address, if this host has one */
function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

/** run the built CLI and resolve once it prints the listening line */
async function startServer(args: string[], dataDir: string): Promise<{ proc: import("node:child_process").ChildProcess; port: number; log: string }> {
  const entry = path.join(repo, "dist", "index.js");
  assert.ok(existsSync(entry), "precondition: dist is built");
  const port = await freePort();
  const proc = spawn(process.execPath, [entry, "--port", String(port), ...args], {
    env: { ...process.env, TEAPOT_DATA_DIR: dataDir, TEAPOT_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let log = "";
    const t = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 30_000);
    const onData = (d: Buffer) => {
      log += d.toString();
      if (log.includes("master listening on")) {
        clearTimeout(t);
        resolve({ proc, port, log });
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (c) => {
      clearTimeout(t);
      reject(new Error(`server exited early (${c}):\n${log}`));
    });
  });
}

async function reachable(port: number, host: string, ms = 2500): Promise<boolean> {
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), ms);
    const r = await fetch(`http://${host}:${port}/api/version`, { signal: ac.signal });
    clearTimeout(to);
    return r.status > 0;
  } catch {
    return false;
  }
}

/* ---------- 1. the entry point ---------- */

test("the entry-point check resolves a bin SYMLINK (#140)", () => {
  // the bug was comparing argv[1] to import.meta.url's pathname: through
  // node_modules/.bin they are different files
  assert.match(
    indexSrc,
    /realpathSync\(arg\)/,
    "argv[1] must be resolved, or a symlinked bin never matches (#140)",
  );
  assert.match(
    indexSrc,
    /realpathSync\(fileURLToPath\(import\.meta\.url\)\)/,
    "and so must the module's own path (#140)",
  );
  assert.doesNotMatch(
    indexSrc,
    /import\.meta\.url\)\.pathname/,
    "URL.pathname is what produced the mismatch in the first place (#140)",
  );
});

test("the published bin actually starts (#140)", async () => {
  // end-to-end: spawn the way npm does, THROUGH a symlink named `teapot`
  await useTempDirs(["t140a-"], async ([dataDir]) => {
    const binDir = mkdtempSync(path.join(os.tmpdir(), "t140bin-"));
    const link = path.join(binDir, "teapot");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(path.join(repo, "dist", "index.js"), link);
    const port = await freePort();
    const proc = spawn(link, ["--port", String(port)], {
      env: { ...process.env, TEAPOT_DATA_DIR: dataDir!, TEAPOT_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const ok = await new Promise<boolean>((resolve) => {
        let log = "";
        const t = setTimeout(() => resolve(false), 30_000);
        const onData = (d: Buffer) => {
          log += d.toString();
          if (log.includes("master listening on")) {
            clearTimeout(t);
            resolve(true);
          }
        };
        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", onData);
        proc.on("exit", () => {
          clearTimeout(t);
          resolve(false);
        });
      });
      assert.ok(ok, `the symlinked bin must boot (#140); it printed nothing and exited`);
    } finally {
      proc.kill("SIGTERM");
    }
  });
});

/* ---------- 2. the default host ---------- */

test("the default host is loopback, not undefined (#140)", () => {
  // undefined made @hono/node-server bind every interface, which is the opposite
  // of what --help advertises
  assert.match(
    masterSrc,
    /host:\s*process\.env\.TEAPOT_HOST \?\? "127\.0\.0\.1"/,
    "the default must BE the documented default (#140)",
  );
});

test("the default binds loopback only (#140)", async () => {
  const lan = lanAddress();
  await useTempDirs(["t140b-"], async ([dataDir]) => {
    const { proc, port } = await startServer([], dataDir!);
    try {
      assert.ok(await reachable(port, "127.0.0.1"), "loopback must serve (#140)");
      if (lan) {
        assert.equal(
          await reachable(port, lan),
          false,
          `and the LAN address must NOT (#140): ${lan} answered, so the UI is exposed`,
        );
      }
    } finally {
      proc.kill("SIGTERM");
    }
  });
});

test("--host 0.0.0.0 still opts into exposure (#140)", async () => {
  // the fix must not make --host meaningless — that was the second half of the
  // report
  const lan = lanAddress();
  await useTempDirs(["t140c-"], async ([dataDir]) => {
    const { proc, port, log } = await startServer(["--host", "0.0.0.0"], dataDir!);
    try {
      assert.match(log, /all interfaces/, "and it must SAY so (#140)");
      assert.ok(await reachable(port, "127.0.0.1"), "loopback still serves (#140)");
      if (lan) {
        assert.ok(await reachable(port, lan), `--host 0.0.0.0 must expose the LAN (#140): ${lan}`);
      }
    } finally {
      proc.kill("SIGTERM");
    }
  });
});
