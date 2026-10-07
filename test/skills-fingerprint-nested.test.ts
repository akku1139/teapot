/**
 * スキル fingerprint が入れ子の SKILL.md を捕捉しない。
 *
 * 探索（discoverSkills）は深さ ≤4 の任意の SKILL.md を skill として採用する
 * のに対し、skillRootsFingerprint は各 root の直下1階層の <name>/SKILL.md しか
 * stat しない。`group/nested/SKILL.md` を追加・編集しても root の mtime も
 * 1階層目の SKILL.md（存在しない）も変わらず、stamp が不変 → refreshSkills が
 * early return し、そのスキルは list_skills や system prompt のカタログに
 * 永遠に反映されない。
 *
 * Required: fingerprint は探索と同じ範囲（深さ ≤4 の全 SKILL.md）を追跡する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { skillRootsFingerprint } from "../src/agent/skills.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("adding a NESTED skill changes the fingerprint (cache invalidation)", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skf-"));
  const dir = path.join(root, "skills");
  await (await import("node:fs/promises")).mkdir(path.join(dir, "one"), { recursive: true });
  await (await import("node:fs/promises")).writeFile(
    path.join(dir, "one", "SKILL.md"),
    "---\nname: one\ndescription: t\n---\nbody",
  );
  const roots = [{ dir, source: "workspace" }];
  const f1 = await skillRootsFingerprint(roots);

  // a NESTED skill appears (discovery adopts it — depth ≤ 4)
  await (await import("node:fs/promises")).mkdir(path.join(dir, "group", "nested"), { recursive: true });
  await (await import("node:fs/promises")).writeFile(
    path.join(dir, "group", "nested", "SKILL.md"),
    "---\nname: nested\ndescription: t\n---\nbody",
  );
  const f2 = await skillRootsFingerprint(roots);
  assert.notEqual(f2, f1, "a nested skill's addition must invalidate the stamp");

  // and EDITING that nested SKILL.md invalidates again (mtime bump)
  await wait(30);
  await (await import("node:fs/promises")).writeFile(
    path.join(dir, "group", "nested", "SKILL.md"),
    "---\nname: nested\ndescription: t2\n---\nbody2",
  );
  const f3 = await skillRootsFingerprint(roots);
  assert.notEqual(f3, f2, "a nested skill's edit must invalidate the stamp");
});
