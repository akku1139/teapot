/**
 * Type-check the frontend as part of the normal test suite.
 *
 * Why: vite/esbuild transpiles TSX WITHOUT checking it, and the root
 * tsconfig only covers src/** — so `pct is not defined` shipped once and
 * only exploded at render time in the browser. This test makes a bare
 * `pnpm test` fail on any undefined identifier / bad reference in
 * frontend/*.tsx even before anyone builds the bundle.
 *
 * CI additionally runs `pnpm typecheck-web` explicitly (fail-fast before
 * build); this file covers local runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
// the real JS entry (node_modules/.bin/* is a shell wrapper — not spawnable via execPath)
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
const tsconfig = path.join(root, "tsconfig.frontend.json");

test("frontend typecheck: no undefined identifiers / broken refs in web UI", () => {
  if (!fs.existsSync(tsc) || !fs.existsSync(tsconfig))
    return; // dependencies not installed — nothing to check locally
  const r = spawnSync(process.execPath, [tsc, "-p", tsconfig], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(
    r.status,
    0,
    `frontend typecheck failed:\n${(r.stdout ?? "") + (r.stderr ?? "")}`,
  );
});
