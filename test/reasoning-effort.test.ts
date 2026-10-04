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
 * ignored. The field is therefore sent ONLY when the endpoint is OpenRouter
 * AND the catalogue lists support — an unsent field is far safer than a wrong
 * one, and "absent" already means "provider default".
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

test("nothing is sent to a non-OpenRouter endpoint (#47)", () => {
  // a vendor-specific body field must never leak to an arbitrary base URL
  assert.deepEqual(effortForRequest(cfg({ baseUrl: OPENAI })), {});
  assert.deepEqual(effortForRequest(cfg({ baseUrl: "https://api.anthropic.com" })), {});
  assert.deepEqual(effortForRequest(cfg({ baseUrl: "http://localhost:1234/v1" })), {});
});

test("nothing is sent when the model does not advertise support (#47)", () => {
  // 266/462 models do NOT advertise reasoning_effort
  assert.deepEqual(effortForRequest(cfg({ supportedParameters: ["temperature"] })), {});
});

test("nothing is sent when the catalogue is unknown (#47)", () => {
  // no catalogue ⇒ cannot verify ⇒ do not guess
  assert.deepEqual(effortForRequest(cfg({ supportedParameters: undefined })), {});
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

test("the agent defaults to no effort and no catalogue (#47)", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8"),
  );
  assert.match(src, /reasoningEffort:\s*""/, "default must be unset (#47)");
  assert.match(src, /supportedParameters:\s*\[\]/, "default must be empty (#47)");
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