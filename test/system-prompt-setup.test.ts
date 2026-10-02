/**
 * #64 — "after compat, is AGENTS.md loaded properly? … also the other initial
 *        setup elements — read the code and confirm."
 *
 * The three elements captured once per session and baked into the system
 * prompt are AGENTS.md, the workspace snapshot, and the skills catalogue. They
 * share one code path, and the path is unusual: the values are PERSISTED to the
 * session dir and reused verbatim on restart, so a restart re-issues a
 * byte-identical system prompt and the provider's prefix cache survives.
 *
 * That is the design, and it is also where a bug would hide — anything captured
 * once is frozen for the life of the session, and a restart is exactly when a
 * stale or missing value would surface. So these tests drive a REAL agent
 * through: first run, restart over the same session dir, and an edit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const reply: LlmResult = { message: { role: "assistant", content: "ok" } };

/** a workspace + session dir that survive between "incarnations" */
async function fixture(agentsMd?: string, skill?: { name: string; description: string }) {
  const ws = await mkdtemp(path.join(tmpdir(), "p64-ws-"));
  const sd = await mkdtemp(path.join(tmpdir(), "p64-sd-"));
  if (agentsMd !== undefined) await writeFile(path.join(ws, "AGENTS.md"), agentsMd, "utf8");
  if (skill) {
    await mkdir(path.join(ws, "skills", skill.name), { recursive: true });
    await writeFile(
      path.join(ws, "skills", skill.name, "SKILL.md"),
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\nBody.`,
      "utf8",
    );
  }
  return { ws, sd, cleanup: () => Promise.all([rm(ws, { recursive: true, force: true }), rm(sd, { recursive: true, force: true })]) };
}

/** boot an agent, optionally restoring the session dir, and capture its system prompt */
async function promptFor(f: { ws: string; sd: string }, restore: boolean): Promise<string> {
  let seen = "";
  const agent = new Agent({
    id: "t",
    workspace: f.ws,
    sessionDir: f.sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
    chatFn: async (_c: unknown, messages: any) => {
      seen = String(messages[0]?.content ?? "");
      return reply;
    },
    autoContinue: false,
  } as any);
  await agent.init();
  if (restore) await agent.load();
  agent.enqueuePrompt("go");
  agent.start("t");
  await agent.settled();
  await agent.dispose();
  return seen;
}

/* ---------- AGENTS.md ---------- */

test("AGENTS.md reaches the system prompt (#64)", async () => {
  const f = await fixture("PROJECT_RULE_ABC");
  try {
    const p = await promptFor(f, false);
    assert.match(p, /## Project instructions \(AGENTS\.md\)/, "the block must be present (#64)");
    assert.match(p, /PROJECT_RULE_ABC/, "with the file's content (#64)");
  } finally {
    await f.cleanup();
  }
});

test("AGENTS.md survives a restart (#64)", async () => {
  // The restore path is a DIFFERENT branch of systemPrompt() from the first-run
  // path (it reads the persisted snapshot rather than re-listing), so it needs
  // its own coverage — this is what "after compat" is asking about.
  const f = await fixture("PROJECT_RULE_ABC");
  try {
    await promptFor(f, false); // first incarnation writes the snapshot
    const p = await promptFor(f, true);
    assert.match(p, /PROJECT_RULE_ABC/, "AGENTS.md must still be loaded after a restart (#64)");
  } finally {
    await f.cleanup();
  }
});

test("a workspace with NO AGENTS.md omits the block rather than sending an empty one (#64)", async () => {
  const f = await fixture(undefined);
  try {
    const p = await promptFor(f, false);
    assert.doesNotMatch(p, /## Project instructions/, "no block when there is no file (#64)");
  } finally {
    await f.cleanup();
  }
});

test("an AGENTS.md added after the first run is still picked up (#64)", async () => {
  // The snapshot freezes the LISTING, not AGENTS.md — so a late file must not
  // be lost. If someone ever moves AGENTS.md into the frozen path this fails.
  const f = await fixture(undefined);
  try {
    await promptFor(f, false);
    await writeFile(path.join(f.ws, "AGENTS.md"), "ADDED_LATE_RULE", "utf8");
    const p = await promptFor(f, true);
    assert.match(p, /ADDED_LATE_RULE/, "a late AGENTS.md must reach the prompt (#64)");
  } finally {
    await f.cleanup();
  }
});

/* ---------- the other setup elements ---------- */

test("the workspace snapshot is present and lists the workspace (#64)", async () => {
  const f = await fixture("R");
  try {
    await writeFile(path.join(f.ws, "a-file.txt"), "x", "utf8");
    const p = await promptFor(f, false);
    assert.match(p, /## Workspace snapshot/, "the snapshot block must be present (#64)");
    assert.match(p, /a-file\.txt/, "listing the workspace top level (#64)");
  } finally {
    await f.cleanup();
  }
});

test("the skills catalogue is present and names each skill (#64)", async () => {
  const f = await fixture("R", { name: "my-skill", description: "does a thing" });
  try {
    const p = await promptFor(f, false);
    assert.match(p, /## Skills available in this workspace/, "the catalogue must be present (#64)");
    assert.match(p, /my-skill/, "naming the skill (#64)");
    assert.match(p, /load_skill/, "and how to load it (#64)");
  } finally {
    await f.cleanup();
  }
});

test("no skills means no catalogue block, not an empty one (#64)", async () => {
  const f = await fixture("R");
  try {
    const p = await promptFor(f, false);
    assert.doesNotMatch(p, /## Skills available/, "an empty catalogue is just noise (#64)");
  } finally {
    await f.cleanup();
  }
});

/* ---------- the reason the whole block is written this way ---------- */

test("the system prompt is byte-identical across a restart (#64)", async () => {
  // Not a nicety: the values are persisted precisely so the prefix cache
  // survives. If this drifts, every restart silently re-uploads the whole
  // prompt to the provider and the caching stops paying for itself.
  const f = await fixture("RULE", { name: "s1", description: "d" });
  try {
    const first = await promptFor(f, false);
    const second = await promptFor(f, true);
    assert.equal(
      second,
      first,
      "a restart must re-issue the identical system prompt, or the prefix cache dies (#64)",
    );
  } finally {
    await f.cleanup();
  }
});
