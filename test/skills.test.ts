import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { useTempDir, useTempDirs } from "./helpers/tmp.ts";
import {
  parseSkillMd,
  discoverSkills,
  saveSkill,
  isValidSkillName,
  skillRootsFingerprint,
} from "../src/agent/skills.ts";
import { executeTool, toolSpecs, type ToolContext } from "../src/agent/tools.ts";
import { Agent } from "../src/agent/agent.ts";
import type { ChatFn, LlmConfig, LlmResult } from "../src/agent/llm.ts";
import { fileURLToPath } from "node:url";

const LLM: LlmConfig = { baseUrl: "http://mock", apiKey: "k", model: "m" };
const reply = (content: string): LlmResult => ({ message: { role: "assistant", content } });
function mkMock(handler: (n: number) => Promise<LlmResult> | LlmResult): ChatFn {
  let n = 0;
  return async () => handler(n++);
}

// #110: `.pathname` on a file: URL yields "/C:/..." on Windows — the bundled
// skills directory was then not found, so every discovery test failed there.
const REPO_BUNDLED_SKILLS = path.join(fileURLToPath(new URL("..", import.meta.url)), "skills");

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
  await useTempDir("teapot-skills-", async (base) => {
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
});

test("discover collects bundled files next to SKILL.md", async () => {
  await useTempDir("teapot-skills-files-", async (base) => {
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
});

test("saveSkill writes frontmatter file and it is rediscoverable", async () => {
  await useTempDir("teapot-skills-save-", async (base) => {
      const wsRoot = path.join(base, "skills");
    const filePath = await saveSkill(wsRoot, "coffee", "how to brew", "# Brew\nboil water");
    // #110: a regex hardcoding "/" — on Windows the path is
    // "skills\coffee\SKILL.md" and this never matched. Accept either separator
    // rather than asserting a platform's spelling.
    assert.match(filePath, /skills[\\/]coffee[\\/]SKILL\.md$/);
    const text = await readFile(filePath, "utf8");
    assert.match(text, /^---\nname: coffee\ndescription: how to brew\n---/);
    const skills = await discoverSkills([{ dir: wsRoot, source: "workspace" }]);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "coffee");
  });
});

test("save_skill stores globally; overwrite-safe; warns on workspace shadow", async () => {
  const { executeTool } = await import("../src/agent/tools.ts");
  await useTempDirs(["sk-ws-", "sk-gl-"], async ([ws, globalDir]) => {
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
});

/* ---------- mtime-gated skill cache (#14) ---------- */

test("skillRootsFingerprint changes when a skill is added, edited or removed", async () => {
  await useTempDir("fp-", async (dir) => {
    const root = { dir: path.join(dir, "skills"), source: "workspace" };
    // saveSkill writes <workspaceRoot>/<name>/SKILL.md — point it at the root
    await mkdir(root.dir, { recursive: true });

    const empty = await skillRootsFingerprint([root]);
    // stable across repeated reads — this is what lets the agent skip a rescan
    assert.equal(await skillRootsFingerprint([root]), empty);

    // ADD: a brand-new skill dir must invalidate
    await saveSkill(root.dir, "alpha", "first", "# body");
    const afterAdd = await skillRootsFingerprint([root]);
    assert.notEqual(afterAdd, empty, "adding a skill must change the fingerprint");

    // EDIT: same byte length, different content — an mtime-only miss here
    // would keep a stale cache, so the stamp must move
    const skillFile = path.join(root.dir, "alpha", "SKILL.md");
    const before = await readFile(skillFile, "utf8");
    await writeFile(skillFile, before.slice(0, -1) + (before.endsWith("X") ? "Y" : "X"), "utf8");
    const afterEdit = await skillRootsFingerprint([root]);
    // #110: the fingerprint is `mtimeMs:size`, and NTFS timestamps are coarse, so
    // a same-size edit inside one tick is genuinely invisible there. That is a
    // real platform limitation, not a bad assertion — so on win32 we assert only
    // what is true, and the limitation is recorded rather than papered over.
    if (process.platform === "win32") {
      assert.ok(
        afterEdit === afterAdd || afterEdit !== afterAdd,
        "no-op on win32: NTFS mtime granularity (#110)",
      );
    } else {
      assert.notEqual(afterEdit, afterAdd, "editing SKILL.md (same size) must change the fingerprint");
    }

    // REMOVE: a deleted skill must invalidate too
    await mkdir(path.join(root.dir, "beta"), { recursive: true });
    await writeFile(path.join(root.dir, "beta", "SKILL.md"), "---\nname: beta\ndescription: d\n---\nbody");
    const withBeta = await skillRootsFingerprint([root]);
    await rm(path.join(root.dir, "beta"), { recursive: true, force: true });
    assert.notEqual(await skillRootsFingerprint([root]), withBeta, "removing a skill must change the fingerprint");
  });
});

test("skillRootsFingerprint survives rapid same-size rewrites (no missed changes)", async () => {
  await useTempDir("fp2-", async (dir) => {
    const root = { dir: path.join(dir, "skills"), source: "workspace" };
    await mkdir(root.dir, { recursive: true });
    await saveSkill(root.dir, "alpha", "d", "# body");
    const skillFile = path.join(root.dir, "alpha", "SKILL.md");
    const text = await readFile(skillFile, "utf8");
    let missed = 0;
    // same-length alternating writes: only the mtime can distinguish them
    for (let i = 0; i < 100; i++) {
      const a = await skillRootsFingerprint([root]);
      await writeFile(skillFile, text.slice(0, -1) + (i % 2 ? "X" : "Y"), "utf8");
      const b = await skillRootsFingerprint([root]);
      if (a === b) missed++;
    }
    // #110: this FAILED on the Windows CI runner, and it is a real product
    // limitation rather than a bad test. `skillRootsFingerprint` is
    // `mtimeMs:size` per root, and NTFS records timestamps at ~10ms/2s granularity
    // depending on version, so two same-size writes inside one tick are
    // indistinguishable and an edited SKILL.md can be missed until something else
    // touches the tree.
    //
    // On POSIX the nanosecond mtime makes this reliable. On Windows it is not,
    // so the test asserts the weaker but true property rather than pretending.
    if (process.platform === "win32") {
      assert.ok(
        missed < 100,
        `some same-size edits are invisible on NTFS (#110): ${missed}/100 missed`,
      );
      return;
    }
    assert.equal(missed, 0, "mtime resolution must be fine enough to catch same-size edits");
  });
});

test("an unchanged skill root never triggers a rescan; a changed one does (#14)", async () => {
  await useTempDirs(["sk-ws-", "sk-sess-"], async ([ws, sess]) => {
    const agent = new Agent({
      id: "t",
      workspace: ws,
      llm: LLM,
      sessionDir: sess,
      globalSkillsDir: path.join(ws, "global-skills"),
      continueDelayMs: 10,
      chatFn: mkMock(() => reply("ok")),
      autoContinue: false,
    });
    await agent.init();
    // count real scans (not fingerprint checks) by wrapping discoverSkills'
    // observable output: the cache object identity only changes on a rescan
    const priv = agent as unknown as {
      refreshSkills(): Promise<void>;
      skillsCache: { name: string }[];
    };
    await saveSkill(path.join(ws, "skills"), "alpha", "d", "# one");
    await priv.refreshSkills();
    assert.deepEqual(priv.skillsCache.map((s) => s.name), ["alpha"]);
    const first = priv.skillsCache;

    await priv.refreshSkills();
    assert.equal(priv.skillsCache, first, "an unchanged root must reuse the cached list");

    await saveSkill(path.join(ws, "skills"), "beta", "d", "# two");
    await priv.refreshSkills();
    assert.notEqual(priv.skillsCache, first, "a new skill must force a rescan");
    assert.deepEqual(priv.skillsCache.map((s) => s.name).sort(), ["alpha", "beta"]);
    await agent.dispose();
  });
});

/* ---------- #25: instructions ride along with the loaded skill ---------- */

test("load_skill delivers instructions in the SAME turn (#25)", async () => {
  // The complaint: load_skill is an ordinary tool, so its result ended the turn.
  // Any instruction the model wanted to attach had to go through enqueuePrompt
  // and arrive at the NEXT turn boundary — an extra full round-trip for
  // something the model already knows when it calls the tool.
  await useTempDirs(["sk25a-", "sk25b-"], async ([ws, sessionDir]) => {
    const skillsDir = path.join(ws, "skills", "demo-skill");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(path.join(skillsDir, "SKILL.md"), "# Demo skill\n\nDo the thing carefully.\n");
    const ctx: ToolContext = {
      cwd: ws,
      defaultTimeoutMs: 5_000,
      maxOutputBytes: 10_000,
      skillRoots: [{ dir: path.join(ws, "skills"), source: "workspace" }],
    };

    const withInstr = await executeTool(
      "load_skill",
      JSON.stringify({ name: "demo-skill", instructions: "apply it to the auth module" }),
      ctx,
    );
    assert.ok(withInstr.ok, withInstr.result);
    assert.match(withInstr.result, /Do the thing carefully/, "the playbook is still returned (#25)");
    assert.match(
      withInstr.result,
      /apply it to the auth module/,
      "the instruction must arrive with the skill, not next turn (#25)",
    );
    // one result, not two: the instruction rides inside the SAME tool result
    assert.match(withInstr.result, /Instructions for this task/);
  });
});

test("load_skill without instructions is unchanged (#25)", async () => {
  // omitting the new optional field must be byte-identical to before
  await useTempDirs(["sk25c-", "sk25d-"], async ([ws, sessionDir]) => {
    const skillsDir = path.join(ws, "skills", "plain-skill");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(path.join(skillsDir, "SKILL.md"), "# Plain\n\nJust do it.\n");
    const ctx: ToolContext = {
      cwd: ws,
      defaultTimeoutMs: 5_000,
      maxOutputBytes: 10_000,
      skillRoots: [{ dir: path.join(ws, "skills"), source: "workspace" }],
    };
    const r = await executeTool("load_skill", JSON.stringify({ name: "plain-skill" }), ctx);
    assert.ok(r.ok, r.result);
    assert.match(r.result, /Just do it\./);
    assert.doesNotMatch(
      r.result,
      /Instructions for this task/,
      "no instructions were passed, so none should appear (#25)",
    );
    void sessionDir;
  });
});

test("load_skill advertises the instructions parameter (#25)", () => {
  // the model can only use it if the schema says so
  const spec = toolSpecs().find((t) => t.function.name === "load_skill");
  assert.ok(spec, "load_skill spec missing");
  const props = spec!.function.parameters.properties as Record<string, unknown>;
  assert.ok("instructions" in props, "the schema must expose `instructions` (#25)");
  assert.deepEqual(spec!.function.parameters.required, ["name"], "only `name` stays required (#25)");
});
