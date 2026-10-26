import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { isolatedBootEnv } from "./helpers/isolated-boot.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { useTempDirs } from "./helpers/tmp.ts";
import { freePort } from "./helpers/free-port.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");

const BOOT_TIMEOUT_MS = 60_000;

function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

async function startServer(args: string[], dataDir: string): Promise<{ proc: import("node:child_process").ChildProcess; port: number; log: string }> {
  const entry = path.join(repo, "dist", "index.js");
  assert.ok(existsSync(entry), "precondition: dist is built");
  const port = await freePort();
  const boot = isolatedBootEnv(dataDir, port);
  const proc = spawn(process.execPath, [entry, "--port", String(port), ...args], {
    env: { ...process.env, ...boot.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let log = "";
    const t = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), BOOT_TIMEOUT_MS);
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

test("the published bin actually starts (#140)", async (t) => {
  await useTempDirs(["t140a-"], async ([dataDir]) => {
    const binDir = mkdtempInRootSync("t140bin-");
    const link = path.join(binDir, "teapot");
    const { symlinkSync } = await import("node:fs");
    try {
      symlinkSync(path.join(repo, "dist", "index.js"), link);
    } catch (e) {
      t.skip(`cannot create a symlink here: ${(e as Error).message.slice(0, 60)}`);
      return;
    }
    const port = await freePort();
    const proc = spawn(process.execPath, [link, "--port", String(port)], {
      env: { ...process.env, ...isolatedBootEnv(dataDir!, port).env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const ok = await new Promise<boolean>((resolve) => {
        let log = "";
        const t = setTimeout(() => resolve(false), BOOT_TIMEOUT_MS);
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

test("the built entry point boots when run DIRECTLY, on every platform (#140)", async () => {
  await useTempDirs(["t140d-"], async ([dataDir]) => {
    const entry = path.join(repo, "dist", "index.js");
    assert.ok(existsSync(entry), "precondition: dist is built");
    const port = await freePort();
    const proc = spawn(process.execPath, [entry, "--port", String(port)], {
      env: { ...process.env, ...isolatedBootEnv(dataDir!, port).env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const ok = await new Promise<boolean>((resolve) => {
        let log = "";
        const timer = setTimeout(() => resolve(false), BOOT_TIMEOUT_MS);
        const onData = (d: Buffer) => {
          log += d.toString();
          if (log.includes("master listening on")) {
            clearTimeout(timer);
            resolve(true);
          }
        };
        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", onData);
        proc.on("exit", () => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      assert.ok(ok, `node dist/index.js must boot (#140); it printed nothing and exited`);
    } finally {
      proc.kill("SIGTERM");
    }
  });
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

function lanAddress6(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      const fam = String(a.family);
      if ((fam === "IPv6" || fam === "6") && !a.internal && !a.address.startsWith("fe80::")) {
        return a.address;
      }
    }
  }
  return null;
}

test("--host 0.0.0.0 must be DUAL-STACK, not IPv4-only (#158 report)", async () => {
  const v6 = lanAddress6();
  await useTempDirs(["t158c-"], async ([dataDir]) => {
    const { proc, port, log } = await startServer(["--host", "0.0.0.0"], dataDir!);
    try {
      assert.match(log, /all interfaces/, "it must still report exposure (#140)");
      assert.ok(await reachable(port, "127.0.0.1"), "IPv4 loopback must serve");
      assert.ok(
        await reachable(port, "[::1]"),
        "--host 0.0.0.0 must accept IPv6 too, or an IPv6 client cannot connect " +
          "(this is the reported tailscale failure)",
      );
      if (v6) {
        assert.ok(await reachable(port, `[${v6}]`), `--host 0.0.0.0 must expose the IPv6 LAN: ${v6}`);
      }
    } finally {
      proc.kill("SIGTERM");
    }
  });
});
