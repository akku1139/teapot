/**
 * Boot must not scan skill roots per agent (#143).
 *
 * MEASURED: 493 agents each walking their roots recursively (readdir + stat) cost
 * 2120 ms of a 4.7 s boot — the single largest item once `EventLog.load()` was
 * fixed. Every one of those walks was redundant, which is what this pins:
 *
 *   - the turn loop calls `refreshSkills()` at the TOP of every turn, and the
 *     system prompt (which embeds the catalogue) is built after that
 *   - the `list_skills` tool calls it itself before reading the cache
 *   - `/api/agents/:id/skills` runs its own fresh `currentSkills()` walk
 *
 * A TTL/mtime cache was the obvious alternative and is WRONG here: the
 * fingerprint exists to notice a NESTED skill's add or edit, and neither changes
 * its root directory's mtime — so any time-based key reintroduces exactly the
 * staleness the walk was written to fix (test/skills-fingerprint-nested.test.ts
 * pins that, and it failed when this was first attempted).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource, stripSourceComments } from "./helpers/source.ts";

const agent = stripSourceComments(readSource(new URL("../src/agent/agent.ts", import.meta.url).pathname));
const skills = stripSourceComments(readSource(new URL("../src/agent/skills.ts", import.meta.url).pathname));

/** the body of init() */
function initBody(): string {
  const at = agent.indexOf("async init(): Promise<void> {");
  assert.notEqual(at, -1, "Agent.init() must exist");
  const end = agent.indexOf("\n  }", agent.indexOf("restoreSession", at));
  assert.notEqual(end, -1, "init() must terminate");
  return agent.slice(at, end);
}

test("init() does not scan skills (#143)", () => {
  assert.doesNotMatch(
    initBody(),
    /refreshSkills\(\)/,
    "the boot-time scan was redundant AND cost 2120ms across 493 agents (#143)",
  );
});

test("every reader of the skill cache refreshes it first (#143)", () => {
  // the paths that justify dropping the boot scan — if any of these stops
  // refreshing, the catalogue could go stale with nothing to fix it
  const turnLoop = agent.indexOf("await this.refreshSkills();");
  assert.notEqual(turnLoop, -1, "the turn loop must still refresh before building the prompt (#143)");
  const listSkills = agent.slice(agent.indexOf('call.function.name === "list_skills"'));
  assert.match(
    listSkills.slice(0, 200),
    /await this\.refreshSkills\(\)/,
    "the list_skills tool must refresh before reading the cache (#143)",
  );
});

test("the skill walk itself is not time-cached (#143)", () => {
  // a TTL/mtime cache here would hide a nested SKILL.md addition, which is the
  // bug the recursive walk exists to catch
  assert.doesNotMatch(
    skills,
    /WALK_TTL|walkCache|stampCache/,
    "caching the walk defeats the nested-skill detection it exists for (#143)",
  );
  assert.match(skills, /async function stampSkillFiles/, "the recursive fingerprint must stay");
});
