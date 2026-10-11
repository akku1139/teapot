/**
 * Does an agent that is itself WAITING (`wait_children`) read as SETTLED to its
 * ancestor?
 *
 * Reported live: a sub-agent issued `wait_children`, went `idle` for display, and
 * the grandparent's own `wait_children` resolved — so the grandparent resumed over
 * work that was still in flight two levels down. "Waiting" is not "finished", and
 * the question is whether the harness can tell the difference.
 *
 * These tests pin the distinction using only what the harness exposes today, so
 * the answers describe behaviour rather than an aspiration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Master } from "../src/master.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };
const chatFn = async () => ({ message: { role: "assistant" as const, content: "ok" } });

function mkMaster(): Master {
  const dataDir = mkdtempInRootSync("waiting-");
  return new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
}
const ws = () => mkdtempInRootSync("waitingw-");

/** what parkForTool does for display: loop alive, status reads idle */
function park(a: unknown): void {
  (a as { parkedByTool: boolean }).parkedByTool = true;
  (a as { status: string }).status = "idle";
}

test("an agent parked in wait_children is BUSY, so its ancestor keeps waiting (isBusy)", async () => {
  const m = mkMaster();
  const w = ws();
  // P -> C -> G, all persisted (a real spawn persists the child)
  const c = await m.addAgent({ id: "c", parent: "p", workspace: w, chatFn }, { persist: true });
  const g = await m.addAgent({ id: "g", parent: "c", workspace: w, chatFn }, { persist: true });
  try {
    park(c); // C called wait_children and parked
    park(g); // G is working (parked on ITS own tool, e.g. a bash call)

    let settled = false;
    const p = m.waitChildren("p", undefined, 1_200).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(settled, false, "P must not settle while C is merely WAITING and G is working");

    const note = await p; // let the timeout resolve it
    assert.match(note.note, /timeout/, `and it must time out rather than claim completion: ${note.note}`);
  } finally {
    await c.dispose();
    await g.dispose();
  }
});

test("a waiting agent's STATUS is idle, which is why the display needs the parked flag", async () => {
  // documents the trap: status alone cannot distinguish "waiting" from "done"
  const m = mkMaster();
  const w = ws();
  const c = await m.addAgent({ id: "c", parent: "p", workspace: w, chatFn }, { persist: true });
  try {
    park(c);
    assert.equal(c.status, "idle", "the visible status reads idle while waiting");
    assert.equal(c.isBusy(), true, "but isBusy() tells the truth — the loop is alive");
  } finally {
    await c.dispose();
  }
});

test("reusing `waiting` for wait_children would REINTRODUCE the false settle (#130 gate)", async () => {
  // `waiting` already means "blocked on the OPERATOR" (ask_user), and master's
  // SETTLED set — the #130 gate that decides whether to tell a parent its child
  // is done — INCLUDES it, deliberately: a child asking a question needs the
  // operator, and the parent should hear about it rather than wait forever.
  //
  // wait_children means the opposite ("still working"). So a distinct status
  // cannot simply reuse `waiting`: the report gate would announce a busy child as
  // settled, which is the very bug the subtree fix removes. This asserts the
  // conflict exists, so nobody "unifies" the two states later without noticing.
  const master = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/master.ts", import.meta.url), "utf8"),
  );
  const settled = /const SETTLED[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(master)?.[1] ?? "";
  assert.match(settled, /"waiting"/, "waiting counts as settled — what makes reuse unsafe (#130)");
  assert.match(settled, /"idle"/, "and idle does too");
});
