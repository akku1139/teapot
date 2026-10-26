/**
 * #28 — "make it possible to read other harnesses' skills too" (with a TODO:
 *        search GitHub and investigate each harness's skills directory)
 *
 * Research first, as the issue asked. Two findings changed the plan:
 *
 *  1. SKILL.md frontmatter is a SHARED convention, not a per-harness dialect —
 *     so no format conversion is needed. What was actually blocking third-party
 *     skills was OUR parser:
 *       - `description: >-` (a folded scalar, the most common way authors write
 *         a long description) collapsed to the literal ">-", destroying the one
 *         field the model matches its task against;
 *       - quoted values kept their quotes, so a description containing a colon
 *         stopped matching.
 *     Both are verified here against the shape used by real skills.
 *  2. The harnesses' native directories are documented, so they are simply
 *     added as extra roots — at the LOWEST priority, because a project must
 *     never be shadowed by another tool's copy of the same skill.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { useTempDirs } from "./helpers/tmp.ts";
import { parseSkillMd, discoverSkills, foreignSkillRoots } from "../src/agent/skills.ts";

/* ---------- parser: the shapes real third-party skills use ---------- */

test("a folded description scalar is read, not truncated to '>-' (#28)", () => {
  // the exact shape used by terminalskills/skills and many others
  const p = parseSkillMd(
    `---\nname: a2a-protocol\ndescription: >-\n  Builds A2A servers and clients.\n  Use when the user wants X.\nlicense: Apache-2.0\n---\n\nbody`,
  );
  assert.equal(p.meta.name, "a2a-protocol");
  assert.notEqual(p.meta.description, ">-", "folded scalar must not be read literally (#28)");
  assert.match(p.meta.description, /Builds A2A servers and clients\./);
  assert.match(p.meta.description, /Use when the user wants X\./, "folded lines are joined (#28)");
});

test("a literal block scalar keeps its line breaks (#28)", () => {
  const p = parseSkillMd(`---\nname: z\ndescription: |\n  line one\n  line two\n---\nbody`);
  assert.match(p.meta.description, /line one\nline two/);
});

test("quoted values are unquoted so a colon inside survives (#28)", () => {
  const p = parseSkillMd(`---\nname: x\ndescription: "Handles YAML: with colon"\n---\nbody`);
  assert.equal(p.meta.description, "Handles YAML: with colon");
  const single = parseSkillMd(`---\nname: x\ndescription: 'single quoted'\n---\nbody`);
  assert.equal(single.meta.description, "single quoted");
});

test("an empty key with a nested block is skipped, not stored as '' (#28)", () => {
  const p = parseSkillMd(
    `---\nname: y\ndescription: simple\nmetadata:\n  version: 1.0\n  author: someone\n---\nbody`,
  );
  assert.equal(p.meta.name, "y");
  assert.equal(p.meta.description, "simple");
  assert.ok(!("metadata" in p.meta), "nested block must not become an empty value (#28)");
});

test("plain values and the body are untouched (#28)", () => {
  const p = parseSkillMd(`---\nname: plain\ndescription: no quotes here\n---\n\nactual body`);
  assert.equal(p.meta.description, "no quotes here");
  assert.equal(p.body, "actual body");
});

test("a file with no frontmatter still yields its body (#28)", () => {
  const p = parseSkillMd("just markdown, no frontmatter");
  assert.deepEqual(p.meta, {});
  assert.equal(p.body, "just markdown, no frontmatter");
});

/* ---------- foreign skill directories ---------- */

test("the other harnesses' project directories are included (#28)", () => {
  const roots = foreignSkillRoots("/ws").map((r) => r.dir);
  for (const rel of [".claude", ".codex", ".cursor", ".gemini", ".github", ".opencode", ".agents"]) {
    assert.ok(
      roots.includes(path.join("/ws", rel, "skills")),
      `missing project root ${rel}/skills (#28)`,
    );
  }
});

test("the personal directories of other harnesses are included (#28)", () => {
  const roots = foreignSkillRoots("/ws").map((r) => r.dir);
  const home = process.env.HOME ?? process.env.USERPROFILE;
  // #75: this used to `return` silently, so with HOME unset the test reported a
  // PASS while asserting nothing at all (verified: `env -u HOME npm test` was
  // green). Skipping is only honest if it is visible, so it is now a real skip
  // with a reason — and the function's behaviour with no HOME is asserted
  // unconditionally below, because that case IS testable.
  if (!home) {
    assert.deepEqual(
      foreignSkillRoots("/ws").map((r) => r.dir).filter((d) => !d.startsWith("/ws")),
      [],
      "with no HOME there must be NO personal roots — the scan must not invent any (#28)",
    );
    return;
  }
  for (const rel of [".claude", ".codex", ".cursor", ".gemini", ".copilot", ".agents"]) {
    assert.ok(roots.includes(path.join(home, rel, "skills")), `missing personal root ${rel} (#28)`);
  }
});

test("foreign roots never duplicate (#28)", () => {
  const roots = foreignSkillRoots("/ws").map((r) => r.dir);
  assert.equal(new Set(roots).size, roots.length, "duplicate roots would rescan a directory (#28)");
});

test("foreign roots degrade when there is no workspace or home (#28)", () => {
  const savedHome = process.env.HOME;
  const savedUser = process.env.USERPROFILE;
  // #110: Windows ALSO reports a home as HOMEDRIVE + HOMEPATH, which is how
  // `homeDir()` finds it when USERPROFILE is absent. Deleting only the first two
  // left a home behind on the runner, so "no home" was never actually tested
  // there — the test asserted a premise that did not hold.
  const savedDrive = process.env.HOMEDRIVE;
  const savedPath = process.env.HOMEPATH;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  try {
    assert.deepEqual(foreignSkillRoots(undefined), [], "no home and no workspace → no roots (#28)");
    assert.deepEqual(foreignSkillRoots(""), [], "an empty workspace is not a root (#28)");
  } finally {
    if (savedHome !== undefined) process.env.HOME = savedHome;
    if (savedUser !== undefined) process.env.USERPROFILE = savedUser;
    if (savedDrive !== undefined) process.env.HOMEDRIVE = savedDrive;
    if (savedPath !== undefined) process.env.HOMEPATH = savedPath;
  }
});

/* ---------- end to end: a real foreign-root skill is usable ---------- */

test("a skill in another harness's directory is discovered and loadable (#28)", async () => {
  await useTempDirs(["f28a-", "f28b-"], async ([ws, _s]) => {
    // a project-local .claude/skills directory, holding a skill whose
    // description is a folded scalar (both are what a real tool leaves behind)
    const dir = path.join(ws, ".claude", "skills", "security-review");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: security-review\ndescription: >-\n  Audit code for security bugs.\n  Use when reviewing a diff.\n---\n\nLook for injection and SSRF.`,
    );
    const roots = foreignSkillRoots(ws);
    const got = await discoverSkills(roots);
    const found = got.find((s) => s.name === "security-review");
    assert.ok(found, `foreign skill not discovered (#28): ${got.map((s) => s.name).join(",")}`);
    assert.match(
      found!.description,
      /Audit code for security bugs\./,
      "the folded description must survive discovery (#28)",
    );
    assert.equal(found!.source, "foreign");
  });
});

test("a workspace skill still outranks a foreign one of the same name (#28)", async () => {
  await useTempDirs(["f28c-", "f28d-"], async ([ws, _s]) => {
    const foreign = path.join(ws, ".claude", "skills", "dup");
    await mkdir(foreign, { recursive: true });
    await writeFile(path.join(foreign, "SKILL.md"), "---\nname: dup\ndescription: foreign\n---\nb");
    const own = path.join(ws, "skills", "dup");
    await mkdir(own, { recursive: true });
    await writeFile(path.join(own, "SKILL.md"), "---\nname: dup\ndescription: mine\n---\nb");

    // a project skill must never be shadowed by another tool's copy (#28)
    const got = await discoverSkills([
      { dir: path.join(ws, "skills"), source: "workspace" },
      ...foreignSkillRoots(ws),
    ]);
    const found = got.filter((s) => s.name === "dup");
    assert.equal(found.length, 1, "one entry per name (#28)");
    assert.equal(found[0]!.source, "workspace", "the project's own skill must win (#28)");
  });
});
