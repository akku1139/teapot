import { test } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { Master } from "../src/master.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

async function spawnAndCollectPrompts() {
  const dataDir = mkdtempInRootSync("t130a-");
  const ws = mkdtempInRootSync("t130w-");
  const m = new Master(
    {
      port: 0,
      dataDir,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
      providers: {},
      agents: [],
    },
    path.join(dataDir, "config.json"),
  );
  const parent = await m.addAgent({ id: "p1", workspace: ws }, { persist: false });
  const prompts: string[] = [];
  const orig = parent.enqueuePrompt.bind(parent);
  parent.enqueuePrompt = (t: string, s?: string, i?: unknown) => {
    prompts.push(String(t));
    return orig(t, s, i as never);
  };
  await m.spawnChildFor(parent, { task: "do a thing", context: "none" });
  await new Promise((r) => setTimeout(r, 300));
  for (const a of [...m.agents.values()]) a.stop("test done");
  for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
  return { prompts };
}

test("spawning a sub-agent does NOT tell the parent it is idle (#130)", async () => {
  const { prompts } = await spawnAndCollectPrompts();
  const spurious = prompts.filter((p) => /is now idle/.test(p));
  assert.deepEqual(
    spurious,
    [],
    `a freshly spawned child must not be reported as settled (#130): ${JSON.stringify(spurious[0])}`,
  );
});
