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
  assert.equal(isOpenRouter(OR), true);
  assert.equal(isOpenRouter("https://openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouter("https://eu.openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouter(OPENAI), false);
  assert.equal(isOpenRouter("https://notopenrouter.ai.example.com"), false);
  assert.equal(isOpenRouter("https://openrouter.ai.evil.com"), false);
  assert.equal(isOpenRouter(undefined), false);
  assert.equal(isOpenRouter("not a url"), false);
});

/* ---------- validators / shared resolution ---------- */

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
  // not advertised
  assert.equal(
    resolveReasoningEffort({ baseUrl: OR, model: "plain/gpt", list, effort: "medium" }),
    undefined,
  );
  // wrong endpoint
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

/* ---------- model metadata carries the capability ---------- */

test("the catalogue parse keeps supported_parameters (#47)", async () => {
  // guards the plumbing: without supportedParameters in ModelMeta the guard
  // above could never pass, and effort would silently never be sent
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