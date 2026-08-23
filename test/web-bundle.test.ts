/**
 * Guard against load-time crashes in the built web bundle (e.g. the
 * createMemo-declares-before-dependency TDZ regression shipped once).
 *
 * The bundle is loaded in a CHILD PROCESS (scripts/smoke-web.mjs): the app's
 * reconnect timers would otherwise keep this test's event loop alive forever.
 * Runs only when a built bundle exists — `pnpm build` produces it, so CI
 * always has one; a bare local `pnpm test` simply skips.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;

test("web bundle: module init + first render survive", async (t) => {
  const assetsDir = path.join(root, "public", "assets");
  const hasBundle =
    fs.existsSync(assetsDir) &&
    fs.readdirSync(assetsDir).some((f) => f.startsWith("index-") && f.endsWith(".js"));
  if (!hasBundle) return t.skip("no built bundle (run pnpm build)");

  const child = spawn(
    process.execPath,
    [path.join(root, "scripts", "smoke-web.mjs"), assetsDir],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));

  const code = await Promise.race([
    new Promise<number | null>((res) => child.on("exit", res)),
    new Promise<null>((_, rej) =>
      setTimeout(() => {
        child.kill("SIGKILL");
        rej(new Error("smoke test timed out after 15s"));
      }, 15_000),
    ),
  ]);
  assert.equal(code, 0, `bundle smoke test failed:\n${out}`);
});
