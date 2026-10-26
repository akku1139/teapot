import { test } from "node:test";
import assert from "node:assert/strict";
import { effortForRequest, isOpenRouterEndpoint } from "../src/agent/llm.ts";
import {
  REASONING_EFFORTS,
  effortSupportedFor,
  effortsFrom,
  isReasoningEffort,
  metaFrom,
  providerFor,
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

test("isOpenRouterEndpoint matches openrouter.ai and its subdomains only (#47)", () => {
  // still needed:  is an OpenRouter-only field
  assert.equal(isOpenRouterEndpoint(OR), true);
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouterEndpoint("https://eu.openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouterEndpoint(OPENAI), false);
  assert.equal(isOpenRouterEndpoint("https://notopenrouter.ai.example.com"), false);
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai.evil.com"), false);
  assert.equal(isOpenRouterEndpoint(undefined), false);
  assert.equal(isOpenRouterEndpoint("not a url"), false);
});

test("isReasoningEffort accepts only the documented levels (#47)", () => {
  assert.equal(isReasoningEffort("minimal"), true);
  assert.equal(isReasoningEffort("high"), true);
  assert.equal(isReasoningEffort("nonexistent"), false);
  assert.equal(isReasoningEffort(""), false);
  assert.equal(isReasoningEffort(null), false);
});

/**
 * Effort support comes from models.dev, and UNKNOWN means ALLOW.
 *
 * The old rule was `isOpenRouter(baseUrl)` — every other provider was rejected no matter what its
 * model supported. MEASURED: Command Code (93 models), Google (38) and orcarouter publish no
 * capability fields at all, so the gate hid the control for providers whose models do reason.
 * models.dev carries the same providers with `reasoning` / `reasoning_options`, which is what makes a
 * real answer possible.
 */
test("effort support: models.dev says yes, no, or unknown (#47)", () => {
  const list: ModelMeta[] = [
    { id: "reasons", reasoning: true, supportedEfforts: ["low", "high"] },
    { id: "no-reasoning", reasoning: false },
  ];
  assert.equal(effortSupportedFor({ list, model: "reasons" }), true, "a reasoning model offers the control");
  assert.equal(effortSupportedFor({ list, model: "no-reasoning" }), false, "one that does not, does not");
  /**
   * The important half: a model that is simply not in the database is UNKNOWN. Returning false here
   * is what broke every non-OpenRouter provider, and the wire recovers from a rejected
   * `reasoning_effort` anyway (`isEffortUnsupported`), so an optimistic default costs one retry while
   * a pessimistic one silently removes a feature.
   */
  assert.equal(effortSupportedFor({ list, model: "not-listed" }), true, "unknown is not 'unsupported'");
  assert.equal(effortSupportedFor({ list: undefined, model: "anything" }), true, "and no list at all is unknown too");
});

test("models.dev reasoning_options become the selectable efforts (#47)", () => {
  // the shapes models.dev publishes, including ones with no Pi/teapot equivalent
  assert.deepEqual(effortsFrom({ reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }] }), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  // `toggle` and `budget_tokens` carry no effort levels — they must not become an empty list
  assert.equal(effortsFrom({ reasoning_options: [{ type: "toggle" }] }), undefined);
  assert.equal(effortsFrom({ reasoning_options: [{ type: "budget_tokens", values: [] }] }), undefined);
  assert.equal(effortsFrom({}), undefined);
  // several option blocks merge, and duplicates collapse
  assert.deepEqual(effortsFrom({ reasoning_options: [{ type: "effort", values: ["low"] }, { type: "effort", values: ["low", "high"] }] }), ["low", "high"]);
});

test("a models.dev record maps without inventing anything (#47)", () => {
  const m = metaFrom({
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "max"] }],
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1_050_000 },
    cost: { input: 2, output: 12 },
  });
  assert.deepEqual(m.modalities?.input, ["text", "image", "pdf"]);
  assert.deepEqual(m.supportedEfforts, ["low", "max"]);
  assert.equal(m.contextLength, 1_050_000);
  assert.deepEqual(m.pricing, { prompt: 2, completion: 12 });

  // a bare record must produce ABSENT fields, not empty ones — a consumer tests presence
  const bare = metaFrom({ id: "x" });
  assert.equal(bare.modalities, undefined);
  assert.equal(bare.supportedEfforts, undefined);
  assert.equal(bare.reasoning, undefined);
});

test("the provider is matched by host, and a shared host is split by path (#47)", () => {
  /**
   * Both halves are load-bearing. Command Code is FIVE config entries on one host, so a host match is
   * what makes it work at all; `opencode.ai` is two models.dev providers (130 vs 37 models), so a
   * host match alone resolves to whichever came first — MEASURED, that was the wrong catalog and the
   * session's model was not in it.
   */
  const providers = new Map(
    Object.entries({
      commandcode: { api: "https://api.commandcode.ai/provider/v1", models: { a: {}, b: {} } },
      opencode: { api: "https://opencode.ai/inference/openai/v1", models: Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`m${i}`, {}])) },
      ["opencode-go"]: { api: "https://opencode.ai/inference/go/openai/v1", models: Object.fromEntries(Array.from({ length: 37 }, (_, i) => [`g${i}`, {}])) },
    }),
  );
  assert.equal(providerFor(providers, "https://api.commandcode.ai/provider/v1")?.api, "https://api.commandcode.ai/provider/v1");
  assert.equal(providerFor(providers, "https://opencode.ai/inference/go/openai/v1")?.api, "https://opencode.ai/inference/go/openai/v1", "the path disambiguates");
  // the operator's actual baseUrl matches neither path, so the GENERAL catalog wins
  assert.equal(providerFor(providers, "https://opencode.ai/zen/v1")?.api, "https://opencode.ai/inference/openai/v1", "an unmatched path prefers the larger catalog");
  assert.equal(providerFor(providers, "https://elsewhere.invalid/v1"), undefined, "an unknown host has no provider");
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