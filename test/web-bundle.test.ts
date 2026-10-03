/**
 * Guard against web-UI regressions in the built bundle.
 *
 * scripts/smoke-web.mjs loads the bundle inside happy-dom with /api stubbed:
 * 1. module init must survive (catches TDZ/order crashes like the
 *    "xe before initialization" regression);
 * 2. DEEP RENDER: a selected agent with events/stats/ctx mounts fully, so
 *    render-time ReferenceErrors on populated panels (the shipped
 *    "pct is not defined" crash) exit non-zero instead of reaching users.
 *
 * The bundle is loaded in a CHILD PROCESS: the app's reconnect timers would
 * otherwise keep this test's event loop alive forever. Runs only when a built
 * bundle exists — `pnpm build` produces it, so CI always has one; a bare local
 * `pnpm test` simply skips.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { bundleFreshness, freshnessMessage } from "./helpers/bundle-freshness.ts";

const root = new URL("..", import.meta.url).pathname;

/**
 * The gate the other two depend on.
 *
 * Both bundle tests SKIP when the bundle is missing or stale, because there is
 * nothing meaningful to run. A skip is invisible in a green suite — which is
 * precisely how #75 hid: `public/` is gitignored, a bare local `pnpm test`
 * skipped silently, and CI built first so it never saw the skip.
 *
 * So staleness gets its own FAILING test. The suite now goes red on a stale
 * bundle instead of quietly testing nothing, and the two smoke tests can keep
 * skipping, since this one has already made the problem loud.
 */
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
  // #75: this used to SKIP when there was no bundle — and `public/` is
  // gitignored, so a bare local `pnpm test` skipped silently and reported
  // green while testing nothing. CI runs `pnpm build` first, which hid it.
  //
  // A stale bundle is worse than a missing one: it PASSES its own smoke tests
  // while exercising code you have since changed. So both states now fail, with
  // the fix in the message.
  const fresh = bundleFreshness(root);
  if (fresh.state === "missing") return t.skip(freshnessMessage(fresh));
  if (fresh.state === "stale") return t.skip(freshnessMessage(fresh));
  const assetsDir = path.join(root, "public", "assets");

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
        rej(new Error("smoke test timed out after 30s"));
      }, 30_000),
    ),
  ]);
  assert.equal(code, 0, `bundle smoke test failed:\n${out}`);
});

/**
 * #50 — the same bundle at a NARROW viewport, where .rightbar is a fixed
 * drawer over the content instead of a grid column. The wide run above can
 * never reach that code path: the drawer styles live in a media query that
 * happy-dom does not evaluate, so "the panel is a column" is the only thing
 * it proves. This run drives the actual close paths (✕, click-outside, Esc)
 * against the rendered DOM.
 */
test("web bundle: the narrow-screen drawer can be closed (#50)", async (t) => {
  // #75: this used to SKIP when there was no bundle — and `public/` is
  // gitignored, so a bare local `pnpm test` skipped silently and reported
  // green while testing nothing. CI runs `pnpm build` first, which hid it.
  //
  // A stale bundle is worse than a missing one: it PASSES its own smoke tests
  // while exercising code you have since changed. So both states now fail, with
  // the fix in the message.
  const fresh = bundleFreshness(root);
  if (fresh.state === "missing") return t.skip(freshnessMessage(fresh));
  if (fresh.state === "stale") return t.skip(freshnessMessage(fresh));
  const assetsDir = path.join(root, "public", "assets");

  const child = spawn(
    process.execPath,
    [path.join(root, "scripts", "smoke-web.mjs"), assetsDir],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SMOKE_WIDTH: "900" } },
  );
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));

  const code = await Promise.race([
    new Promise<number | null>((res) => child.on("exit", res)),
    new Promise<null>((_, rej) =>
      setTimeout(() => {
        child.kill("SIGKILL");
        rej(new Error("narrow-viewport smoke test timed out after 30s"));
      }, 30_000),
    ),
  ]);
  assert.equal(code, 0, `narrow-viewport smoke test failed:\n${out}`);
});
