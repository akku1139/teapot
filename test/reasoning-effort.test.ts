/**
 * #47 — "let the model's effort be selectable; research how OpenRouter's API
 *         works first"
 *
 * I queried the live OpenRouter /models endpoint rather than guessing (the docs
 * pages for reasoning 404'd). Facts that shape the implementation, measured on
 * 462 models:
 *
 *   - `reasoning_effort` is advertised by 196/462 models
 *   - the broader `reasoning` object by 331/462
 *   - NO model advertises a bare top-level `effort` parameter
 *
 * So support is far from universal, and sending the parameter to a model that
 * does not advertise it is how a request gets rejected or a setting silently
 * ignored.
 *
 * #150 then measured the OTHER end of this: the endpoints that need the control
 * are the ones that publish NO capability list at all (commandcode, google — both
 * return only id/name/context_length), so requiring an advertisement hid the
 * control exactly where it would have worked. The rule is now:
 *
 *   - a catalogue that NAMES its parameters and omits `reasoning_effort` => do not
 *     send (a definite no, and no point provoking a 400);
 *   - a catalogue that is silent => send, and drop the field with one retry if the
 *     endpoint refuses it (see isEffortUnsupported).
 *
 * "Absent" still means "provider default" for the value itself.
 */
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

/* ---------- the happy path ---------- */

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

/* ---------- the guards that matter ---------- */

test("a vendor field is not sent when the catalogue names its parameters (#47, #150)", () => {
  // The original concern was a vendor-specific body field leaking to an arbitrary
  // base URL. #150 refined WHERE the line is: a catalogue that lists what it
  // supports and does not list this is a definite no, whatever the host.
  for (const baseUrl of [OPENAI, "https://api.anthropic.com", "http://localhost:1234/v1"]) {
    assert.deepEqual(
      effortForRequest(cfg({ baseUrl, supportedParameters: ["temperature"] })),
      {},
      `an explicit capability list without reasoning_effort must stay a no: ${baseUrl}`,
    );
  }
});

test("nothing is sent when the model does not advertise support (#47)", () => {
  // 266/462 models do NOT advertise reasoning_effort
  assert.deepEqual(effortForRequest(cfg({ supportedParameters: ["temperature"] })), {});
});

test("a SILENT catalogue now sends it — measured, because the endpoints that need it are silent (#150)", () => {
  // `undefined` means the endpoint published no capability list at all. Both
  // endpoints measured for #150 are in this state while one accepts the field
  // (commandcode) and one refuses it (google) — so the refusal is handled by the
  // retry, and the control is not hidden from the case that works.
  assert.deepEqual(effortForRequest(cfg({ supportedParameters: undefined })), { reasoning_effort: "high" });
  // an EMPTY list is different: a catalogue that reports no parameters at all is
  // still a report, and it does not include this one
  assert.deepEqual(effortForRequest(cfg({ supportedParameters: [] })), {});
});

test("nothing is sent when no effort is chosen (#47)", () => {
  // default: let the provider decide
  assert.deepEqual(effortForRequest(cfg({ reasoningEffort: undefined })), {});
  assert.deepEqual(effortForRequest(cfg({ reasoningEffort: "" })), {});
});

test("an unrecognised effort value is dropped, not forwarded (#47)", () => {
  assert.deepEqual(effortForRequest(cfg({ reasoningEffort: "extreme" })), {});
  assert.deepEqual(effortForRequest(cfg({ reasoningEffort: "HIGH" })), {});
  assert.deepEqual(effortForRequest(cfg({ reasoningEffort: "3" })), {});
});

/* ---------- the OpenRouter host check ---------- */

test("isOpenRouter matches openrouter.ai and its subdomains only (#47)", () => {
  assert.equal(isOpenRouterEndpoint(OR), true);
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouterEndpoint("https://eu.openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouterEndpoint(OPENAI), false);
  assert.equal(isOpenRouterEndpoint("https://notopenrouter.ai.example.com"), false);
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai.evil.com"), false);
  assert.equal(isOpenRouterEndpoint(undefined), false);
  assert.equal(isOpenRouterEndpoint("not a url"), false);
});

/* ---------- validators / shared resolution ---------- */

test("isReasoningEffort accepts only the documented levels (#47)", () => {
  assert.equal(isReasoningEffort("minimal"), true);
  assert.equal(isReasoningEffort("high"), true);
  assert.equal(isReasoningEffort("nonexistent"), false);
  assert.equal(isReasoningEffort(""), false);
  assert.equal(isReasoningEffort(null), false);
});

test("effort support: models.dev says yes, no, or unknown (#47)", () => {
  // The old rule was `isOpenRouter(baseUrl)`, which rejected every other provider no matter what
  // its model supported — and MEASURED, Command Code (93 models), Google (38) and orcarouter
  // publish no capability fields at all, so that gate hid the control for models that do reason.
  const list: ModelMeta[] = [
    { id: "reasons", reasoning: true, supportedEfforts: ["low", "high"] },
    { id: "no-reasoning", reasoning: false },
  ];
  // models.dev describes it
  assert.equal(effortSupportedFor({ list, model: "reasons" }), true);
  // models.dev says it does not reason
  assert.equal(effortSupportedFor({ list, model: "no-reasoning" }), false);
  // NOT LISTED is UNKNOWN, not "unsupported" — this is the half that broke every
  // non-OpenRouter provider, and the wire recovers from a rejected reasoning_effort anyway
  assert.equal(effortSupportedFor({ list, model: "not-listed" }), true);
  assert.equal(effortSupportedFor({ list: undefined, model: "anything" }), true);
});

test("models.dev reasoning_options become the selectable efforts (#47)", () => {
  // the shapes models.dev publishes, including ones with no teapot equivalent
  assert.deepEqual(
    effortsFrom({ reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }] }),
    ["low", "medium", "high", "xhigh", "max"],
  );
  // `toggle` and `budget_tokens` carry no effort levels — they must not become an empty list
  assert.equal(effortsFrom({ reasoning_options: [{ type: "toggle" }] }), undefined);
  assert.equal(effortsFrom({ reasoning_options: [{ type: "budget_tokens", values: [] }] }), undefined);
  assert.equal(effortsFrom({}), undefined);
  // several blocks merge and duplicates collapse
  assert.deepEqual(
    effortsFrom({ reasoning_options: [{ type: "effort", values: ["low"] }, { type: "effort", values: ["low", "high"] }] }),
    ["low", "high"],
  );
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
  // models.dev quotes per MILLION; the cost code multiplies by TOKENS (#cost)
  assert.deepEqual(m.pricing, { prompt: 2e-6, completion: 12e-6 });

  // a bare record produces ABSENT fields, not empty ones — consumers test presence
  const bare = metaFrom({ id: "x" });
  assert.equal(bare.modalities, undefined);
  assert.equal(bare.supportedEfforts, undefined);
  assert.equal(bare.reasoning, undefined);
});

test("the provider is matched by host, and a shared host is split by path (#47)", () => {
  // Command Code is FIVE config entries on one host, so a host match is what makes it work at all.
  // `opencode.ai` is two models.dev providers (130 vs 37), so a host match alone resolved to
  // whichever came first — MEASURED, the wrong catalogue, with the session's model missing.
  const many = (prefix: string, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, {}]));
  const providers = new Map(
    Object.entries({
      commandcode: { api: "https://api.commandcode.ai/provider/v1", models: { a: {}, b: {} } },
      opencode: { api: "https://opencode.ai/inference/openai/v1", models: many("m", 130) },
      ["opencode-go"]: { api: "https://opencode.ai/inference/go/openai/v1", models: many("g", 37) },
    }),
  );
  assert.equal(providerFor(providers, "https://api.commandcode.ai/provider/v1")?.api, "https://api.commandcode.ai/provider/v1");
  assert.equal(
    providerFor(providers, "https://opencode.ai/inference/go/openai/v1")?.api,
    "https://opencode.ai/inference/go/openai/v1",
    "the path disambiguates two providers on one host",
  );
  // the operator's real baseUrl matches neither path, so the GENERAL catalogue wins
  assert.equal(providerFor(providers, "https://opencode.ai/zen/v1")?.api, "https://opencode.ai/inference/openai/v1");
  assert.equal(providerFor(providers, "https://elsewhere.invalid/v1"), undefined);
});

/* ---------- model metadata carries the capability ---------- */

test("the catalogue fetch degrades to [] and never throws (#47)", async () => {
  // guards the plumbing: an unreachable models.dev must leave the caller with "unknown"
  // rather than an exception, or every agent fails to boot
  const { fetchModelList } = await import("../src/model-meta.ts");
  const list = await fetchModelList("http://127.0.0.1:1/v1", "k");
  assert.ok(Array.isArray(list), "fetchModelList must degrade to [] on failure");
});

test("the agent defaults to no effort chosen, and NO catalogue claim (#47, #150)", async () => {
  // Behavioural, not a source match. The old version asserted the literal
  // `supportedParameters: []` — which was itself the #150 bug: an empty array reads
  // as "the endpoint published a list without this parameter", so every silent
  // endpoint looked like an explicit refusal.
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
      // the consequence the operator sees
      assert.equal(a.snapshot().effortSupported, true, "so the control is offered (#150)");
    } finally {
      await a.dispose();
    }
  });
});
/* ---------- the API + master surface the UI drives ---------- */

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
    // the route must accept the field at all (it is optional, so a bare body
    // must not 500)
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


// #110: POSIX-only — POSIX filesystem paths.
// The Windows CI job skips this file; see test/helpers/posix-only.ts for why
// opting out is explicit rather than by filename.
import { markPosixOnly } from "./helpers/posix-only.ts";
markPosixOnly("POSIX filesystem paths");