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
import { readSourceUrl, stripSourceComments } from "./helpers/source.ts";

const agent = stripSourceComments(readSourceUrl(new URL("../src/agent/agent.ts", import.meta.url)));
const _skills = stripSourceComments(readSourceUrl(new URL("../src/agent/skills.ts", import.meta.url)));

/** the body of init() */
function initBody(): string {
  const at = agent.indexOf("async init(): Promise<void> {");
  assert.notEqual(at, -1, "Agent.init() must exist");
  const end = agent.indexOf("\n  }", agent.indexOf("restoreSession", at));
  assert.notEqual(end, -1, "init() must terminate");
  return agent.slice(at, end);
}

