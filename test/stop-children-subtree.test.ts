import { test } from "node:test";
import assert from "node:assert/strict";

import { Master } from "../src/master.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

async function tree(depth: number, extraSiblings = 0) {
  const dataDir = mkdtempInRootSync("t142a-");
  const ws = mkdtempInRootSync("t142w-");
  const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
  await m.addAgent({ id: "root", workspace: ws }, { persist: true });
  const spawn = (parentId: string, task: string) =>
    m.spawnChildFor(m.agents.get(parentId)!, { task, context: "none" });
  let parent = "root";
  const chain: string[] = [];
  for (let i = 0; i < depth; i++) {
    const c = await spawn(parent, `L${i}`);
    chain.push(c.id);
    parent = c.id;
  }
  const siblings: string[] = [];
  for (let i = 0; i < extraSiblings; i++) {
    const c = await spawn("root", `S${i}`);
    siblings.push(c.id);
  }
  return { m, chain, siblings };
}

const settle = () => new Promise((r) => setTimeout(r, 1200));
const stopAll = async (m: Master) => {
  for (const a of [...m.agents.values()]) a.stop("test done");
  for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
};

test("stopping a child by id stops its WHOLE subtree (#142)", async () => {
  const { m, chain } = await tree(4);
  try {
    const r = await m.stopChildrenFor("root", [chain[0]!]);
    await settle();
    assert.deepEqual(
      [...r.stopped].sort(),
      [...chain].sort(),
      `every descendant must be reported stopped (#142); got ${JSON.stringify(r.stopped)}`,
    );
    for (const id of chain) {
      assert.equal(
        m.agents.get(id)?.snapshot().status,
        "stopped",
        `${id} must be stopped — an orphan keeps a model connection and bills tokens (#142)`,
      );
    }
  } finally {
    await stopAll(m);
  }
});

test("a great-grandchild is stopped, not just direct children (#142)", async () => {
  const { m, chain } = await tree(3);
  try {
    await m.stopChildrenFor("root", [chain[0]!]);
    await settle();
    assert.equal(m.agents.get(chain[2]!)?.snapshot().status, "stopped", "depth 3 must stop (#142)");
  } finally {
    await stopAll(m);
  }
});

test("an explicit id does NOT stop a SIBLING (#142)", async () => {
  const { m, chain, siblings } = await tree(2, 2);
  try {
    await m.stopChildrenFor("root", [chain[0]!]);
    await settle();
    assert.equal(m.agents.get(chain[0]!)?.snapshot().status, "stopped", "the named subtree stops (#142)");
    for (const s of siblings) {
      assert.notEqual(
        m.agents.get(s)?.snapshot().status,
        "stopped",
        `a sibling must be untouched (#142): ${s}`,
      );
    }
  } finally {
    await stopAll(m);
  }
});

test("no ids still stops every child (#142)", async () => {
  const { m, siblings } = await tree(0, 2);
  try {
    const r = await m.stopChildrenFor("root");
    await settle();
    assert.deepEqual([...r.stopped].sort(), [...siblings].sort(), "both children reported (#142)");
    for (const s of siblings) {
      assert.equal(m.agents.get(s)?.snapshot().status, "stopped", `${s} must stop (#142)`);
    }
  } finally {
    await stopAll(m);
  }
});
