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
import { executeTool, type ToolContext } from "../src/agent/tools.ts";

const REPO_BUNDLED_SKILLS = path.join(new URL("..", import.meta.url).pathname, "skills");

test("bundled repo skills are discoverable via the bundled root", async () => {
  const skills = await discoverSkills([{ dir: REPO_BUNDLED_SKILLS, source: "bundled" }]);
  const byName = new Map(skills.map((s) => [s.name, s]));
  assert.ok(byName.has("qa-adversarial"), "qa-adversarial missing");
  assert.ok(byName.has("gyaru-review"), "gyaru-review missing");
  assert.equal(byName.get("qa-adversarial")?.source, "bundled");
});

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

test("save_skill stores globally; overwrite-safe; warns on workspace shadow", async () => {
  const { executeTool } = await import("../src/agent/tools.ts");
  const ws = await mkdtemp(path.join(tmpdir(), "sk-ws-"));
  const globalDir = await mkdtemp(path.join(tmpdir(), "sk-gl-"));
  await mkdir(path.join(ws, "skills"), { recursive: true });
  const ctx: ToolContext = {
    cwd: ws,
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 10_000,
    skillRoots: [
      { dir: path.join(ws, "skills"), source: "workspace" },
      { dir: globalDir, source: "global" },
    ],
  };
  // lands in the GLOBAL root even though a workspace root is configured
  const r1 = await executeTool("save_skill", JSON.stringify({ name: "deploy", description: "d1", content: "# v1" }), ctx);
  assert.equal(r1.ok, true);
  assert.match(r1.result, /sk-gl-/);
  const p1 = path.join(globalDir, "deploy", "SKILL.md");
  assert.match(await readFile(p1, "utf8"), /# v1/);

  // same-name save overwrites cleanly (no corruption, no duplicate dirs)
  const r2 = await executeTool("save_skill", JSON.stringify({ name: "deploy", description: "d2", content: "# v2" }), ctx);
  assert.equal(r2.ok, true);
  assert.match(await readFile(p1, "utf8"), /# v2/);

  // a same-name WORKSPACE skill shadows the global one at load time — the
  // result must say so instead of silently saving an unused copy
  await mkdir(path.join(ws, "skills", "deploy"), { recursive: true });
  await writeFile(path.join(ws, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: ws\n---\nws version\n");
  const r3 = await executeTool("save_skill", JSON.stringify({ name: "deploy", description: "d3", content: "# v3" }), ctx);
  assert.equal(r3.ok, true);
  assert.match(r3.result, /takes precedence/);
});
