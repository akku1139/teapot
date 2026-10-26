import { test } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { Master } from "../src/master.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

async function tree() {
  const dataDir = mkdtempInRootSync("t135a-");
  const ws = mkdtempInRootSync("t135w-");
  const m = new Master(
    { port: 0, dataDir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, providers: {}, agents: [] },
    path.join(dataDir, "config.json"),
  );
  const parent = await m.addAgent({ id: "p1", workspace: ws }, { persist: true });
  await m.spawnChildFor(parent, { task: "investigate X", context: "none" });
  const kid = m.agents.get("p1-sub")!;
  const got: string[] = [];
  const orig = parent.enqueuePrompt.bind(parent);
  parent.enqueuePrompt = (t: string, s?: string, i?: unknown) => {
    got.push(String(t));
    return orig(t, s, i as never);
  };
  const stop = async () => {
    for (const a of [...m.agents.values()]) a.stop("done");
    for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
  };
  return { m, parent, kid, got, stop };
}

async function nudgeFor(status: string): Promise<string> {
  const { m, kid, got, stop } = await tree();
  try {
    (m as unknown as { reportedRunning: Set<string> }).reportedRunning.add("p1-sub");
    const set = (kid as unknown as { setStatus(s: string, r?: string): void }).setStatus.bind(kid);
    set("running", "precondition");
    await new Promise((r) => setTimeout(r, 30));
    got.length = 0; 
    set(status, "test");
    await new Promise((r) => setTimeout(r, 150));
    return got.at(-1) ?? "";
  } finally {
    await stop();
  }
}

test("the nudge no longer tells the PARENT to finish() (#135)", async () => {
  const nudge = await nudgeFor("idle");
  assert.ok(nudge.length > 0, "precondition: the parent is told something (#135)");
  assert.doesNotMatch(
    nudge,
    /Continue your task/,
    `#135: that instruction is addressed to the parent, which is not what the message is about — got ${nudge}`,
  );
  assert.doesNotMatch(
    nudge,
    /or finish\(\) if the work is done/,
    `and it invited the parent to finish() its OWN goal over a child's status (#135) — got ${nudge}`,
  );
});

test("it says the child did NOT call finish() (#135)", async () => {
  const nudge = await nudgeFor("idle");
  assert.match(
    nudge,
    /without having called finish\(\)/,
    `the absence of a report is the point (#135); got ${nudge}`,
  );
  assert.match(nudge, /has not reported a result/, "and says so plainly (#135)");
});

test("it is prefixed and names the sub-agent (#135)", async () => {
  const nudge = await nudgeFor("idle");
  assert.ok(nudge.startsWith("[harness] "), "must be identifiable as harness text (#135)");
  assert.match(nudge, /Sub-agent @p1-sub/, "and name the child (#135)");
});

test("each status gets advice that fits it (#135)", async () => {
  const stopped = await nudgeFor("stopped");
  assert.match(stopped, /stopped mid-task/, `stopped means resume-or-respawn (#135); got ${stopped}`);
  const error = await nudgeFor("error");
  assert.match(error, /Check its last output/, `error means look first (#135); got ${error}`);
  const waiting = await nudgeFor("waiting");
  assert.doesNotMatch(
    waiting,
    /stopped without calling/,
    `the old wording read "is now waiting — it stopped" (#135); got ${waiting}`,
  );
});

