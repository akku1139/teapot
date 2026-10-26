import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { useTempDirs } from "./helpers/tmp.ts";
import { discoverSkills } from "../src/agent/skills.ts";

async function mkSkill(root: string, rel: string, name: string, desc = "d") {
  const dir = path.join(root, rel);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\nbody`,
  );
  return dir;
}

const names = (list: { name: string }[]) => list.map((s) => s.name).sort();

test("a skill nested two directories deep is discovered (#27)", async () => {
  await useTempDirs(["n27a-", "n27b-"], async ([root, _ws]) => {
    const s = path.join(root, "skills");
    await mkSkill(s, "stage1/template", "template-skill", "a nested skill");
    const got = await discoverSkills([{ dir: s, source: "workspace" }]);
    const found = got.find((x) => x.name === "template-skill");
    assert.ok(found, `nested skill not discovered; got ${JSON.stringify(names(got))} (#27)`);
    assert.equal(found!.description, "a nested skill");
    assert.equal(
      path.relative(s, found!.filePath),
      path.join("stage1", "template", "SKILL.md"),
      "must point at the real SKILL.md (#27)",
    );
  });
});

test("top-level and nested skills are discovered together (#27)", async () => {
  await useTempDirs(["n27c-", "n27d-"], async ([root]) => {
    const s = path.join(root, "skills");
    await mkSkill(s, "flat", "flat-skill");
    await mkSkill(s, "group/nested", "nested-skill");
    await mkSkill(s, "a/b/c", "deep-skill");
    const got = await discoverSkills([{ dir: s, source: "workspace" }]);
    assert.deepEqual(names(got), ["deep-skill", "flat-skill", "nested-skill"], "(#27)");
  });
});

test("a skill's bundled helper directories are not reported as skills (#27)", async () => {
  await useTempDirs(["n27e-", "n27f-"], async ([root]) => {
    const s = path.join(root, "skills");
    const dir = await mkSkill(s, "parent", "parent-skill");
    await writeFile(path.join(dir, "rollback.sh"), "#!/bin/sh\n");
    await mkdir(path.join(dir, "scripts"), { recursive: true });
    await writeFile(path.join(dir, "scripts", "helper.sh"), "#!/bin/sh\n");
    await mkdir(path.join(dir, "scripts", "deep"), { recursive: true });
    await writeFile(path.join(dir, "scripts", "deep", "x.txt"), "x");

    const got = await discoverSkills([{ dir: s, source: "workspace" }]);
    assert.deepEqual(names(got), ["parent-skill"], "payload dirs leaked as skills (#27)");
    assert.deepEqual(got[0]!.files, ["rollback.sh"], "bundled files next to SKILL.md (#27)");
  });
});

test("a root skills/SKILL.md index is not reported as a skill (#27)", async () => {
  await useTempDirs(["n27g-", "n27h-"], async ([root]) => {
    const s = path.join(root, "skills");
    await mkdir(s, { recursive: true });
    await writeFile(
      path.join(s, "SKILL.md"),
      "---\nname: skills-root\ndescription: index of every skill\n---\n\n# Index",
    );
    await mkSkill(s, "real", "real-skill");
    const got = await discoverSkills([{ dir: s, source: "workspace" }]);
    assert.deepEqual(names(got), ["real-skill"], "the root index leaked as a skill (#27)");
  });
});

test("a shallower skill wins over a nested namesake (#27)", async () => {
  await useTempDirs(["n27i-", "n27j-"], async ([root]) => {
    const s = path.join(root, "skills");
    await mkSkill(s, "dup", "dup-skill");
    await mkSkill(s, "group/dup", "dup-skill");
    const got = await discoverSkills([{ dir: s, source: "workspace" }]);
    assert.equal(got.length, 1, "one entry per name (#27)");
    assert.equal(
      path.relative(s, got[0]!.filePath),
      path.join("dup", "SKILL.md"),
      "the shallow skill must win over the nested namesake (#27)",
    );
  });
});

test("root priority still beats nesting (#27)", async () => {
  await useTempDirs(["n27k-", "n27l-"], async ([root]) => {
    const a = path.join(root, "A");
    const b = path.join(root, "B");
    await mkSkill(a, "x", "shared");
    await mkSkill(b, "deep/nested", "shared");
    const got = await discoverSkills([
      { dir: a, source: "workspace" },
      { dir: b, source: "global" },
    ]);
    assert.equal(got.length, 1);
    assert.equal(
      got[0]!.source,
      "workspace",
      "[0] must still win over a later root (#27)",
    );
  });
});

test("discovery stops at the depth bound (#27)", async () => {
  await useTempDirs(["n27m-", "n27n-"], async ([root]) => {
    const s = path.join(root, "skills");
    await mkSkill(s, "a/b/c/d/e/f/g/h/deep-skill", "deep-skill");
    const got = await discoverSkills([{ dir: s, source: "workspace" }]);
    assert.ok(
      !names(got).includes("deep-skill"),
      "an absurdly deep directory must not be walked forever (#27)",
    );
  });
});

test("a missing root is still skipped (#27)", async () => {
  await useTempDirs(["n27o-", "n27p-"], async ([root]) => {
    const s = path.join(root, "skills");
    await mkSkill(s, "one", "one-skill");
    const got = await discoverSkills([
      { dir: path.join(root, "does-not-exist"), source: "workspace" },
      { dir: s, source: "global" },
    ]);
    assert.deepEqual(names(got), ["one-skill"]);
  });
});

test("empty and hidden directories are ignored (#27)", async () => {
  await useTempDirs(["n27q-", "n27r-"], async ([root]) => {
    const s = path.join(root, "skills");
    await mkdir(path.join(s, ".hidden"), { recursive: true });
    await writeFile(path.join(s, ".hidden", "SKILL.md"), "---\nname: hidden\n---\nb");
    await mkdir(path.join(s, "empty-dir"), { recursive: true });
    await mkSkill(s, "visible", "visible-skill");
    const got = await discoverSkills([{ dir: s, source: "workspace" }]);
    assert.deepEqual(names(got), ["visible-skill"], "hidden dirs must stay hidden (#27)");
  });
});
