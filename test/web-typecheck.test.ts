import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
const tsconfig = path.join(root, "tsconfig.frontend.json");

test("frontend typecheck: no undefined identifiers / broken refs in web UI", () => {
  if (!fs.existsSync(tsc) || !fs.existsSync(tsconfig))
    return; 
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
