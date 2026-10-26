/**
 * #150 — "reasoning effort is not offered outside OpenRouter".
 *
 * Reported for `commandcode-goat` (DeepSeek V4.1 Flash): the dropdown never
 * appeared. The old gate required the endpoint to be OpenRouter AND its catalogue
 * to advertise `reasoning_effort`.
 *
 * MEASURED against the live endpoints before designing the fix (one probe each,
 * `max_tokens: 3` with `reasoning_effort: "low"`), plus what each PUBLISHES in
 * `/models`:
 *
 *   commandcode-goat   200 OK, reply carried `reasoning_content`
 *                      publishes only id/name/context_length — NO capability list
 *   google             400 "Thinking level is not supported for this model."
 *                      publishes no capability list either
 *   openrouter         documented; `supported_parameters` per model
 *
 * So the endpoints that need the control are exactly the ones that CANNOT say
 * whether they support it. Gating on a published capability list therefore hides
 * the control where it would have worked, and a config flag pushes the burden onto
 * the operator. The design that follows from the measurement:
 *
 *   - offer the control unless the catalogue EXPLICITLY excludes the parameter
 *   - try the field; if the endpoint refuses it, drop it and retry once
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effortForRequest,
  effortChoosable,
  isEffortUnsupported,
  type LlmConfig,
} from "../src/agent/llm.ts";

const base = { apiKey: "k", model: "m", reasoningEffort: "high" } as const;

/** accepts the field, publishes no capability list (the reported case) */
const COMMANDCODE: LlmConfig = { ...base, baseUrl: "https://api.commandcode.ai/provider/v1" };

/** refuses the field with a 400, and also publishes no capability list */
const _GOOGLE: LlmConfig = { ...base, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" };

/* ---------- sending ---------- */

test("a provider with no capability list still gets the field (#150)", () => {
  assert.deepEqual(
    effortForRequest(COMMANDCODE),
    { reasoning_effort: "high" },
    "the endpoints that need this cannot advertise it, so silence must not mean no (#150)",
  );
});

test("`undefined` and `[]` are DIFFERENT answers, and conflating them hid the fix (#150)", () => {
  // The bug that made the first #150 attempt inert: the agent's default was `[]`,
  // so an endpoint that published NO capability list was indistinguishable from one
  // that published a list excluding the parameter — and every silent endpoint (both
  // measured ones) looked like an explicit refusal. The control stayed hidden and
  // the field was never sent, so the fix did nothing at all.
  //
  // `undefined` = published nothing = worth trying.
  assert.deepEqual(effortForRequest({ ...COMMANDCODE, supportedParameters: undefined }), {
    reasoning_effort: "high",
  });
  assert.equal(effortChoosable(undefined), true);
  // `[]` = a list was published, and it does not contain the parameter.
  assert.deepEqual(effortForRequest({ ...COMMANDCODE, supportedParameters: [] }), {});
  assert.equal(effortChoosable([]), false);
});

test("a catalogue that explicitly EXCLUDES the parameter is respected (#47)", () => {
  // no point provoking a 400 from a model that tells us up front it will refuse
  const explicit = { ...COMMANDCODE, supportedParameters: ["temperature", "tools"] };
  assert.deepEqual(effortForRequest(explicit), {}, "an explicit list without it is a definite no");
});

test("a catalogue that INCLUDES the parameter keeps working (OpenRouter)", () => {
  const or: LlmConfig = {
    ...base,
    baseUrl: "https://openrouter.ai/api/v1",
    supportedParameters: ["temperature", "reasoning_effort"],
  };
  assert.deepEqual(effortForRequest(or), { reasoning_effort: "high" });
});

test("an invalid or absent level is never sent, whatever the endpoint is (#47)", () => {
  assert.deepEqual(effortForRequest({ ...COMMANDCODE, reasoningEffort: "" }), {});
  assert.deepEqual(effortForRequest({ ...COMMANDCODE, reasoningEffort: "ultra" }), {});
});

/* ---------- offering the control ---------- */

test("the control is offered when the endpoint publishes no capability list (#150)", () => {
  assert.equal(
    effortChoosable(undefined),
    true,
    "showing it and retrying on refusal beats hiding it where it would have worked (#150)",
  );
});

test("the control is HIDDEN when the catalogue says the model does not take it", () => {
  assert.equal(effortChoosable(["temperature"]), false);
  assert.equal(effortChoosable(["temperature", "reasoning_effort"]), true);
});

/* ---------- recognising the refusal ---------- */

test("Google's refusal is recognised, so the retry can drop the field (#150)", () => {
  // verbatim from the live endpoint
  const google = new Error("400 [{\"error\":{\"code\":400,\"message\":\"Thinking level is not supported for this model.\",\"status\":\"INVALID_ARGUMENT\"}}]");
  assert.equal(isEffortUnsupported(google), true);
});

test("other phrasings of an unsupported parameter are recognised", () => {
  assert.equal(isEffortUnsupported(new Error("unknown parameter: reasoning_effort")), true);
  assert.equal(isEffortUnsupported(new Error("Unsupported field reasoning_effort")), true);
});

test("an UNRELATED error is NOT mistaken for a refusal (#150)", () => {
  // retrying without the field here would silently discard the operator's choice
  // and hide the real error, so the match has to stay narrow
  assert.equal(isEffortUnsupported(new Error("invalid api key")), false);
  assert.equal(isEffortUnsupported(new Error("context length exceeded")), false);
  assert.equal(isEffortUnsupported(new Error("Thinking level is not supported for this model.")), true);
  assert.equal(isEffortUnsupported(new Error("rate limit exceeded")), false);
  assert.equal(isEffortUnsupported(undefined), false);
});
