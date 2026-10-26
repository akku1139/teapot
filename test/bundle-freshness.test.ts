import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import path from "node:path";
import { useTempDir } from "./helpers/tmp.ts";
import { bundleFreshness, bundleInputs, freshnessMessage } from "./helpers/bundle-freshness.ts";

function project(root: string, opts: { bundle?: boolean; sourceAges: Record<string, number>; bundleAge?: number }): void {
  mkdirSync(path.join(root, "frontend"), { recursive: true });
  mkdirSync(path.join(root, "public", "assets"), { recursive: true });
  const now = Date.now();
  const bundleAge = opts.bundleAge ?? 0;
  if (opts.bundle !== false) {
    const p = path.join(root, "public", "assets", "index-abc123.js");
    writeFileSync(p, "bundle");
    utimesSync(p, new Date(now - bundleAge), new Date(now - bundleAge));
  }
  for (const [rel, age] of Object.entries(opts.sourceAges)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, "// src");
    utimesSync(p, new Date(now - age), new Date(now - age));
  }
}

test("no bundle is reported missing, not silently fresh (#75)", async () => {
  await useTempDir("bf-", (root) => { project(root, { bundle: false, sourceAges: { "frontend/App.tsx": 0 } });
    assert.equal(bundleFreshness(root).state, "missing");
  });
});

test("a bundle older than its sources is STALE (#75)", async () => {
  await useTempDir("bf-", (root) => {
    project(root, { bundleAge: 600_000, sourceAges: { "frontend/App.tsx": 60_000 } });
    assert.equal(bundleFreshness(root).state, "stale");
  });
});

test("the NEWEST source is the one that decides (#75)", async () => {
  await useTempDir("bf-", (root) => {
    project(root, {
      bundleAge: 300_000, 
      sourceAges: {
        "frontend/md.js": 86_400_000, 
        "frontend/App.tsx": 60_000, 
      },
    });
    const f = bundleFreshness(root);
    assert.equal(f.state, "stale", "the newest source decides staleness (#75)");
    assert.match(f.newestSource ?? "", /App\.tsx$/, "and the report names it (#75)");
  });
});

test("a bundle newer than every source is fresh (#75)", async () => {
  await useTempDir("bf-", (root) => {
    project(root, { bundleAge: 0, sourceAges: { "frontend/App.tsx": 120_000 } });
    assert.equal(bundleFreshness(root).state, "fresh");
  });
});

test("a same-second edit does not count as stale (#75)", async () => {
  await useTempDir("bf-", (root) => {
    project(root, { bundleAge: 0, sourceAges: { "frontend/App.tsx": 0 } });
    assert.equal(bundleFreshness(root).state, "fresh", "coarse timestamps must not produce false alarms (#75)");
  });
});

test("every bundle input is considered (#75)", async () => {
  await useTempDir("bf2-", (root) => {
  mkdirSync(path.join(root, "frontend", "deep"), { recursive: true });
  mkdirSync(path.join(root, "public", "assets"), { recursive: true });
  const now = Date.now();
  const b = path.join(root, "public", "assets", "index-1.js");
  writeFileSync(b, "b");
  utimesSync(b, new Date(now), new Date(now));
  writeFileSync(path.join(root, "index.html"), "h");
  writeFileSync(path.join(root, "vite.config.ts"), "v");
  writeFileSync(path.join(root, "frontend", "deep", "App.tsx"), "a");
  const inputs = bundleInputs(root).map((p) => path.relative(root, p).split(path.sep).join("/"));
  assert.ok(inputs.includes("frontend/deep/App.tsx"), "nested sources count (#75)");
  assert.ok(inputs.includes("index.html"), "index.html counts (#75)");
  assert.ok(inputs.includes("vite.config.ts"), "the vite config counts (#75)");
  });
});

test("the message says what to do (#75)", async () => {
  await useTempDir("bf-", (root) => {
    project(root, { bundleAge: 600_000, sourceAges: { "frontend/App.tsx": 60_000 } });
    const m = freshnessMessage(bundleFreshness(root));
    assert.match(m, /pnpm build/, "the stale message must name the fix (#75)");
    assert.match(m, /App\.tsx/, "and the offending file (#75)");
  });
  await useTempDir("bf-", (root) => {
    project(root, { bundle: false, sourceAges: {} });
    const missing = freshnessMessage(bundleFreshness(root));
    assert.match(missing, /pnpm build/, "the missing message must name the fix (#75)");
    assert.match(missing, /NOTHING|proves/i, "and say the suite is not testing the UI (#75)");
  });
});

test("the newest bundle wins when several exist (#75)", async () => {
  await useTempDir("bf3-", (root) => {
  mkdirSync(path.join(root, "frontend"), { recursive: true });
  mkdirSync(path.join(root, "public", "assets"), { recursive: true });
  const now = Date.now();
  const old = path.join(root, "public", "assets", "index-old.js");
  const fresh = path.join(root, "public", "assets", "index-new.js");
  writeFileSync(old, "o");
  writeFileSync(fresh, "n");
  utimesSync(old, new Date(now - 600_000), new Date(now - 600_000));
  utimesSync(fresh, new Date(now), new Date(now));
  const src = path.join(root, "frontend", "App.tsx");
  writeFileSync(src, "s");
  utimesSync(src, new Date(now - 300_000), new Date(now - 300_000));
  assert.equal(bundleFreshness(root).state, "fresh");
  });
});
