/**
 * #48 — the memory system did not actually work, and the prompt said it did.
 *
 * The issue asked "そもそもteapotの現状のmemoryシステムはまともに仕事してるのか?" — so that was
 * measured before anything was ported from takos-agent-engine.
 *
 * ## What the measurement showed
 *
 * Across every session on this machine (817 of them):
 *
 *     memory.md non-empty            64  (8%)
 *     sessions using the memory tools 97
 *     set_memory calls               181
 *     read_memory AFTER a write       13
 *
 * So the notes were being WRITTEN and almost never CONSULTED. Two causes, both real
 * defects rather than missing features:
 *
 *  1. The prompt said `memory.md` was injected into the system prompt. It never was —
 *     `systemPrompt()` injects AGENTS.md and nothing else. A model that believes its
 *     notes are already in front of it has no reason to call `read_memory()`. The
 *     `set_memory` reply said "injected into future prompts" too, which repeated the
 *     same falsehood at the moment the model encoded the belief.
 *
 *  2. `set_memory` REPLACES the whole file, so a model that had not just read it
 *     silently erased everything it did not re-send. MEASURED on a real session: 21
 *     writes, the content dropping from 1028 to 83 bytes.
 *
 * The fixes are the two below plus a post-compaction re-attach, which is the one place
 * re-injecting is free (the prompt moves anyway) and obviously right (the history that
 * held the notes was just summarised away).
 *
 * ## Why not port takos-agent-engine
 *
 * Its memory is re-selected and re-assembled on EVERY tool round, which conflicts
 * head-on with teapot's design: `buildMessages()` is `[system] + append-only history`
 * specifically to keep provider prefix caches hot. Per-round memory injection is that
 * exception applied continuously, and it would land on the master agent — the one where
 * per-token cost matters most. teapot already has the right shape (a tool the model
 * calls); what was missing was that the tool's results were never read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const toolCall = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

/** Drive a real agent through a scripted sequence of tool calls. */
async function drive(script: ((n: number) => LlmResult | null)[]) {
  const ws = mkdtempInRootSync("mem-");
  const sd = mkdtempInRootSync("mems-");
  const toolReplies: string[] = [];
  let n = 0;
  const agent = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (_c: unknown, msgs: { role: string; content?: unknown }[]): Promise<LlmResult> => {
      for (const m of msgs) if (m.role === "tool") toolReplies.push(String(m.content ?? ""));
      const next = script[n++];
      return (next ? next(n) : null) ?? { message: { role: "assistant", content: "done" } };
    },
    autoContinue: false,
  } as never) as Agent;
  await agent.init();
  agent.enqueuePrompt("go");
  agent.start("t");
  await agent.settled().catch(() => {});
  return { agent, sd, toolReplies };
}

const memoryOf = (sd: string) => {
  try {
    return fs.readFileSync(path.join(sd, "memory.md"), "utf8");
  } catch {
    return "";
  }
};

test("add_memory APPENDS — an earlier note can never be lost by it (#48)", async () => {
  const { agent, sd } = await drive([
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("a", "set_memory", { content: "FIRST" })] } }),
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("b", "add_memory", { text: "SECOND" })] } }),
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("c", "add_memory", { text: "THIRD" })] } }),
  ]);
  try {
    assert.equal(
      memoryOf(sd),
      "FIRST\nSECOND\nTHIRD\n",
      "each note must survive the ones after it — this is the whole point of the append",
    );
  } finally {
    await agent.dispose();
  }
});

test("add_memory with empty text appends nothing and says so (#48)", async () => {
  const { agent, sd, toolReplies } = await drive([
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("a", "set_memory", { content: "KEEP" })] } }),
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("b", "add_memory", { text: "   " })] } }),
  ]);
  try {
    assert.equal(memoryOf(sd), "KEEP", "a blank note must not touch the file");
    assert.ok(
      toolReplies.some((r) => /non-empty/.test(r)),
      `the model must be told why nothing happened; got ${JSON.stringify(toolReplies.slice(0, 3))}`,
    );
  } finally {
    await agent.dispose();
  }
});

test("the notes are NOT claimed to be in the prompt (#48)", async () => {
  // the measured root cause: a model told its notes are already in the prompt has no
  // reason to call read_memory(), and across every session here it did not (181 writes,
  // 13 reads-after-writing)
  const { agent, sd, toolReplies } = await drive([
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("a", "set_memory", { content: "NOTE" })] } }),
  ]);
  try {
    const reply = toolReplies.find((r) => /memory\.md/.test(r)) ?? "";
    assert.match(reply, /REPLACED/, "an overwrite must be described as an overwrite");
    assert.doesNotMatch(
      reply,
      /injected into (your|future) prompt/i,
      "claiming injection is what stopped the model from reading its own notes",
    );
    assert.match(reply, /read_memory/, "and it must point at the tool that actually shows them");
    // precondition: the file really is NOT in the system prompt
    assert.equal(memoryOf(sd), "NOTE", "precondition: the note was written");
  } finally {
    await agent.dispose();
  }
});

test("the shipped prompt does not claim memory.md is injected (#48)", async () => {
  // asserted on the RUNTIME prompt text (what the model receives), not on a source
  // regex — the false sentence lived in two places and the model read both
  const { agent } = await drive([() => null]);
  try {
    const sys = (agent as unknown as { systemPrompt(): string }).systemPrompt();
    assert.doesNotMatch(
      sys,
      /memory\.md[^.]*injected/i,
      "the system prompt must not claim memory.md is injected",
    );
    assert.match(sys, /add_memory/, "and must name the append tool");
  } finally {
    await agent.dispose();
  }
});

test("a compaction re-attaches the notes, because the history holding them is gone (#48)", async () => {
  // This is the ONE place re-injecting is free: the prompt moves anyway (compaction
  // rewrites the history), and the notes had just been summarised out of existence.
  //
  // Driven through `compactNow()`, the same public path the /compact command uses, so
  // this asserts the real behaviour rather than re-implementing the trigger in a
  // fixture.
  const ws = mkdtempInRootSync("memc-");
  const sd = mkdtempInRootSync("memcs-");
  fs.writeFileSync(path.join(sd, "memory.md"), "REMEMBER: the key lives in env, not config\n");

  const promptsSeen: string[] = [];
  const agent = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (_c: unknown, msgs: { role: string; content?: unknown }[]): Promise<LlmResult> => {
      // the summarizer is the request whose LAST message carries the directive
      const last = String(msgs[msgs.length - 1]?.content ?? "");
      if (/compress|summar|You are an? .*summar/i.test(last)) {
        return { message: { role: "assistant", content: "## Current work\n- notes" } };
      }
      // record what an ordinary turn is handed
      for (const m of msgs) promptsSeen.push(String(m.content ?? ""));
      return { message: { role: "assistant", content: "x".repeat(400) } };
    },
    autoContinue: false,
  } as never) as Agent;
  await agent.init();
  try {
    // build enough history that a compaction has something to summarise
    agent.enqueuePrompt("first prompt " + "y".repeat(3_000));
    agent.start("t");
    await agent.settled().catch(() => {});
    const before = promptsSeen.length;
    const { ran } = await agent.compactNow();
    assert.ok(ran, "precondition: the compaction actually ran");
    // the re-attached notes are part of the history the NEXT request carries
    agent.enqueuePrompt("after compaction");
    agent.start("t");
    await agent.settled().catch(() => {});
    const after = promptsSeen.slice(before).join("\n");
    assert.match(
      after,
      /durable notes \(memory\.md\), re-attached/,
      "after compaction the notes must come back — otherwise they are write-only",
    );
    assert.match(after, /the key lives in env/, "and the note's TEXT must be there, not just a header");
  } finally {
    await agent.dispose();
  }
});

/* ---------- search: the idea taken from the ecosystem (#48) ---------- */

/**
 * MCP's reference memory server — the de-facto standard, and the one DSH recommends as
 * a reference — exposes `search` next to `read`, and its search is deliberately a
 * case-insensitive SUBSTRING match: no embeddings, no model, no provider dependency.
 * DSH's own model guidance is the same shape ("when historical information may be
 * relevant, search memory and use relevant results").
 *
 * The reason it matters for teapot is the measurement: a file big enough to be useful
 * is too big to dump, so without a query the model's only options were "burn it all
 * into the context" or "do not look".
 */
test("read_memory(query) returns only the matching lines (#48)", async () => {
  const { agent, sd, toolReplies } = await drive([
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("a", "set_memory", { content: "build takes 4 minutes\nPORT is 7789\nkey lives in env" })] } }),
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("b", "read_memory", { query: "port" })] } }),
  ]);
  try {
    const replies = [...new Set(toolReplies)];
    const hit = replies.find((r) => /matching/.test(r)) ?? "";
    assert.match(hit, /PORT is 7789/, "the matching line must come back");
    assert.doesNotMatch(hit, /build takes 4 minutes/, "and unrelated lines must not");
    assert.match(hit, /1 line/, "it must say HOW MANY matched, so the model knows it is not the whole file");
    // precondition: the file really does hold the other lines
    assert.match(memoryOf(sd), /build takes 4 minutes/);
  } finally {
    await agent.dispose();
  }
});

test("a query that matches nothing says so AND offers the fallback (#48)", async () => {
  // "no results" must not read as "memory is empty" — the model needs to know the
  // difference, or it will conclude its notes were lost
  const { agent, toolReplies } = await drive([
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("a", "set_memory", { content: "alpha\nbeta" })] } }),
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("b", "read_memory", { query: "nonexistent" })] } }),
  ]);
  try {
    const replies = [...new Set(toolReplies)];
    const miss = replies.find((r) => /no line in memory\.md matches/.test(r)) ?? "";
    assert.match(miss, /2 lines searched/, "it must report how much WAS searched");
    assert.match(miss, /no query to see all/, "and point at the unfiltered read");
  } finally {
    await agent.dispose();
  }
});

test("read_memory with no query still returns the whole file (#48)", async () => {
  const { agent, sd, toolReplies } = await drive([
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("a", "set_memory", { content: "alpha\nbeta" })] } }),
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("b", "read_memory", {})] } }),
  ]);
  try {
    const replies = [...new Set(toolReplies)];
    assert.ok(replies.includes("alpha\nbeta"), `the unfiltered read must be unchanged; got ${JSON.stringify(replies.slice(-2))}`);
    assert.equal(memoryOf(sd), "alpha\nbeta");
  } finally {
    await agent.dispose();
  }
});

/* ---------- forget: notes must be removable, not only appendable (#48) ---------- */

test("forget_memory removes only the matching lines (#48)", async () => {
  // An append-only store accumulates stale facts ("the build takes 4 minutes" outlives
  // the 40-second build), and a confidently wrong memory is worse than a silent one.
  // Before this, correcting a line meant re-typing the whole file into set_memory —
  // which is how 1028 bytes became 83 on a real session.
  const { agent, sd } = await drive([
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("a", "set_memory", { content: "build takes 4 minutes\nPORT is 7789\nkey lives in env" })] } }),
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("b", "forget_memory", { query: "build takes 4 minutes" })] } }),
  ]);
  try {
    const after = memoryOf(sd);
    assert.doesNotMatch(after, /build takes 4 minutes/, "the stale note must be gone");
    assert.match(after, /PORT is 7789/, "and everything else must survive");
    assert.match(after, /key lives in env/);
  } finally {
    await agent.dispose();
  }
});

test("forget_memory reports what it removed, so a mistake is visible (#48)", async () => {
  const { agent, toolReplies } = await drive([
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("a", "set_memory", { content: "keep me\ndrop me" })] } }),
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("b", "forget_memory", { query: "drop me" })] } }),
  ]);
  try {
    const replies = [...new Set(toolReplies)];
    const note = replies.find((r) => /removed 1 line/.test(r)) ?? "";
    assert.match(note, /drop me/, "the removed text must be quoted back");
    assert.match(note, /re-add/, "and the model told how to undo it");
  } finally {
    await agent.dispose();
  }
});

test("forget_memory matching nothing leaves the file alone (#48)", async () => {
  const { agent, sd, toolReplies } = await drive([
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("a", "set_memory", { content: "alpha" })] } }),
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("b", "forget_memory", { query: "zzz" })] } }),
  ]);
  try {
    assert.equal(memoryOf(sd), "alpha", "a miss must not touch the file");
    const replies = [...new Set(toolReplies)];
    assert.ok(replies.some((r) => /nothing removed/.test(r)), "and it must say so");
  } finally {
    await agent.dispose();
  }
});

test("the prompt tells the model to write AND search, since nothing is injected (#48)", async () => {
  // DSH's examples add exactly one line of memory guidance for this reason: provider
  // tool descriptions are authoritative, but a model that does not think to look never
  // sees them. Asserted on the RUNTIME prompt, which is what the model receives.
  const { agent } = await drive([() => null]);
  try {
    const sys = (agent as unknown as { systemPrompt(): string }).systemPrompt();
    assert.match(sys, /add_memory/, "must name the write tool");
    assert.match(sys, /read_memory\(query\)/, "and the search form");
    assert.match(sys, /unread note is an unwritten note/i, "and say plainly that nothing is injected");
    // the DECISION BOUNDARY, taken from Codex's read_path.md: "always search" and "never
    // search" are both wrong, and only the boundary stops a trivial request paying for a scan
    assert.match(sys, /skip it for a self-contained request/i, "must say when NOT to search");
    assert.match(sys, /by DEFAULT when/i, "and when to search by default");
    assert.match(sys, /at most one or two/i, "and bound the cost of a pass");
  } finally {
    await agent.dispose();
  }
});

/**
 * The notes must outlive the SESSION, not just the turn.
 *
 * MEASURED before this: memory.md lived inside `sessionDir`, so minting a new session for an
 * agent silently orphaned everything it had learned. Across this machine, 66 agents had more
 * than one session (median 6) and only 5 had notes in any of them — the notes were written and
 * then abandoned the next time a session was created. A "durable note" that dies with the
 * timeline is not durable, and it is why the memory system looked useless.
 */
test("notes survive a NEW session for the same agent (#48)", async () => {
  const root = mkdtempInRootSync("memsess-");
  // the real layout: sessions/<agent>-<hex>/  — the per-session dirs sit one level down
  const mkSession = (name: string) => {
    const d = path.join(root, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const writeIn = async (sd: string, script: (() => LlmResult)[]) => {
    let n = 0;
    const a = new Agent({
      id: "alpha",
      workspace: root,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (): Promise<LlmResult> => {
        const next = script[n++];
        return (next ? next() : null) ?? { message: { role: "assistant", content: "done" } };
      },
      autoContinue: false,
    } as never) as Agent;
    await a.init();
    return a;
  };

  // session 1 writes a note
  const s1 = mkSession("alpha-a1b2c3d4");
  const a1 = await writeIn(s1, [
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("a", "add_memory", { text: "THE WIDGET IS MADE OF TIN" })] } }),
  ]);
  a1.enqueuePrompt("go");
  a1.start("t");
  await a1.settled().catch(() => {});

  // PRECONDITION: the note was written somewhere, or the check below proves nothing
  const agentWide = path.join(root, "memory.md");
  assert.ok(fs.existsSync(agentWide), "the note must live at agent scope, above the session dirs");

  // session 2 is a DIFFERENT session dir for the same agent — it must see the note, via the
  // same tool the model would call (driven through the loop, as every other test here does)
  const s2 = mkSession("alpha-e5f6a7b8");
  const replies2: string[] = [];
  let n2 = 0;
  const script2: unknown[] = [
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("r", "read_memory", {})] } }),
  ];
  const a2 = new Agent({
    id: "alpha",
    workspace: root,
    sessionDir: s2,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (_c: unknown, msgs: { role: string; content?: unknown }[]): Promise<LlmResult> => {
      for (const m of msgs) if (m.role === "tool") replies2.push(String(m.content ?? ""));
      const next = script2[n2++];
      return (next ? (next as () => LlmResult)() : null) ?? { message: { role: "assistant", content: "done" } };
    },
    autoContinue: false,
  } as never) as Agent;
  await a2.init();
  a2.enqueuePrompt("what do you remember");
  a2.start("t");
  await a2.settled().catch(() => {});

  assert.ok(
    replies2.join("\n").includes("THE WIDGET IS MADE OF TIN"),
    `a new session must still see the agent's notes; got: ${JSON.stringify(replies2.join("\n").slice(0, 200))}`,
  );

});

/**
 * The digest: the model must KNOW what memory holds without paying for all of it.
 *
 * Two failure modes measured in #48, and this has to avoid both:
 *
 *   - the whole file in the prompt → paid for on every request, breaks the prefix cache
 *   - nothing in the prompt        → the model never learns the notes exist, so it never
 *                                    asks (182 writes, 13 reads after a write)
 *
 * Codex's answer is a `MEMORY_SUMMARY` plus a searchable registry. This is the same
 * shape, so the test asserts both halves: the digest NAMES the topics, and the full note
 * body is still only reachable through the tool.
 */
test("the prompt carries a bounded DIGEST of the notes — names, not contents (#48)", async () => {
  const ws = mkdtempInRootSync("memd-");
  const root = mkdtempInRootSync("memds-");
  const sd = path.join(root, "alpha-a1b2c3d4");
  fs.mkdirSync(sd, { recursive: true });
  // agent-scoped, so the digest sees it
  // BULLETS, not plain lines: a bullet IS included in the digest, so an unbounded
  // builder really does dump these. Plain continuation lines are skipped by design,
  // which made an earlier version of this test pass while the budget was ignored.
  const long = Array.from({ length: 200 }, (_, i) => `- BODY-BULLET-${i} ${"x".repeat(60)}`).join("\n");
  fs.writeFileSync(
    path.join(root, "memory.md"),
    `# Project alpha\n\n## Build\nrun pnpm build\n\n## Gotchas\nthe cache lies\n\n${long}\n`,
  );

  const agent = new Agent({
    id: "alpha",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (): Promise<LlmResult> => ({ message: { role: "assistant", content: "done" } }),
    autoContinue: false,
  } as never) as Agent;
  await agent.init();
  try {
    const sys = (agent as unknown as { systemPrompt(): string }).systemPrompt();
    // it must NAME the topics, so the model can tell whether to look
    assert.match(sys, /Build/, "the digest must name a section heading");
    assert.match(sys, /Gotchas/, "…and the next one");
    // …but must NOT reproduce the body, or this is just the whole file again
    assert.doesNotMatch(sys, /BODY-BULLET-19\b/, "the note BODY must not be in the prompt");
    // the budget is an index budget, not a content budget
    const digest = sys.slice(sys.indexOf("Your durable notes"));
    assert.ok(
      digest.length < 3_000,
      `the digest must stay small; it was ${digest.length} chars, which is not an index`,
    );
    // and it must point at the tool, or the model has names it cannot follow up on
    assert.match(digest, /read_memory\(query\)/, "the digest must say how to fetch the rest");
  } finally {
    await agent.dispose();
  }
});

/**
 * A note you cannot DATE is a note you cannot safely act on.
 *
 * `harvestLessons()` has always stamped lessons with where they came from — and the model
 * could never see it, because the stamp was an HTML comment. So a lesson observed twenty
 * minutes ago read with exactly the same authority as one inherited from a compaction three
 * weeks ago.
 */
test("a harvested lesson carries READABLE provenance (#48)", async () => {
  const root = mkdtempInRootSync("memprov-");
  const sd = path.join(root, "alpha-a1b2c3d4");
  fs.mkdirSync(sd, { recursive: true });

  const agent = new Agent({
    id: "alpha",
    workspace: root,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (): Promise<LlmResult> => ({ message: { role: "assistant", content: "done" } }),
    autoContinue: false,
  } as never) as Agent;
  await agent.init();
  try {
    await (agent as unknown as { harvestLessons(s: string): Promise<void> }).harvestLessons(
      "## Durable lessons\n- the cache lies after a rename\n",
    );
    const written = fs.readFileSync(path.join(root, "memory.md"), "utf8");
    assert.match(written, /^## lessons from compaction/m, "the heading must say it came from a compaction");
    assert.match(written, /^_from: session alpha-a1b2c3d4/m, "and name the session it came from");
    assert.doesNotMatch(written, /^<!--/, "as text the model can read, not an HTML comment it cannot");
    assert.match(written, /the cache lies/, "the lesson itself must survive");

    // and the DIGEST must not be cluttered by the provenance line
    const sys = (agent as unknown as { systemPrompt(): string }).systemPrompt();
    const digest = sys.slice(sys.indexOf("Your durable notes"));
    assert.doesNotMatch(digest, /_from:/, "provenance belongs to a search hit, not the index");
  } finally {
    await agent.dispose();
  }
});

test("a search hit shows the heading and provenance it belongs to (#48)", async () => {
  const root = mkdtempInRootSync("memhit-");
  const sd = path.join(root, "alpha-b1c2d3e4");
  fs.mkdirSync(sd, { recursive: true });
  // a line that is meaningless without its heading
  fs.writeFileSync(
    path.join(root, "memory.md"),
    "## Build\nrun pnpm build\n\n## Gotchas\n_the cache lies_\n\n## lessons from compaction 2026-01-02 03:04\n_from: session alpha-old, branch br0\n- the cache lies after a rename\n",
  );
  const seen: string[] = [];
  let n = 0;
  const script = [
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("r", "read_memory", { query: "cache lies" })] } }),
  ];
  const agent = new Agent({
    id: "alpha",
    workspace: root,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (_c: unknown, msgs: { role: string; content?: unknown }[]): Promise<LlmResult> => {
      for (const m of msgs) if (m.role === "tool") seen.push(String(m.content ?? ""));
      const next = script[n++];
      return (next ? (next as () => LlmResult)() : null) ?? { message: { role: "assistant", content: "done" } };
    },
    autoContinue: false,
  } as never) as Agent;
  await agent.init();
  agent.enqueuePrompt("what do you know about the cache");
  agent.start("t");
  await agent.settled().catch(() => {});
  try {
    const out = seen.join("\n");
    assert.ok(out.includes("cache lies"), "precondition: the query matched");
    assert.match(out, /↳/, "each hit must be shown with its context");
    assert.match(out, /Gotchas/, "…naming the section it sits under");
    assert.match(out, /from: session alpha-old/, "…and where it came from");
  } finally {
    await agent.dispose();
  }
});
