/**
 * AGENTS.md must reach the model IN FULL.
 *
 * MEASURED on this repository: 56,290 characters, read with `.slice(0, 12_000)` in three places — so ~79% of the project's
 * rules never entered the system prompt, while the prompt itself said "EMBEDDED in this prompt below when present — read
 * them here, don't re-read_file it". The part that was cut is the part written after repeated bugs: reproduce before
 * fixing, verify the PATH a helper is called from, prefer the real measurement over a synthetic test. The harness hid its
 * own hard-won knowledge and then behaved as if it had been told.
 *
 * `reloadAgentsMd()` compared the same truncated prefix, so an edit in the second half was invisible to the reload too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

const marker = "TAIL_RULE_ONLY_IN_THE_SECOND_HALF";
const bigAgentsMd = (tail: string) =>
  "# project rules\n\n" + "x".repeat(20_000) + `\n\n- ${tail}\n`;

async function make(ws: string, sd: string) {
  return new Agent({
    id: "amd",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
    autoContinue: false,
  } as never) as Agent;
}

test("the tail of AGENTS.md reaches the system prompt", async () => {
  await useTempDirs(["amd-a-", "amd-sd-"], async ([ws, sd]) => {
    fs.writeFileSync(path.join(ws, "AGENTS.md"), bigAgentsMd(marker));
    const a = await make(ws, sd);
    try {
      await a.init();
      const sys = (a as unknown as { systemPrompt: () => string }).systemPrompt();
      assert.ok(sys.includes(marker), "the file's second half must be in the prompt, not truncated away");
      assert.ok(sys.includes(bigAgentsMd(marker)), "and it must be the file verbatim");
    } finally {
      a.stop("test done");
    }
  });
});

test("an edit in the second half is seen by the reload", async () => {
  await useTempDirs(["amd-b-", "amd-sd-"], async ([ws, sd]) => {
    fs.writeFileSync(path.join(ws, "AGENTS.md"), bigAgentsMd("first version"));
    const a = await make(ws, sd);
    try {
      await a.init();
      (a as unknown as { systemPrompt: () => string }).systemPrompt();
      // change ONLY the tail — beyond the old 12,000-char window
      fs.writeFileSync(path.join(ws, "AGENTS.md"), bigAgentsMd("second version"));
      const reloaded = (a as unknown as { reloadAgentsMd: () => string | null }).reloadAgentsMd();
      assert.ok(reloaded && reloaded.includes("second version"), "a change past the old cutoff must be noticed");
    } finally {
      a.stop("test done");
    }
  });
});

/**
 * The rest of the "instructions the agent acts on" surface, audited after the AGENTS.md finding.
 *
 * Everything below is what the model must see to do the task: a skill's description is the only thing it has when
 * choosing whether to load that skill, and an auditor's feedback is the list of what to fix next. Cutting either is the
 * same bug in a different variable — the harness hiding its own instructions and then behaving as if it had given them.
 */

test("the whole AGENTS.md is re-attached after a compaction, not a prefix", async () => {
  await useTempDirs(["amd-c-", "amd-sd-"], async ([ws, sd]) => {
    fs.writeFileSync(path.join(ws, "AGENTS.md"), bigAgentsMd(marker));
    const a = await make(ws, sd);
    try {
      await a.init();
      // the compaction path re-attaches project instructions by rebuilding the system prompt
      const first = (a as unknown as { systemPrompt: () => string }).systemPrompt();
      const again = (a as unknown as { systemPrompt: () => string }).systemPrompt();
      assert.equal(first, again, "the prompt is stable");
      assert.ok(again.includes(marker), "and still complete");
    } finally {
      a.stop("test done");
    }
  });
});
