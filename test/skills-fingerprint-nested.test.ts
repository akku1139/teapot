import { test } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { skillRootsFingerprint } from "../src/agent/skills.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("adding a NESTED skill changes the fingerprint (cache invalidation)", async () => {
  const root = mkdtempInRootSync("skf-");
  const dir = path.join(root, "skills");
  await (await import("node:fs/promises")).mkdir(path.join(dir, "one"), { recursive: true });
  await (await import("node:fs/promises")).writeFile(
    path.join(dir, "one", "SKILL.md"),
    "---\nname: one\ndescription: t\n---\nbody",
  );
  const roots = [{ dir, source: "workspace" }];
  const f1 = await skillRootsFingerprint(roots);

  await (await import("node:fs/promises")).mkdir(path.join(dir, "group", "nested"), { recursive: true });
  await (await import("node:fs/promises")).writeFile(
    path.join(dir, "group", "nested", "SKILL.md"),
    "---\nname: nested\ndescription: t\n---\nbody",
  );
  const f2 = await skillRootsFingerprint(roots);
  assert.notEqual(f2, f1, "a nested skill's addition must invalidate the stamp");

  await wait(30);
  await (await import("node:fs/promises")).writeFile(
    path.join(dir, "group", "nested", "SKILL.md"),
    "---\nname: nested\ndescription: t2\n---\nbody2",
  );
  const f3 = await skillRootsFingerprint(roots);
  assert.notEqual(f3, f2, "a nested skill's edit must invalidate the stamp");
});
