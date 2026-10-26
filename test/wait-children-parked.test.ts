import { test } from "node:test";
import assert from "node:assert/strict";

import { Master } from "../src/master.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };
const chatFn = async () => ({ message: { role: "assistant" as const, content: "ok" } });

test("a PARKED child must count as active for waitChildren (not settled)", async () => {
  const dataDir = mkdtempInRootSync("wcp-");
  const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
  const ws = mkdtempInRootSync("wcpw-");
  const _c1 = await m.addAgent({ id: "c1", parent: "p", workspace: ws, chatFn }, { persist: false });
  const c2 = await m.addAgent({ id: "c2", parent: "p", workspace: ws, chatFn }, { persist: false });
  try {
    (c2 as unknown as { parkedByTool: boolean }).parkedByTool = true;
    (c2 as unknown as { status: string }).status = "idle";

    let settled = false;
    const noteP = m.waitChildren("p", ["c1", "c2"], 5_000).then((r) => {
      settled = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(settled, false, "a parked child is not settled — the wait must keep holding");

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
  const dataDir = mkdtempInRootSync("wcp2-");
  const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
  const ws = mkdtempInRootSync("wcp2w-");
  const c1 = await m.addAgent({ id: "c1", parent: "p", workspace: ws, chatFn }, { persist: false });
  try {
    (c1 as unknown as { parkedByTool: boolean }).parkedByTool = true;
    (c1 as unknown as { status: string }).status = "idle";
    const noteP = m.waitChildren("p", ["c1"], 5_000);
    (c1 as unknown as { parkedByTool: boolean }).parkedByTool = false;
    (c1 as unknown as { status: string }).status = "running";
    const r = await Promise.race([noteP, new Promise<"pending">((res) => setTimeout(() => res("pending"), 300))]);
    assert.equal(r, "pending", "a resumed child keeps the wait holding");
  } finally {
    for (const a of [...m.agents.values()]) a.stop("done");
    for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
  }
});
