import { test } from "node:test";
import assert from "node:assert/strict";
import { effortForRequest } from "../src/agent/llm.ts";
import {
  REASONING_EFFORTS,
  isReasoningEffort,
  isOpenRouter,
  resolveReasoningEffort,
  type ModelMeta,
} from "../src/model-meta.ts";

const OR = "https://openrouter.ai/api/v1";
const OPENAI = "https://api.openai.com/v1";
const SUPPORTS = ["reasoning", "reasoning_effort", "include_reasoning"];

const cfg = (o: Partial<Parameters<typeof effortForRequest>[0]> = {}) =>
  ({
    baseUrl: OR,
    apiKey: "k",
    model: "anthropic/claude-sonnet-5.5",
    reasoningEffort: "high",
    supportedParameters: SUPPORTS,
    ...o,
  }) as Parameters<typeof effortForRequest>[0];

test("effort is sent when OpenRouter advertises support (#47)", () => {
  assert.deepEqual(effortForRequest(cfg()), { reasoning_effort: "high" });
});

test("every documented level is accepted (#47)", () => {
  for (const e of REASONING_EFFORTS) {
    assert.deepEqual(effortForRequest(cfg({ reasoningEffort: e })), {
      reasoning_effort: e,
    });
  }
});

test("a vendor field is not sent when the catalogue names its parameters (#47, #150)", () => {
  for (const baseUrl of [OPENAI, "https://api.anthropic.com", "http://localhost:1234/v1"]) {
    assert.deepEqual(
      effortForRequest(cfg({ baseUrl, supportedParameters: ["temperature"] })),
      {},
      `an explicit capability list without reasoning_effort must stay a no: ${baseUrl}`,
    );
  }
});

test("nothing is sent when the model does not advertise support (#47)", () => {
  assert.deepEqual(effortForRequest(cfg({ supportedParameters: ["temperature"] })), {});
});

test("a SILENT catalogue now sends it — measured, because the endpoints that need it are silent (#150)", () => {
  assert.deepEqual(effortForRequest(cfg({ supportedParameters: undefined })), { reasoning_effort: "high" });
  assert.deepEqual(effortForRequest(cfg({ supportedParameters: [] })), {});
});

test("nothing is sent when no effort is chosen (#47)", () => {
  assert.deepEqual(effortForRequest(cfg({ reasoningEffort: undefined })), {});
  assert.deepEqual(effortForRequest(cfg({ reasoningEffort: "" })), {});
});

test("an unrecognised effort value is dropped, not forwarded (#47)", () => {
  assert.deepEqual(effortForRequest(cfg({ reasoningEffort: "extreme" })), {});
  assert.deepEqual(effortForRequest(cfg({ reasoningEffort: "HIGH" })), {});
  assert.deepEqual(effortForRequest(cfg({ reasoningEffort: "3" })), {});
});

test("isOpenRouter matches openrouter.ai and its subdomains only (#47)", () => {
  assert.equal(isOpenRouter(OR), true);
  assert.equal(isOpenRouter("https://openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouter("https://eu.openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouter(OPENAI), false);
  assert.equal(isOpenRouter("https://notopenrouter.ai.example.com"), false);
  assert.equal(isOpenRouter("https://openrouter.ai.evil.com"), false);
  assert.equal(isOpenRouter(undefined), false);
  assert.equal(isOpenRouter("not a url"), false);
});

test("isReasoningEffort accepts only the documented levels (#47)", () => {
  assert.equal(isReasoningEffort("minimal"), true);
  assert.equal(isReasoningEffort("high"), true);
  assert.equal(isReasoningEffort("nonexistent"), false);
  assert.equal(isReasoningEffort(""), false);
  assert.equal(isReasoningEffort(null), false);
});

test("resolveReasoningEffort agrees with effortForRequest (#47)", () => {
  const list: ModelMeta[] = [
    { id: "anthropic/claude-sonnet-5.5", supportedParameters: SUPPORTS },
    { id: "plain/gpt", supportedParameters: ["temperature"] },
  ];
  assert.equal(
    resolveReasoningEffort({
      baseUrl: OR,
      model: "anthropic/claude-sonnet-5.5",
      list,
      effort: "medium",
    }),
    "medium",
  );
  assert.equal(
    resolveReasoningEffort({ baseUrl: OR, model: "plain/gpt", list, effort: "medium" }),
    undefined,
  );
  assert.equal(
    resolveReasoningEffort({
      baseUrl: OPENAI,
      model: "anthropic/claude-sonnet-5.5",
      list,
      effort: "medium",
    }),
    undefined,
  );
});

test("the catalogue parse keeps supported_parameters (#47)", async () => {
  const { fetchModelList } = await import("../src/model-meta.ts");
  const list = await fetchModelList("http://127.0.0.1:1/v1", "k");
  assert.ok(Array.isArray(list), "fetchModelList must degrade to [] on failure");
});

test("the agent defaults to no effort chosen, and NO catalogue claim (#47, #150)", async () => {
  const { Agent } = await import("../src/agent/agent.ts");
  const { useTempDirs } = await import("./helpers/tmp.ts");
  await useTempDirs(["e47d-", "e47e-"], async ([ws, sessionDir]) => {
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sessionDir!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
      autoContinue: false,
    } as never);
    await a.init();
    try {
      const opts = (a as unknown as { opts: { reasoningEffort?: string; supportedParameters?: string[] } })
        .opts;
      assert.equal(opts.reasoningEffort, "", "no level chosen by default (#47)");
      assert.equal(
        opts.supportedParameters,
        undefined,
        "and NO capability claim: undefined means 'published nothing', which is worth trying; [] would mean 'published, excludes it' (#150)",
      );
      assert.equal(a.snapshot().effortSupported, true, "so the control is offered (#150)");
    } finally {
      await a.dispose();
    }
  });
});

test("POST /api/agents/:id/model accepts a reasoning effort (#47)", async () => {
  const { Master } = await import("../src/master.ts");
  const { buildApp } = await import("../src/server/api.ts");
  const { useTempDirs } = await import("./helpers/tmp.ts");
  await useTempDirs(["e47a-", "e47b-"], async ([dataDir, ws]) => {
    const m = new Master(
      {
        port: 0, dataDir,
        llm: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "anthropic/claude-sonnet-5.5" },
        providers: {}, agents: [],
      } as never,
      "/dev/null",
    );
    await m.addAgent({ id: "a", workspace: ws } as never, { persist: false });
    const app = buildApp(m);
    const res = await app.request("/api/agents/a/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoningEffort: "high" }),
    });
    assert.ok(res.status === 200 || res.status === 400, `unexpected status ${res.status}`);
    await m.stopAllAgents(2_000);
  });
});

test("the snapshot reports effort support so the UI can gate the control (#47)", async () => {
  const { Master } = await import("../src/master.ts");
  const { useTempDirs } = await import("./helpers/tmp.ts");
  await useTempDirs(["e47c-", "e47d-"], async ([dataDir, ws]) => {
    const m = new Master(
      {
        port: 0, dataDir,
        llm: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "anthropic/claude-sonnet-5.5" },
        providers: {}, agents: [],
      } as never,
      "/dev/null",
    );
    const a = await m.addAgent({ id: "a", workspace: ws } as never, { persist: false });
    const snap = a.snapshot();
    assert.equal(
      typeof snap.effortSupported,
      "boolean",
      "the snapshot must carry effortSupported for the UI gate (#47)",
    );
    await m.stopAllAgents(2_000);
  });
});

import { markPosixOnly } from "./helpers/posix-only.ts";
markPosixOnly("POSIX filesystem paths");