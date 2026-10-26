/**
 * A NESTED sub-agent's work is invisible to its ancestor, so the ancestor
 * resumes over unfinished work.
 *
 * The report: a sub-agent delegates to a further sub-agent, and the parent —
 * which knows nothing about it — ignores it and carries on.
 *
 * `waitChildren` decides what to wait for from `childrenOf()` = DIRECT children
 * (`config.agents.filter(a => a.parent === id)`), and the waiter is woken by
 * `wakeParentWaiters(ac.parent)` = the DIRECT parent. So with
 *
 *     P  ──spawns──▶  C  ──spawns──▶  G          (G still running, C idle)
 *
 * `P`'s `wait_children()` finds C idle, reports "all settled", and resumes while
 * G is still working. Nothing ever tells P that G exists.
 *
 * The delegation shape that reaches this is ordinary and not a mistake: C spawns
 * G, hands over, and returns its own turn — it does not necessarily park in
 * `wait_children` itself. Even when it does park, a descendant that outlives the
 * park (or a C that is restarted) leaves P with no way to observe it.
 *
 * Why the fix belongs here and not in the model: "wait until the work you caused
 * is finished" is a harness guarantee. A parent cannot ask the right question if
 * the tool only ever answers about the first level.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Master } from "../src/master.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };
const chatFn = async () => ({ message: { role: "assistant" as const, content: "ok" } });

function mkMaster(): Master {
  const dataDir = mkdtempInRootSync("nest-");
  return new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
}
const ws = () => mkdtempInRootSync("nestw-");

/** mark an agent as mid-work without running its loop */
function makeBusy(a: { parkedByTool?: boolean; status?: string }): void {
  a.parkedByTool = true;
  a.status = "idle"; // parkedByTool is exactly what parkForTool does for display
}

test("wait_children must not settle while a DESCENDANT is still busy", async () => {
  const m = mkMaster();
  const w = ws();
  const c = await m.addAgent({ id: "c", parent: "p", workspace: w, chatFn }, { persist: true });
  const g = await m.addAgent({ id: "g", parent: "c", workspace: w, chatFn }, { persist: true });
  try {
    makeBusy(g as unknown as { parkedByTool?: boolean; status?: string }); // grandchild working
    // C is idle: it delegated to G and returned its own turn
    let settled = false;
    const p = m.waitChildren("p", undefined, 5_000).then((r) => {
      settled = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      settled,
      false,
      "P must keep waiting: its descendant G is still working, even though C is idle",
    );

    g.stop("done"); // G settles for real
    const note = await p;
    assert.match(note.note, /settled/, `and then resolve: ${JSON.stringify(note)}`);
  } finally {
    await c.dispose();
    await g.dispose();
  }
});

test("a DESCENDANT settling must wake the ancestor's wait", async () => {
  const m = mkMaster();
  const w = ws();
  const c = await m.addAgent({ id: "c", parent: "p", workspace: w, chatFn }, { persist: true });
  const g = await m.addAgent({ id: "g", parent: "c", workspace: w, chatFn }, { persist: true });
  try {
    makeBusy(g as unknown as { parkedByTool?: boolean; status?: string });
    let settled = false;
    const p = m.waitChildren("p", undefined, 5_000).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(settled, false, "precondition: still waiting");

    // G settles through its normal lifecycle hook — the same path a real
    // completion takes. This must reach P's waiter, not only C's.
    (g as unknown as { parkedByTool: boolean }).parkedByTool = false;
    (g as unknown as { status: string }).status = "idle";
    (g as unknown as { onControlStatusChange?: (id: string, s: string) => void }).onControlStatusChange?.("g", "idle");

    const note = await Promise.race([
      p,
      new Promise<{ note: string }>((r) => setTimeout(() => r({ note: "TIMED OUT — not woken" }), 1_500)),
    ]);
    assert.match(note.note, /settled/, `the ancestor must be woken by a descendant settling: ${note.note}`);
  } finally {
    await c.dispose();
    await g.dispose();
  }
});

test("the list_children hook must reveal nested descendants, not just direct children", async () => {
  const m = mkMaster();
  const w = ws();
  const c = await m.addAgent({ id: "c", parent: "p", workspace: w, chatFn }, { persist: true });
  const g = await m.addAgent({ id: "g", parent: "c", workspace: w, chatFn }, { persist: true });
  try {
    // the hook the model actually calls
    const hooks = (c as unknown as { toolCtx: { subAgents: { list: () => { id: string }[] } } }).toolCtx
      .subAgents;
    assert.ok(hooks, "a spawning agent must expose the sub-agent hooks");
    const ids = hooks.list().map((x) => x.id);
    // C's own list is the DIRECT children it caused — G belongs to C, so this is
    // correct for C. The visibility gap is P's: see the test below, which asks P.
    assert.deepEqual(ids, ["g"], `C must see its own child: ${JSON.stringify(ids)}`);

    const pHooks = (await m.addAgent({ id: "p", workspace: w, chatFn }, { persist: true })) as unknown as {
      toolCtx: { subAgents: { list: () => { id: string }[] } };
    };
    const pIds = pHooks.toolCtx.subAgents.list().map((x) => x.id);
    assert.ok(
      pIds.includes("g"),
      `P must be able to see that its sub-agent delegated to G: got ${JSON.stringify(pIds)}`,
    );
  } finally {
    await c.dispose();
    await g.dispose();
    const p = m.agents.get("p");
    if (p) await p.dispose();
  }
});
