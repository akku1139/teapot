/**
 * #132 — "I want to message from a sub-agent to its parent agent, but it is
 * refused."
 *
 * ## Cause
 *
 * `messageChild` only ever permitted parent → child:
 *
 *     if (!cfg || cfg.parent !== parentId) throw …
 *
 * so a child asking its parent a question was refused with the actively
 * misleading
 *
 *     not your sub-agent: p1. no such sub-agent exists.
 *
 * — naming the parent's own id as nonexistent, when it is right there in
 * `config.agents` with `parent: undefined`. The detail hint added by #11
 * ("no such sub-agent exists") is what makes it actively wrong rather than merely
 * unhelpful: it is confidently false.
 *
 * ## The rule now
 *
 * The parent link is the trust boundary:
 *
 *   child  -> its parent   ALLOWED
 *   parent -> its child    ALLOWED
 *   child  -> a SIBLING     refused
 *   agent  -> itself        refused
 *
 * All four are asserted, because "allow the parent link" implemented as "allow
 * anything" would pass only the first.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSource } from "./helpers/source.ts";
import { fileURLToPath } from "node:url";
import { Master } from "../src/master.ts";

// #126: URL.pathname yields "/D:/a/…" on Windows, which does not resolve
const here = path.dirname(fileURLToPath(import.meta.url));
const tools = readSource(path.join(here, "..", "src", "agent", "tools.ts"));

let SHARED: Awaited<ReturnType<typeof buildTree>> | null = null;

// the spawned children are real agents pointed at an unreachable provider, so
// without this the runner waits on their retry timers long after the assertions
after(async () => {
  const m = SHARED?.m;
  if (!m) return;
  for (const a of [...m.agents.values()]) a.stop("test done");
  for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
});

/**
 * One tree for the whole file.
 *
 * Each `spawnChildFor` costs ~2s of real agent startup, so building a fresh tree
 * per test made this file take 44s — long enough that it would get skipped or
 * tolerated. The tree is read-only for these assertions (messageChild only
 * enqueues), so sharing is safe.
 */
async function tree() {
  if (!SHARED) SHARED = await buildTree();
  return SHARED;
}

async function buildTree() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "t132a-"));
  const ws = mkdtempSync(path.join(os.tmpdir(), "t132w-"));
  const m = new Master(
    { port: 0, dataDir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, providers: {}, agents: [] },
    path.join(dataDir, "config.json"),
  );
  const parent = await m.addAgent({ id: "p1", workspace: ws }, { persist: true });
  await m.spawnChildFor(parent, { task: "task A", context: "none" });
  await m.spawnChildFor(parent, { task: "task B", context: "none" });
  const kids = m.config.agents.filter((a) => a.parent === "p1").map((a) => a.id);
  // no teardown: the tree is shared for the file's lifetime
  const stop = async () => {};
  return { m, kids, stop };
}

async function allowed(from: string, to: string): Promise<{ ok: boolean; msg: string }> {
  const { m, kids, stop } = await tree();
  try {
    await (m as unknown as { messageChild(a: string, b: string, t: string): Promise<void> }).messageChild(
      from,
      to,
      "hello",
    );
    return { ok: true, msg: "" };
  } catch (e) {
    return { ok: false, msg: (e as Error).message };
  } finally {
    await stop();
  }
}

test("a sub-agent CAN message its parent (#132)", async () => {
  const { m, kids, stop } = await tree();
  try {
    await (m as unknown as { messageChild(a: string, b: string, t: string): Promise<void> }).messageChild(
      kids[0]!,
      "p1",
      "question for you",
    );
  } finally {
    await stop();
  }
});

test("a parent can still message its child (#132)", async () => {
  const { m, kids, stop } = await tree();
  try {
    await (m as unknown as { messageChild(a: string, b: string, t: string): Promise<void> }).messageChild(
      "p1",
      kids[0]!,
      "keep going",
    );
  } finally {
    await stop();
  }
});

test("a sub-agent still CANNOT message a sibling (#132)", async () => {
  // "allow the parent link" implemented as "allow anything" would pass the first
  // two tests alone
  const { m, kids, stop } = await tree();
  try {
    await assert.rejects(
      (m as unknown as { messageChild(a: string, b: string, t: string): Promise<void> }).messageChild(
        kids[0]!,
        kids[1]!,
        "let me know",
      ),
      /not your sub-agent/,
      "siblings are not addressable (#132)",
    );
  } finally {
    await stop();
  }
});

test("an agent still cannot message itself (#132)", async () => {
  const r = await allowed("p1", "p1");
  assert.equal(r.ok, false, "self-messaging must stay refused (#132)");
});

test("the refusal for a sibling still names the real owner (#132)", async () => {
  // #11's detail hint must survive the new branch
  const { m, kids, stop } = await tree();
  try {
    await assert.rejects(
      (m as unknown as { messageChild(a: string, b: string, t: string): Promise<void> }).messageChild(
        kids[0]!,
        kids[1]!,
        "x",
      ),
      /its parent is @p1/,
      "the hint must still say who the owner is (#132)",
    );
  } finally {
    await stop();
  }
});

test("the tool description tells the model it may message its parent (#132)", () => {
  // the capability is useless if the model does not know it has it
  assert.match(tools, /message your OWN PARENT/, "the description must say so (#132)");
  assert.match(tools, /You may NOT message a sibling/, "and must state the limit (#132)");
});
