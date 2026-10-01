/**
 * #31 — "Skill Discovery: right now the AI has a hard time finding skills."
 *
 * The system prompt named the skill TOOLS (`list_skills()` / `load_skill()`)
 * but never the skills themselves. AGENTS.md and the workspace listing were
 * injected; the catalogue was not. So the only way to discover a skill was to
 * spend a tool call on list_skills() — and a model that does not know a skill
 * exists has no reason to look.
 *
 * The catalogue is injected ONCE, alongside AGENTS.md and the workspace
 * snapshot, because SYSTEM_TEMPLATE must stay byte-identical per session or the
 * provider prefix cache is re-priced on every turn (#14's constraint). That is
 * a real trade: a skill saved mid-session does not appear until the next
 * session — but list_skills() still reports it, and re-rendering the prompt
 * each turn would cost far more than it is worth.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" } as any;

/** write a workspace skill and return its root */
function seedSkill(ws: string, name: string, description: string) {
  const dir = path.join(ws, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps here.`,
  );
  return { dir: path.join(ws, "skills"), source: "workspace" as const };
}

/** run N turns, returning the system prompt of each */
async function promptsOverTurns(
  ws: string,
  sessionDir: string,
  roots: { dir: string; source: string }[],
  turns: number,
): Promise<string[]> {
  const seen: string[] = [];
  const agent = new Agent({
    id: "t",
    workspace: ws,
    sessionDir,
    llm: LLM,
    skillRoots: roots,
    chatFn: async (_c: unknown, m: any): Promise<LlmResult> => {
      seen.push(String(m[0]?.content ?? ""));
      return { message: { role: "assistant", content: "ok" } };
    },
    autoContinue: false,
  } as never);
  await agent.init();
  await agent.setGoal("g");
  for (let i = 0; i < turns; i++) {
    agent.enqueuePrompt(`go ${i}`);
    agent.start("t");
    await agent.settled();
  }
  await agent.dispose();
  return seen;
}

test("available skills are listed in the system prompt (#31)", async () => {
  await useTempDirs(["sk31a-", "sk31b-", "sk31c-"], async ([_d, ws, sd]) => {
    const roots = [seedSkill(ws, "db-migration", "Safely migrate a Postgres schema.")];
    const [first] = await promptsOverTurns(ws, sd, roots, 1);
    // the point of the issue: the model can SEE the skill without a tool call
    assert.match(first!, /## Skills available in this workspace/, "no catalogue in the prompt (#31)");
    assert.ok(first!.includes("db-migration"), "the skill name must be listed (#31)");
    assert.ok(
      first!.includes("Safely migrate a Postgres schema."),
      "the description must be listed — that is what the model matches against (#31)",
    );
  });
});

test("the catalogue tells the model how to load one (#31)", async () => {
  await useTempDirs(["sk31d-", "sk31e-", "sk31f-"], async ([_d, ws, sd]) => {
    const roots = [seedSkill(ws, "release-notes", "Write release notes from git log.")];
    const [first] = await promptsOverTurns(ws, sd, roots, 1);
    assert.ok(
      first!.includes("load_skill(name, instructions)"),
      "the catalogue must point at the loader, not just list names (#31)",
    );
    assert.ok(first!.includes("list_skills()"), "the detail tool stays discoverable (#31)");
  });
});

test("no catalogue block when there are no skills (#31)", async () => {
  await useTempDirs(["sk31g-", "sk31h-", "sk31i-"], async ([_d, ws, sd]) => {
    const [first] = await promptsOverTurns(ws, sd, [], 1);
    assert.doesNotMatch(
      first!,
      /## Skills available in this workspace/,
      "an empty catalogue section would be noise in every request (#31)",
    );
  });
});

test("the system prompt stays byte-identical across turns (#31, prefix cache)", async () => {
  // SYSTEM_TEMPLATE must not change per request or the provider prefix cache
  // is re-priced every turn (#14). The catalogue is injected once for exactly
  // this reason.
  await useTempDirs(["sk31j-", "sk31k-", "sk31l-"], async ([_d, ws, sd]) => {
    const roots = [seedSkill(ws, "s1", "does a thing")];
    const prompts = await promptsOverTurns(ws, sd, roots, 3);
    assert.equal(prompts.length, 3);
    assert.equal(
      new Set(prompts).size,
      1,
      `the system prompt changed between turns — prefix cache would be re-priced (#31):\n${prompts
        .map((p, i) => `--- turn ${i} ---\n${p.slice(-160)}`)
        .join("\n")}`,
    );
  });
});

test("a skill created mid-session does not mutate the frozen prompt (#31)", async () => {
  // the deliberate trade: list_skills() reports the new skill, the frozen
  // system prompt does not change. This pins that so a future "improvement"
  // that injects per-turn does not silently re-price every request.
  await useTempDirs(["sk31m-", "sk31n-", "sk31o-"], async ([_d, ws, sd]) => {
    const roots = [seedSkill(ws, "s1", "does a thing")];
    const seen: string[] = [];
    const agent = new Agent({
      id: "t",
      workspace: ws,
      sessionDir: sd,
      llm: LLM,
      skillRoots: roots,
      chatFn: async (_c: unknown, m: any): Promise<LlmResult> => {
        seen.push(String(m[0]?.content ?? ""));
        return { message: { role: "assistant", content: "ok" } };
      },
      autoContinue: false,
    } as never);
    await agent.init();
    await agent.setGoal("g");
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    const first = seen[0]!;
    seedSkill(ws, "s2", "another thing");
    agent.enqueuePrompt("go2");
    agent.start("t");
    await agent.settled();
    assert.equal(
      seen[seen.length - 1],
      first,
      "the prompt must stay frozen when a skill appears (#31)",
    );
    await agent.dispose();
  });
});
