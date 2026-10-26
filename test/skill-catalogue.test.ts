import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" } as any;

function seedSkill(ws: string, name: string, description: string) {
  const dir = path.join(ws, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps here.`,
  );
  return { dir: path.join(ws, "skills"), source: "workspace" as const };
}

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
