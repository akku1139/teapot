/**
 * wait_children が「park 中の子」を settled と誤判定する。
 *
 * parkForTool は表示用に status を "idle" に上書きする（スピナーを消すため）
 * が、ループは生存している。master.waitChildren の active() は生の status
 * （running/waiting）だけを見るので、park 中の子が「settled」と数えられ、
 * 親は未完了の子を置いて再開してしまう。isLive() は parkedByTool を見るので
 * 正しい — master 側だけ生 status。
 *
 * Required: park 中の子は active（待ち続ける）。stop されれば wake して解決。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Master } from "../src/master.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };
const chatFn = async () => ({ message: { role: "assistant" as const, content: "ok" } });

test("a PARKED child must count as active for waitChildren (not settled)", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "wcp-"));
  const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
  const ws = mkdtempSync(path.join(os.tmpdir(), "wcpw-"));
  const c1 = await m.addAgent({ id: "c1", parent: "p", workspace: ws, chatFn }, { persist: false });
  const c2 = await m.addAgent({ id: "c2", parent: "p", workspace: ws, chatFn }, { persist: false });
  try {
    // c1: settled (idle). c2: PARKED — exactly what parkForTool does to the
    // display state: parkedByTool=true, status overwritten to "idle"
    (c2 as unknown as { parkedByTool: boolean }).parkedByTool = true;
    (c2 as unknown as { status: string }).status = "idle";

    let settled = false;
    const noteP = m.waitChildren("p", ["c1", "c2"], 5_000).then((r) => {
      settled = true;
      return r;
    });

    // the parked child is STILL WORKING: the wait must not claim completion
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(settled, false, "a parked child is not settled — the wait must keep holding");

    // the parked child's loop is stopped from outside: only then does it settle
    c2.stop("done");
    const r = await Promise.race([noteP, new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 2_000))]);
    assert.notEqual(r, "timeout", "the stop must wake the waiter");
    assert.match((r as { note: string }).note, /settled/, "and report the settle, not a timeout");
  } finally {
    for (const a of [...m.agents.values()]) a.stop("done");
    for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
  }
});

test("a child parked and then UNPARKED keeps the wait holding (no false wake)", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "wcp2-"));
  const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
  const ws = mkdtempSync(path.join(os.tmpdir(), "wcp2w-"));
  const c1 = await m.addAgent({ id: "c1", parent: "p", workspace: ws, chatFn }, { persist: false });
  try {
    // parked, then the tool finished and the loop resumed (unpark restores
    // the pre-park status = running): the child is more alive than ever
    (c1 as unknown as { parkedByTool: boolean }).parkedByTool = true;
    (c1 as unknown as { status: string }).status = "idle";
    const noteP = m.waitChildren("p", ["c1"], 5_000);
    (c1 as unknown as { parkedByTool: boolean }).parkedByTool = false;
    (c1 as unknown as { status: string }).status = "running";
    // unpark does NOT emit a control event — but even if it did, the child is
    // active either way, so the wait must still be holding
    const r = await Promise.race([noteP, new Promise<"pending">((res) => setTimeout(() => res("pending"), 300))]);
    assert.equal(r, "pending", "a resumed child keeps the wait holding");
  } finally {
    for (const a of [...m.agents.values()]) a.stop("done");
    for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
  }
});
