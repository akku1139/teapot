import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function mkMaster(dataDir: string): Master {
  return new Master(
    { port: 0, dataDir, llm: LLM, providers: {}, agents: [] },
    "/dev/null",
  );
}

test("POST /api/agents auto-suffixes colliding ids", async () => {
  await useTempDirs(["ids-root-", "proj-a-", "proj-b-"], async ([dataDir, wsA, wsB]) => {
    const m = mkMaster(dataDir);
    const app = buildApp(m);

    // both workspaces basename to a distinct temp name; force the SAME id via
    // body.id twice → second creation must be auto-suffixed, not rejected
    const r1 = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: wsA, id: "proj", start: false }),
    });
    assert.equal(r1.status, 200);
    const j1 = (await r1.json()) as { agent: { id: string } };
    assert.equal(j1.agent.id, "proj");

    const r2 = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: wsB, id: "proj", start: false }),
    });
    assert.equal(r2.status, 200);
    const j2 = (await r2.json()) as { agent: { id: string } };
    assert.equal(j2.agent.id, "proj-2"); // unique URL key, no error

    // duplicate ids in config are skipped at boot instead of killing master
    const bad = new Master(
      { port: 0, dataDir, llm: LLM, providers: {}, agents: [
        { id: "dup", workspace: wsA },
        { id: "dup", workspace: wsB },
      ] },
      "/dev/null",
    );
    await bad.start(); // must not throw
    assert.equal([...bad.agents.keys()].filter((k) => k === "dup").length, 1);
    for (const a of [...m.agents.values(), ...bad.agents.values()]) await a.dispose();
  });
});

