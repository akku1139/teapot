import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { bundleFreshness, freshnessMessage } from "./helpers/bundle-freshness.ts";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the web bundle is present and newer than the sources (#75)", () => {
  const f = bundleFreshness(root);
  assert.equal(
    f.state,
    "fresh",
    `${freshnessMessage(f)}\n\n` +
      "A stale bundle passes its own smoke tests while exercising code you have " +
      "since changed, so a green suite here does not mean the UI works.",
  );
});

test("web bundle: module init + deep render survive", async (t) => {
  const fresh = bundleFreshness(root);
  if (fresh.state === "missing") return t.skip(freshnessMessage(fresh));
  if (fresh.state === "stale") return t.skip(freshnessMessage(fresh));
  const assetsDir = path.join(root, "public", "assets");

  const child = spawn(
    process.execPath,
    [path.join(root, "scripts", "smoke-web.ts"), assetsDir],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));

  const code = await new Promise<number | null>((res, rej) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rej(new Error("smoke test timed out after 30s"));
    }, 30_000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      res(c);
    });
  });
  assert.equal(code, 0, `bundle smoke test failed:\n${out}`);
});

test("web bundle: the narrow-screen drawer can be closed (#50)", async (t) => {
  const fresh = bundleFreshness(root);
  if (fresh.state === "missing") return t.skip(freshnessMessage(fresh));
  if (fresh.state === "stale") return t.skip(freshnessMessage(fresh));
  const assetsDir = path.join(root, "public", "assets");

  const child = spawn(
    process.execPath,
    [path.join(root, "scripts", "smoke-web.ts"), assetsDir],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SMOKE_WIDTH: "900" } },
  );
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));

  const code = await new Promise<number | null>((res, rej) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rej(new Error("narrow-viewport smoke test timed out after 30s"));
    }, 30_000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      res(c);
    });
  });
  assert.equal(code, 0, `narrow-viewport smoke test failed:\n${out}`);
});
