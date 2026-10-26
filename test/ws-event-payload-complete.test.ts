import { test } from "node:test";
import assert from "node:assert/strict";

import { Master } from "../src/master.ts";
import { bus } from "../src/bus.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

test("a kind:\"event\" frame carries the whole logged event (#141)", async () => {
  const dataDir = mkdtempInRootSync("t141a-");
  const ws = mkdtempInRootSync("t141w-");
  const m = new Master(
    { port: 0, dataDir, llm: LLM, providers: {}, agents: [] },
    `${dataDir}/config.json`,
  );
  const a = await m.addAgent({ id: "b", workspace: ws }, { persist: false });

  type Frame = { kind: string; agentId?: string; event?: Record<string, unknown> };
  const seen: Frame[] = [];
  const handler = (ev: unknown) => seen.push(ev as Frame);
  bus.on("update", handler);
  try {
    await a.enqueuePrompt("hello");
    await new Promise((r) => setTimeout(r, 50));

    const frame = seen.find((s) => s.kind === "event" && s.event?.type === "prompt");
    assert.ok(frame, `precondition: a prompt event was broadcast (#141); got ${JSON.stringify(seen.map((s) => s.kind))}`);
    const e = frame.event!;

    for (const field of ["id", "seq", "ts", "session", "branch", "parent", "type", "data"]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(e, field),
        `the frame's event must carry \`${field}\` (#141); got keys ${JSON.stringify(Object.keys(e))}`,
      );
    }
    assert.equal(e["agent"] ?? frame.agentId, "b", "and identify its agent (#141)");
    assert.equal(typeof e["seq"], "number", "seq must be a number — the merge sorts on it (#141)");
    assert.equal(typeof e["id"], "string", "id must be a string — the merge dedupes on it (#141)");
    assert.ok(e["id"] !== "", "id must not be empty, or every row collapses to one (#141)");

    const data = e["data"] as { text?: string };
    assert.equal(
      data?.text,
      "hello",
      `the prompt's text must ride along (#141); got ${JSON.stringify(data)}`,
    );
  } finally {
    bus.off("update", handler);
    await a.dispose().catch(() => {});
    await m.removeAgent("b").catch(() => {});
  }
});

test("the client's merge is viable against a real frame (#141)", async () => {
  const dataDir = mkdtempInRootSync("t141b-");
  const ws = mkdtempInRootSync("t141x-");
  const m = new Master(
    { port: 0, dataDir, llm: LLM, providers: {}, agents: [] },
    `${dataDir}/config.json`,
  );
  const a = await m.addAgent({ id: "c", workspace: ws }, { persist: false });
  type Frame = { kind: string; event?: Record<string, unknown> };
  const seen: Frame[] = [];
  const handler = (ev: unknown) => seen.push(ev as Frame);
  bus.on("update", handler);
  try {
    await a.enqueuePrompt("first");
    await new Promise((r) => setTimeout(r, 30));
    await a.enqueuePrompt("second");
    await new Promise((r) => setTimeout(r, 30));

    const frames = seen.filter((s) => s.kind === "event" && s.event?.type === "prompt");
    assert.ok(frames.length >= 2, `precondition: two prompt frames (#141); got ${frames.length}`);
    const ids = frames.map((f) => f.event!.id as string);
    const seqs = frames.map((f) => f.event!.seq as number);
    assert.equal(new Set(ids).size, ids.length, `ids must be distinct, or rows merge (#141): ${ids}`);
    assert.ok(seqs[1]! > seqs[0]!, `seq must increase, or order is arbitrary (#141): ${seqs}`);
  } finally {
    bus.off("update", handler);
    await a.dispose().catch(() => {});
    await m.removeAgent("c").catch(() => {});
  }
});
