import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseSkillMd,
  discoverSkills,
  saveSkill,
  isValidSkillName,
} from "../src/agent/skills.ts";

test("frontmatter parsing", () => {
  const p = parseSkillMd("---\nname: foo\ndescription: does bar\n---\n\n# Steps\n1. do it\n");
  assert.equal(p.meta.name, "foo");
  assert.equal(p.meta.description, "does bar");
  assert.equal(p.body, "# Steps\n1. do it");

  // no frontmatter → body only
  const bare = parseSkillMd("just text");
  assert.deepEqual(bare.meta, {});
  assert.equal(bare.body, "just text");
});

test("skill name validation", () => {
  assert.ok(isValidSkillName("release-checklist"));
  assert.ok(isValidSkillName("a.b_c-2"));
  assert.ok(!isValidSkillName("Upper"));
  assert.ok(!isValidSkillName("-start"));
  assert.ok(!isValidSkillName(""));
  assert.ok(!isValidSkillName("a".repeat(65)));
});

test("discover merges roots with workspace priority and skips invalid dirs", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "teapot-skills-"));
  const ws = path.join(base, "ws-skills");
  const glob = path.join(base, "global");
  await mkdir(path.join(ws, "deploy"), { recursive: true });
  await mkdir(path.join(glob, "deploy"), { recursive: true }); // name clash: ws wins
  await mkdir(path.join(glob, ".hidden"), { recursive: true }); // ignored
  await mkdir(path.join(ws, "not-a-skill"), { recursive: true }); // no SKILL.md
  await mkdir(path.join(glob, "linting"), { recursive: true });
  await writeFile(path.join(ws, "deploy", "SKILL.md"), "---\nname: deploy\ndescription: ws version\n---\nbody");
  await writeFile(path.join(glob, "deploy", "SKILL.md"), "---\nname: deploy\ndescription: global version\n---\nbody");
  await writeFile(path.join(glob, "linting", "SKILL.md"), "---\nname: linting\ndescription: keep code clean\n---\nbody");

  const skills = await discoverSkills([
    { dir: ws, source: "workspace" },
    { dir: glob, source: "global" },
  ]);
  const byName = new Map(skills.map((s) => [s.name, s]));
  assert.equal(byName.get("deploy")?.description, "ws version");
  assert.equal(byName.get("deploy")?.source, "workspace");
  assert.equal(byName.get("linting")?.description, "keep code clean");
  assert.equal(byName.get("linting")?.source, "global");
  assert.ok(!byName.has("not-a-skill"));
});

test("discover collects bundled files next to SKILL.md", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "teapot-skills-files-"));
  const ws = path.join(base, "skills");
  await mkdir(path.join(ws, "deploy"), { recursive: true });
  await writeFile(path.join(ws, "deploy", "SKILL.md"), "---\nname: deploy\ndescription: d\n---\nbody");
  await writeFile(path.join(ws, "deploy", "rollback.sh"), "#!/bin/sh\necho hi");
  await writeFile(path.join(ws, "deploy", "notes.md"), "internal notes");
  await mkdir(path.join(ws, "deploy", "subdir"), { recursive: true }); // dirs are not files

  const skills = await discoverSkills([{ dir: ws, source: "workspace" }]);
  assert.equal(skills.length, 1);
  assert.deepEqual(skills[0].files, ["notes.md", "rollback.sh"]);
});

test("saveSkill writes frontmatter file and it is rediscoverable", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "teapot-skills-save-"));
  const wsRoot = path.join(base, "skills");
  const filePath = await saveSkill(wsRoot, "coffee", "how to brew", "# Brew\nboil water");
  assert.match(filePath, /skills\/coffee\/SKILL\.md$/);
  const text = await readFile(filePath, "utf8");
  assert.match(text, /^---\nname: coffee\ndescription: how to brew\n---/);
  const skills = await discoverSkills([{ dir: wsRoot, source: "workspace" }]);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "coffee");
});
