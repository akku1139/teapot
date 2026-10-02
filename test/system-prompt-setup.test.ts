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
import { readEvents } from "../src/log/events.ts";
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
async function promptFor(
  f: { ws: string; sd: string },
  restore: boolean,
  opts: { compact?: boolean } = {},
): Promise<string> {
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
  // compaction is the point at which AGENTS.md is re-read (#64), so a test that
  // cares about a post-compaction prompt must actually trigger one
  if (opts.compact) await agent.compactNow();
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

/* ---------- #64 follow-up: AGENTS.md edited on disk, then compaction ---------- */

/**
 * The question, asked directly: if AGENTS.md changed on the filesystem and a
 * compaction then ran, does the agent pick up the new rules? And how is that
 * reconciled with the one-shot capture that exists to keep the prompt
 * byte-identical for the provider's prefix cache?
 *
 * Before this, the answer was NO: `agentsMdLoaded` is a one-way latch, so the
 * content was frozen for the life of the session no matter what happened to the
 * file. Compaction exists to summarise work against the CURRENT instructions,
 * so carrying the old rules over the summary is exactly the wrong behaviour.
 */
test("a compaction adopts an AGENTS.md edited on disk (#64)", async () => {
  const f = await fixture("V1_RULE");
  try {
    await promptFor(f, false);
    await writeFile(path.join(f.ws, "AGENTS.md"), "V2_RULE_AFTER_EDIT", "utf8");
    const p = await promptFor(f, false, { compact: true });
    assert.match(p, /V2_RULE_AFTER_EDIT/, "compaction must re-read AGENTS.md (#64)");
    assert.doesNotMatch(p, /V1_RULE/, "and must not keep serving the old rules (#64)");
  } finally {
    await f.cleanup();
  }
});

test("the reload is logged, so the operator can see the prompt changed (#64)", async () => {
  const f = await fixture("V1_RULE");
  try {
    let sys: string = "";
    const agent = new Agent({
      id: "t",
      workspace: f.ws,
      sessionDir: f.sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn: async (_c: unknown, m: any) => {
        if (!sys) sys = String(m[0]?.content ?? "");
        return reply;
      },
      contextTokenBudget: 2000,
      autoContinue: false,
    } as any);
    await agent.init();
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    await writeFile(path.join(f.ws, "AGENTS.md"), "V2_RULE_AFTER_EDIT", "utf8");
    await agent.compactNow();
    await agent.dispose();

    const events = await readEvents(agent.log.filePath);
    const reloaded = events.filter((e) => (e.data as any)?.event === "agents-md-reloaded");
    assert.equal(reloaded.length, 1, "the reload must be recorded exactly once (#64)");
    assert.equal(typeof (reloaded[0]!.data as any).bytes, "number", "with the size, for the log (#64)");
  } finally {
    await f.cleanup();
  }
});

test("an unchanged AGENTS.md is not reloaded (#64)", async () => {
  // Reloading unconditionally would re-price the prefix cache on EVERY
  // compaction for no reason, which is the cost the frozen capture avoids.
  const f = await fixture("V1_RULE");
  try {
    let sys = "";
    const agent = new Agent({
      id: "t",
      workspace: f.ws,
      sessionDir: f.sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn: async (_c: unknown, m: any) => {
        if (!sys) sys = String(m[0]?.content ?? "");
        return reply;
      },
      contextTokenBudget: 2000,
      autoContinue: false,
    } as any);
    await agent.init();
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    await agent.compactNow();
    await agent.dispose();
    const events = await readEvents(agent.log.filePath);
    assert.equal(
      events.filter((e) => (e.data as any)?.event === "agents-md-reloaded").length,
      0,
      "an unchanged file must not report a reload (#64)",
    );
  } finally {
    await f.cleanup();
  }
});

test("a DELETED AGENTS.md keeps the last known rules (#64)", async () => {
  // Dropping the instructions because of a transient error — or because someone
  // moved the file mid-session — is far worse than running one compaction on
  // slightly stale rules.
  //
  // This must be observed WITHIN ONE AGENT: the capture is per-agent state, so
  // a second process would simply re-read a file that is no longer there and
  // legitimately get nothing. That is not this case.
  const f = await fixture("V1_RULE");
  try {
    const prompts: string[] = [];
    const agent = new Agent({
      id: "t",
      workspace: f.ws,
      sessionDir: f.sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn: async (_c: unknown, m: any) => {
        prompts.push(String(m[0]?.content ?? ""));
        return reply;
      },
      contextTokenBudget: 2000,
      autoContinue: false,
    } as any);
    await agent.init();
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    assert.match(prompts.at(-1)!, /V1_RULE/, "precondition: the rules were captured (#64)");

    await rm(path.join(f.ws, "AGENTS.md"), { force: true });
    await agent.compactNow();
    agent.enqueuePrompt("go2");
    agent.start("t");
    await agent.settled();
    assert.match(
      prompts.at(-1)!,
      /V1_RULE/,
      "a deleted file must not wipe the rules the agent is already running under (#64)",
    );
    await agent.dispose();
  } finally {
    await f.cleanup();
  }
});


test("the workspace snapshot and skills stay FROZEN across the reload (#64)", async () => {
  // Only AGENTS.md is re-read. The listing and the catalogue are a snapshot of
  // the workspace as it was; re-listing mid-session would contradict the
  // instruction to "not list again what is already here", and AGENTS.md is
  // different in kind — it is instructions, not a listing, and a stale copy of
  // it is actively misleading.
  //
  // Observed within ONE agent, since the frozen state is per-agent.
  const f = await fixture("V1_RULE", { name: "s1", description: "d" });
  try {
    const prompts: string[] = [];
    const agent = new Agent({
      id: "t",
      workspace: f.ws,
      sessionDir: f.sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn: async (_c: unknown, m: any) => {
        prompts.push(String(m[0]?.content ?? ""));
        return reply;
      },
      contextTokenBudget: 2000,
      autoContinue: false,
    } as any);
    await agent.init();
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    const before = prompts.at(-1)!;
    const beforeList = before.match(/## Workspace snapshot[\s\S]*?(?=\n##|$)/)?.[0] ?? "";
    const beforeSkills = before.match(/## Skills available[\s\S]*?(?=\n##|$)/)?.[0] ?? "";
    assert.ok(beforeList, "precondition: a snapshot is present (#64)");
    assert.ok(beforeSkills, "precondition: a catalogue is present (#64)");

    // change EVERYTHING the workspace could report
    await writeFile(path.join(f.ws, "AGENTS.md"), "V2_RULE", "utf8");
    await writeFile(path.join(f.ws, "brand-new-file.txt"), "x", "utf8");
    await mkdir(path.join(f.ws, "skills", "s2"), { recursive: true });
    await writeFile(
      path.join(f.ws, "skills", "s2", "SKILL.md"),
      "---\nname: s2\ndescription: another\n---\n\nBody.",
      "utf8",
    );

    await agent.compactNow();
    agent.enqueuePrompt("go2");
    agent.start("t");
    await agent.settled();
    const after = prompts.at(-1)!;

    assert.match(after, /V2_RULE/, "AGENTS.md IS re-read (#64)");
    assert.doesNotMatch(after, /brand-new-file/, "the listing must stay frozen (#64)");
    assert.doesNotMatch(after, /\bs2\b/, "the skills catalogue must stay frozen (#64)");
    assert.equal(
      after.match(/## Workspace snapshot[\s\S]*?(?=\n##|$)/)?.[0] ?? "",
      beforeList,
      "the snapshot must be byte-identical (#64)",
    );
    await agent.dispose();
  } finally {
    await f.cleanup();
  }
});

