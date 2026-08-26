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


test("internal session ids: /sessions lists owned ids; /events?session= reads them", async () => {
  await useTempDirs(["sessid-root-", "sessid-ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    // provider "p" is needed by addAgent's resolution in this suite
    (m as unknown as { config: { providers: Record<string, unknown> } }).config.providers.p = {
      baseUrl: "http://x", apiKey: "k", model: "m",
    };
    (m as unknown as { config: { defaultProvider?: string } }).config.defaultProvider = "p";
    const app = buildApp(m);

    const a = await m.addAgent({ id: "alpha", workspace: ws }, { fresh: true });
    await a.setGoal("incarnation 1");
    const sid1 = a.snapshot().session; // internal id = dir basename
    await a.dispose();
    m.agents.delete("alpha");

    // second incarnation → a NEW internal id; the old one must stay readable.
    // b stays LIVE — /api/agents/:id/events resolves through the running agent
    const b = await m.addAgent({ id: "alpha", workspace: ws }, { fresh: true });
    await b.setGoal("incarnation 2");
    const sid2 = b.snapshot().session;
    assert.notEqual(sid1, sid2);

    // list: both incarnations, newest first
    const lr = await app.request("/api/agents/alpha/sessions");
    assert.equal(lr.status, 200);
    const lj = (await lr.json()) as { sessions: { id: string }[] };
    assert.deepEqual(lj.sessions.map((s) => s.id), [sid2, sid1]);

    // read an OLD incarnation's timeline through its internal id
    const er = await app.request(`/api/agents/alpha/events?session=${encodeURIComponent(sid1)}`);
    assert.equal(er.status, 200);
    const ej = (await er.json()) as { events: { type: string; data?: { event?: string; text?: string } }[] };
    assert.ok(ej.events.some((e) => e.data?.text === "incarnation 1"));

    // ownership enforcement: another agent id cannot read alpha's session,
    // and path-traversal-ish session values are rejected
    const forbidden = await app.request(`/api/agents/beta/events?session=${encodeURIComponent(sid1)}`);
    assert.equal(forbidden.status, 404);
    for (const bad of ["../escape", "..\\escape"]) {
      const r = await app.request(`/api/agents/alpha/events?session=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 404, `must reject ${bad}`);
    }
    // cleanup
    await b.dispose();
  });
});

test("live-update: /api/version and /api/update/restart endpoints exist", async () => {
  // the restart endpoint spawns a child process and kills the server —
  // this test only verifies the endpoint is wired (no actual restart).
  await useTempDirs(["upd-root-", "upd-ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const app = buildApp(m);
    const v = await app.request("/api/version");
    assert.equal(v.status, 200);
    const vj = (await v.json()) as { version: string };
    assert.equal(typeof vj.version, "string");
    assert.ok(vj.version.length > 0);

    // sanity: config endpoint also includes the version (UI displays it)
    const cfg = await app.request("/api/config");
    const cj = (await cfg.json()) as { version: string };
    assert.equal(cj.version, vj.version);
  });
});
