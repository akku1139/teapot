/**
 * #75 — `web-bundle.test.ts` skipped silently whenever there was no built
 * bundle, and `public/` is gitignored, so a bare local `pnpm test` reported
 * green while proving nothing about current UI code. CI builds first, which hid
 * it: injecting a render `ReferenceError` into `MessageRow` left the test
 * passing, and only a rebuild made it fail.
 *
 * These tests cover the detector itself, including the comparison bug it had on
 * first write — it compared against the OLDEST input, which is always older
 * than any build done afterwards, so it never fired. That failure was silent
 * and the tests would still have passed, which is why each case below asserts
 * the DETECTED state rather than just calling the function.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundleFreshness, bundleInputs, freshnessMessage } from "./helpers/bundle-freshness.ts";

/** a fake project root with a bundle and some sources */
function project(opts: { bundle?: boolean; sourceAges: Record<string, number>; bundleAge?: number }): string {
  const root = mkdtempSync(path.join(tmpdir(), "bf-"));
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
  return root;
}

test("no bundle is reported missing, not silently fresh (#75)", () => {
  const root = project({ bundle: false, sourceAges: { "frontend/App.tsx": 0 } });
  assert.equal(bundleFreshness(root).state, "missing");
});

test("a bundle older than its sources is STALE (#75)", () => {
  // the bundle was built 10 minutes ago; a source changed 1 minute ago
  const root = project({ bundleAge: 600_000, sourceAges: { "frontend/App.tsx": 60_000 } });
  assert.equal(bundleFreshness(root).state, "stale");
});

test("the NEWEST source is the one that decides (#75)", () => {
  // Regression guard. The first version compared against the OLDEST input,
  // which is always older than any build done afterwards — so it never fired,
  // silently. One very old source plus one newer than the bundle must be stale.
  const root = project({
    bundleAge: 300_000, // built 5 min ago
    sourceAges: {
      "frontend/md.js": 86_400_000, // a day old — irrelevant
      "frontend/App.tsx": 60_000, // newer than the bundle — this decides
    },
  });
  const f = bundleFreshness(root);
  assert.equal(f.state, "stale", "the newest source decides staleness (#75)");
  assert.match(f.newestSource ?? "", /App\.tsx$/, "and the report names it (#75)");
});

test("a bundle newer than every source is fresh (#75)", () => {
  const root = project({ bundleAge: 0, sourceAges: { "frontend/App.tsx": 120_000 } });
  assert.equal(bundleFreshness(root).state, "fresh");
});

test("a same-second edit does not count as stale (#75)", () => {
  // filesystem timestamp granularity is 1s on some systems; a source written
  // immediately after a build is not a real staleness signal
  const root = project({ bundleAge: 0, sourceAges: { "frontend/App.tsx": 0 } });
  assert.equal(bundleFreshness(root).state, "fresh", "coarse timestamps must not produce false alarms (#75)");
});

test("every bundle input is considered (#75)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bf2-"));
  mkdirSync(path.join(root, "frontend", "deep"), { recursive: true });
  mkdirSync(path.join(root, "public", "assets"), { recursive: true });
  const now = Date.now();
  const b = path.join(root, "public", "assets", "index-1.js");
  writeFileSync(b, "b");
  utimesSync(b, new Date(now), new Date(now));
  writeFileSync(path.join(root, "index.html"), "h");
  writeFileSync(path.join(root, "vite.config.ts"), "v");
  writeFileSync(path.join(root, "frontend", "deep", "App.tsx"), "a");
  const inputs = bundleInputs(root).map((p) => path.relative(root, p));
  assert.ok(inputs.includes("frontend/deep/App.tsx"), "nested sources count (#75)");
  assert.ok(inputs.includes("index.html"), "index.html counts (#75)");
  assert.ok(inputs.includes("vite.config.ts"), "the vite config counts (#75)");
});

test("the message says what to do (#75)", () => {
  const stale = project({ bundleAge: 600_000, sourceAges: { "frontend/App.tsx": 60_000 } });
  const m = freshnessMessage(bundleFreshness(stale));
  assert.match(m, /pnpm build/, "the stale message must name the fix (#75)");
  assert.match(m, /App\.tsx/, "and the offending file (#75)");
  const missing = freshnessMessage(bundleFreshness(project({ bundle: false, sourceAges: {} })));
  assert.match(missing, /pnpm build/, "the missing message must name the fix (#75)");
  assert.match(missing, /NOTHING|proves/i, "and say the suite is not testing the UI (#75)");
});

test("the newest bundle wins when several exist (#75)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bf3-"));
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
  // only the NEWEST bundle is the live one; judging by the old one would call
  // this stale for no reason
  assert.equal(bundleFreshness(root).state, "fresh");
});
