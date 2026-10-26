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
    assert.equal(memoryOf(sd), "NOTE", "precondition: the note was written");
  } finally {
    await agent.dispose();
  }
});

test("the shipped prompt does not claim memory.md is injected (#48)", async () => {
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
      const last = String(msgs[msgs.length - 1]?.content ?? "");
      if (/compress|summar|You are an? .*summar/i.test(last)) {
        return { message: { role: "assistant", content: "## Current work\n- notes" } };
      }
      for (const m of msgs) promptsSeen.push(String(m.content ?? ""));
      return { message: { role: "assistant", content: "x".repeat(400) } };
    },
    autoContinue: false,
  } as never) as Agent;
  await agent.init();
  try {
    agent.enqueuePrompt("first prompt " + "y".repeat(3_000));
    agent.start("t");
    await agent.settled().catch(() => {});
    const before = promptsSeen.length;
    const { ran } = await agent.compactNow();
    assert.ok(ran, "precondition: the compaction actually ran");
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
    assert.match(memoryOf(sd), /build takes 4 minutes/);
  } finally {
    await agent.dispose();
  }
});

test("a query that matches nothing says so AND offers the fallback (#48)", async () => {
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

test("forget_memory removes only the matching lines (#48)", async () => {
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
  const { agent } = await drive([() => null]);
  try {
    const sys = (agent as unknown as { systemPrompt(): string }).systemPrompt();
    assert.match(sys, /add_memory/, "must name the write tool");
    assert.match(sys, /read_memory\(query\)/, "and the search form");
    assert.match(sys, /unread note is an unwritten note/i, "and say plainly that nothing is injected");
    assert.match(sys, /skip it for a self-contained request/i, "must say when NOT to search");
    assert.match(sys, /by DEFAULT when/i, "and when to search by default");
    assert.match(sys, /at most one or two/i, "and bound the cost of a pass");
  } finally {
    await agent.dispose();
  }
});

test("notes survive a NEW session for the same agent (#48)", async () => {
  const root = mkdtempInRootSync("memsess-");
  const mkSession = (name: string) => {
    const d = path.join(root, "sessions", name);
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

  const s1 = mkSession("alpha-a1b2c3d4");
  const a1 = await writeIn(s1, [
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("a", "add_memory", { text: "THE WIDGET IS MADE OF TIN" })] } }),
  ]);
  a1.enqueuePrompt("go");
  a1.start("t");
  await a1.settled().catch(() => {});

  const agentWide = path.join(root, "sessions", "memory.md");
  assert.ok(fs.existsSync(agentWide), "the note must live at agent scope, above the session dirs");

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

test("the prompt carries a bounded DIGEST of the notes — names, not contents (#48)", async () => {
  const ws = mkdtempInRootSync("memd-");
  const root = mkdtempInRootSync("memds-");
  const sd = path.join(root, "sessions", "alpha-a1b2c3d4");
  fs.mkdirSync(sd, { recursive: true });
  const long = Array.from({ length: 200 }, (_, i) => `- BODY-BULLET-${i} ${"x".repeat(60)}`).join("\n");
  fs.writeFileSync(
    path.join(root, "sessions", "memory.md"),
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
    assert.match(sys, /Build/, "the digest must name a section heading");
    assert.match(sys, /Gotchas/, "…and the next one");
    assert.doesNotMatch(sys, /BODY-BULLET-19\b/, "the note BODY must not be in the prompt");
    const digest = sys.slice(sys.indexOf("Your durable notes"));
    assert.ok(
      digest.length < 3_000,
      `the digest must stay small; it was ${digest.length} chars, which is not an index`,
    );
    assert.match(digest, /read_memory\(query\)/, "the digest must say how to fetch the rest");
  } finally {
    await agent.dispose();
  }
});

test("a harvested lesson carries READABLE provenance (#48)", async () => {
  const root = mkdtempInRootSync("memprov-");
  const sd = path.join(root, "sessions", "alpha-a1b2c3d4");
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
    const written = fs.readFileSync(path.join(root, "sessions", "memory.md"), "utf8");
    assert.match(written, /^## lessons from compaction/m, "the heading must say it came from a compaction");
    assert.match(written, /^_from: session alpha-a1b2c3d4/m, "and name the session it came from");
    assert.doesNotMatch(written, /^<!--/, "as text the model can read, not an HTML comment it cannot");
    assert.match(written, /the cache lies/, "the lesson itself must survive");

    const sys = (agent as unknown as { systemPrompt(): string }).systemPrompt();
    const digest = sys.slice(sys.indexOf("Your durable notes"));
    assert.doesNotMatch(digest, /_from:/, "provenance belongs to a search hit, not the index");
  } finally {
    await agent.dispose();
  }
});

test("a search hit shows the heading and provenance it belongs to (#48)", async () => {
  const root = mkdtempInRootSync("memhit-");
  const sd = path.join(root, "sessions", "alpha-b1c2d3e4");
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(
    path.join(root, "sessions", "memory.md"),
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

test("memory scope is decided by STRUCTURE, not by a random temp suffix (#48)", async () => {
  const mk = async (root: string, sd: string) => {
    const a = new Agent({
      id: "alpha",
      workspace: root,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (): Promise<LlmResult> => ({ message: { role: "assistant", content: "done" } }),
      autoContinue: false,
    } as never) as Agent;
    await a.init();
    return a as unknown as { memoryFile: string };
  };

  const root = mkdtempInRootSync("memstruct-");
  const under = path.join(root, "sessions", "alpha-a1b2c3");
  fs.mkdirSync(under, { recursive: true });
  const a1 = await mk(root, under);
  assert.equal(a1.memoryFile, path.join(root, "sessions", "memory.md"), "agent-scoped");

  const outside = path.join(root, "alpha-a1b2c3");
  fs.mkdirSync(outside, { recursive: true });
  const a2 = await mk(root, outside);
  assert.equal(a2.memoryFile, path.join(outside, "memory.md"), "session-scoped: no sessions/ parent");
});
