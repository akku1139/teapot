/**
 * #150 — "reasoning effort is not offered outside OpenRouter".
 *
 * Reported for `commandcode-goat` (DeepSeek V4.1 Flash): the dropdown never
 * appeared. The gate required the endpoint to be OpenRouter AND its catalogue to
 * advertise `reasoning_effort`, and a gateway that publishes no capability list
 * satisfied neither.
 *
 * MEASURED against the live endpoints before changing the gate (one probe each,
 * `max_tokens: 3` with `reasoning_effort: "low"`):
 *
 *   commandcode-goat   200 OK, reply carried `reasoning_content`  -> ACCEPTS
 *   google             400 "Thinking level is not supported for this model"
 *   openrouter         documented + catalogue advertises the field
 *
 * So the fix cannot be "send it everywhere": Google REJECTS the field rather than
 * ignoring it, and a 400 costs a whole turn. It is an explicit per-provider opt-in
 * on top of the existing catalogue check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { effortForRequest, type LlmConfig } from "../src/agent/llm.ts";

const base = { apiKey: "k", model: "m", reasoningEffort: "high" } as const;

/** the endpoint that reported the issue — accepts the field, advertises nothing */
const COMMANDCODE: LlmConfig = {
  ...base,
  baseUrl: "https://api.commandcode.ai/provider/v1",
  reasoningEffortOptIn: true,
};

/** the endpoint that REJECTS the field with a 400 */
const GOOGLE: LlmConfig = { ...base, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" };

test("an opted-in provider gets reasoning_effort with no catalogue to prove it (#150)", () => {
  assert.deepEqual(
    effortForRequest(COMMANDCODE),
    { reasoning_effort: "high" },
    "the reported provider must be able to use the level the operator picked (#150)",
  );
});

test("a provider that was NOT opted in still gets nothing (#150)", () => {
  // Google answers 400 "Thinking level is not supported for this model" — worse
  // than an unset field, which is why the default has to stay off
  assert.deepEqual(effortForRequest(GOOGLE), {}, "an unreported provider must not be assumed to accept it");
});

test("the catalogue still works: OpenRouter needs no opt-in (#47 stays intact)", () => {
  const or = (supported: string[] | undefined): LlmConfig => ({
    ...base,
    baseUrl: "https://openrouter.ai/api/v1",
    ...(supported ? { supportedParameters: supported } : {}),
  });
  assert.deepEqual(effortForRequest(or(["reasoning_effort"])), { reasoning_effort: "high" });
  assert.deepEqual(effortForRequest(or(["temperature"])), {}, "a catalogue that lacks it still blocks it");
  assert.deepEqual(effortForRequest(or(undefined)), {}, "and a missing catalogue is not a licence to send");
});

test("a catalogue claim from a NON-gateway host is not trusted (#150 safety rail)", () => {
  // The catalogue field is a capability claim in the OpenRouter gateway format.
  // MEASURED: google, commandcode, orcarouter and opencode all publish ZERO models
  // with `supported_parameters`, so only OpenRouter-family endpoints can reach this
  // path — which is why the host check stays even though #150 added an opt-in.
  const lyingCatalogue: LlmConfig = {
    ...base,
    baseUrl: "https://api.anthropic.com",
    supportedParameters: ["reasoning_effort"],
  };
  assert.deepEqual(
    effortForRequest(lyingCatalogue),
    {},
    "an arbitrary OpenAI-compatible host must not enable a vendor field via its catalogue",
  );
});

test("an invalid or absent level is never sent, opt-in or not (#47)", () => {
  assert.deepEqual(effortForRequest({ ...COMMANDCODE, reasoningEffort: "" }), {});
  assert.deepEqual(effortForRequest({ ...COMMANDCODE, reasoningEffort: "ultra" }), {});
});
