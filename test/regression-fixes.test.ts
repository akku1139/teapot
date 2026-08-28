import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import { readEvents } from "../src/log/events.ts";

const LLM = { baseUrl: "http://mock", apiKey: "mock", model: "mock-model" };

function mkMaster(dataDir: string): Master {
  return new Master(
    { port: 0, dataDir, llm: LLM, providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } }, agents: [] },
    "/dev/null",
  );
}

test("regression: POST /api/agents/:id/edit-prompt no longer 404 and forks correctly", async () => {
  await useTempDirs(["edit-prompt-root-", "edit-prompt-ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    // need provider p for agent
    (m as any).config.providers.p = { baseUrl: "http://x", apiKey: "k", model: "m" };
    (m as any).config.defaultProvider = "p";
    const app = buildApp(m);
    const agent = await m.addAgent({ id: "alpha", workspace: ws, provider: "p", model: "m" }, { fresh: true });
    // keep agent idle — no auto-continue loop during this test
    (agent as any).opts.autoContinue = false;
    await agent.load();
    // create a prompt history directly via log (no LLM needed)
    await agent.log.append("prompt", agent.snapshot().session, agent.snapshot().branch, { source: "user", text: "original prompt" });
    await agent.log.append("message", agent.snapshot().session, agent.snapshot().branch, { role: "assistant", content: "reply" });

    const events = await readEvents(agent.log.filePath);
    const promptEv = events.find((e) => e.type === "prompt")!;
    assert.ok(promptEv, "prompt event must exist");

    // HTTP edit-prompt: should be 200, not 404
    const res = await app.request(`/api/agents/alpha/edit-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: promptEv.id, text: "edited prompt text", tail: "discard" }),
    });
    if (res.status !== 200) {
      const txt = await res.text();
      assert.fail(`edit-prompt should be 200, got ${res.status}: ${txt}`);
    }
    const j = await res.json() as any;
    assert.equal(j.ok, true);
    assert.ok(j.branch, "branch returned");
    assert.ok(typeof j.droppedEvents === "number");

    // verify fork event was logged
    const ev2 = await readEvents(agent.log.filePath);
    const fork = ev2.find((e) => e.type === "fork" && (e.data as any).reason === "prompt-edited");
    assert.ok(fork, "fork event with prompt-edited reason must exist");
    const lastPrompt = ev2.filter((e) => e.type === "prompt").at(-1)!;
    assert.equal((lastPrompt.data as any).text, "edited prompt text");

    // invalid request should be 400, not 404
    const bad = await app.request(`/api/agents/alpha/edit-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "missing id" }),
    });
    assert.equal(bad.status, 400);

    // editing while running should be 409 — put agent into running with a hanging LLM
    (agent as any).opts.chatFn = async (_c: any, _m: any, _t: any, signal: any) =>
      new Promise((_res, rej) => signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    (agent as any).opts.autoContinue = false;
    agent.enqueuePrompt("second");
    agent.start("hang");
    await new Promise((r) => setTimeout(r, 60));
    if (agent.status === "running") {
      const runningRes = await app.request(`/api/agents/alpha/edit-prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId: promptEv.id, text: "x", tail: "discard" }),
      });
      assert.equal(runningRes.status, 409);
      agent.stop("cleanup");
      await agent.settled();
    }

    await agent.dispose();
  });
});

test("regression: POST /api/agents/:id/model switches provider/model and API is reachable", async () => {
  await useTempDirs(["model-switch-root-", "model-switch-ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    (m as any).config.providers.openrouter = { baseUrl: "https://openrouter.ai/api/v1", model: "old-model" };
    (m as any).config.providers.anthropic = { baseUrl: "https://api.anthropic.com", model: "claude" };
    (m as any).config.defaultProvider = "openrouter";
    const app = buildApp(m);
    const agent = await m.addAgent({ id: "beta", workspace: ws, provider: "openrouter", model: "old-model" }, { fresh: true });
    assert.equal(agent.snapshot().model, "old-model");
    assert.equal(agent.snapshot().provider, "openrouter");

    const res = await app.request(`/api/agents/beta/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", model: "new-model", contextWindowTokens: 200_000 }),
    });
    if (res.status !== 200) {
      const txt = await res.text();
      assert.fail(`model switch should be 200, got ${res.status}: ${txt}`);
    }
    const j = await res.json() as any;
    assert.equal(j.ok, true);

    // snapshot reflects new model/provider
    const snap = agent.snapshot();
    assert.equal(snap.model, "new-model");
    assert.equal(snap.provider, "anthropic");
    assert.equal(snap.ctx.window, 200_000);

    // GET /api/models for the new provider should be reachable (stubbed fetch may 502, but endpoint exists)
    const badProv = await app.request(`/api/models?provider=unknown`);
    assert.equal(badProv.status, 400); // unknown provider -> 400, not 404, proves endpoint exists

    await agent.dispose();
  });
});

test("regression: ConfigModal no longer loses focus — uses Index not For for editable rows", async () => {
  const src = await readFile("frontend/App.tsx", "utf8");
  // providers and tasks editable rows must be rendered with Index (keyed by position)
  assert.match(src, /Index each=\{providers\(\)\}/, "providers rows should use Index");
  assert.match(src, /Index each=\{tasks\(\)\}/, "tasks rows should use Index");
  // ensure we didn't keep the old For pattern for those rows (would recreate DOM and lose focus)
  // The old pattern was `For each={providers()}` with `value={p.name}` directly — now p is accessor
  // Check that the providers input uses p().name (accessor) not p.name
  assert.ok(src.includes("value={p().name}"), "providers input should use accessor p().name via Index");
  assert.ok(src.includes("value={t().id}"), "tasks input should use accessor t().id via Index");
  // also check that we import Index and untrack
  assert.ok(src.includes("Index") && src.includes("from \"solid-js\""), "Index must be imported");
  assert.ok(src.includes("untrack"), "untrack must be imported for model switcher fix");
});

test("regression: right panel model switcher no longer clears draft on keystroke", async () => {
  const src = await readFile("frontend/App.tsx", "utf8");
  // The fix introduces _prevModelAgent guard and untrack usage to avoid clearing draft on every poll/keystroke
  assert.match(src, /_prevModelAgent/, "model switcher should track previous agent id");
  assert.match(src, /untrack\(\(\) => modelDraft\(\)\)/, "modelDraft should be read via untrack");
  assert.match(src, /untrack\(\(\) => modelProvider\(\)\)/, "modelProvider should be read via untrack");
  // ensure the old buggy pattern `if (modelDraft()) setModelDraft("")` without untrack is gone
  // (the new code wraps it in untrack or prev check)
  const oldPattern = /createEffect\(\(\) => \{\s+const id = selected\(\);\s+const a = agents\(\)\.find.*\n.*if \(modelProvider\(\) !== prov\)/;
  assert.doesNotMatch(src, oldPattern, "old buggy effect that read modelProvider/modelDraft reactively should be gone");
});

test("regression: edit-prompt frontend integration calls correct endpoint", async () => {
  const src = await readFile("frontend/App.tsx", "utf8");
  assert.ok(src.includes('`/api/agents/${selected()}/edit-prompt`'), "frontend should call /edit-prompt");
  // ensure the MessageRow onEdit is gated to settled prompts only (not pending)
  assert.ok(src.includes("!(e.data?.pending && e.data?.sent !== true)"), "onEdit should be gated to settled prompts");
});
