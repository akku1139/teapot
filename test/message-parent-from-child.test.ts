import { test, after } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Master } from "../src/master.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const _here = path.dirname(fileURLToPath(import.meta.url));

let SHARED: Awaited<ReturnType<typeof buildTree>> | null = null;

after(async () => {
  const m = SHARED?.m;
  if (!m) return;
  for (const a of [...m.agents.values()]) a.stop("test done");
  for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
});

async function tree() {
  if (!SHARED) SHARED = await buildTree();
  return SHARED;
}

async function buildTree() {
  const dataDir = mkdtempInRootSync("t132a-");
  const ws = mkdtempInRootSync("t132w-");
  const m = new Master(
    { port: 0, dataDir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, providers: {}, agents: [] },
    path.join(dataDir, "config.json"),
  );
  const parent = await m.addAgent({ id: "p1", workspace: ws }, { persist: true });
  await m.spawnChildFor(parent, { task: "task A", context: "none" });
  await m.spawnChildFor(parent, { task: "task B", context: "none" });
  const kids = m.config.agents.filter((a) => a.parent === "p1").map((a) => a.id);
  const stop = async () => {};
  return { m, kids, stop };
}

async function allowed(from: string, to: string): Promise<{ ok: boolean; msg: string }> {
  const { m, stop } = await tree();
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

function queuedFor(agentId: string, text: string): boolean {
  const a = SHARED?.m.agents.get(agentId);
  if (!a) return false;
  return a.snapshot().pendingPrompts > 0 && a.pendingPromptTexts().some((t) => t.includes(text));
}

test("a sub-agent CAN message its parent, and the text ARRIVES (#132)", async () => {
  const { m, kids } = await tree();
  const text = "question for you #132";
  await (m as unknown as { messageChild(a: string, b: string, t: string): Promise<void> }).messageChild(
    kids[0]!,
    "p1",
    text,
  );
  assert.ok(
    queuedFor("p1", text),
    "the parent must actually RECEIVE the message — a call that merely does not throw proves nothing (#132)",
  );
});

test("a parent can still message its child, and the text ARRIVES (#132)", async () => {
  const { m, kids } = await tree();
  const text = "keep going #132";
  await (m as unknown as { messageChild(a: string, b: string, t: string): Promise<void> }).messageChild(
    "p1",
    kids[0]!,
    text,
  );
  assert.ok(
    queuedFor(kids[0]!, text),
    "the child must actually RECEIVE the message (#132)",
  );
});

test("a sub-agent still CANNOT message a sibling (#132)", async () => {
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

