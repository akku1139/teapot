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

function park(a: unknown): void {
  (a as { parkedByTool: boolean }).parkedByTool = true;
  (a as { status: string }).status = "idle";
}

test("an agent parked in wait_children is BUSY, so its ancestor keeps waiting (isBusy)", async () => {
  const m = mkMaster();
  const w = ws();
  const c = await m.addAgent({ id: "c", parent: "p", workspace: w, chatFn }, { persist: true });
  const g = await m.addAgent({ id: "g", parent: "c", workspace: w, chatFn }, { persist: true });
  try {
    park(c); 
    park(g); 

    let settled = false;
    const p = m.waitChildren("p", undefined, 1_200).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(settled, false, "P must not settle while C is merely WAITING and G is working");

    const note = await p; 
    assert.match(note.note, /timeout/, `and it must time out rather than claim completion: ${note.note}`);
  } finally {
    await c.dispose();
    await g.dispose();
  }
});

test("a waiting agent's STATUS is idle, which is why the display needs the parked flag", async () => {
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

