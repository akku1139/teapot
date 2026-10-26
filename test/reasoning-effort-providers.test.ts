import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effortForRequest,
  effortChoosable,
  isEffortUnsupported,
  type LlmConfig,
} from "../src/agent/llm.ts";

const base = { apiKey: "k", model: "m", reasoningEffort: "high" } as const;

const COMMANDCODE: LlmConfig = { ...base, baseUrl: "https://api.commandcode.ai/provider/v1" };

const _GOOGLE: LlmConfig = { ...base, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" };

test("a provider with no capability list still gets the field (#150)", () => {
  assert.deepEqual(
    effortForRequest(COMMANDCODE),
    { reasoning_effort: "high" },
    "the endpoints that need this cannot advertise it, so silence must not mean no (#150)",
  );
});

test("`undefined` and `[]` are DIFFERENT answers, and conflating them hid the fix (#150)", () => {
  assert.deepEqual(effortForRequest({ ...COMMANDCODE, supportedParameters: undefined }), {
    reasoning_effort: "high",
  });
  assert.equal(effortChoosable(undefined), true);
  assert.deepEqual(effortForRequest({ ...COMMANDCODE, supportedParameters: [] }), {});
  assert.equal(effortChoosable([]), false);
});

test("a catalogue that explicitly EXCLUDES the parameter is respected (#47)", () => {
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

test("Google's refusal is recognised, so the retry can drop the field (#150)", () => {
  const google = new Error("400 [{\"error\":{\"code\":400,\"message\":\"Thinking level is not supported for this model.\",\"status\":\"INVALID_ARGUMENT\"}}]");
  assert.equal(isEffortUnsupported(google), true);
});

test("other phrasings of an unsupported parameter are recognised", () => {
  assert.equal(isEffortUnsupported(new Error("unknown parameter: reasoning_effort")), true);
  assert.equal(isEffortUnsupported(new Error("Unsupported field reasoning_effort")), true);
});

test("an UNRELATED error is NOT mistaken for a refusal (#150)", () => {
  assert.equal(isEffortUnsupported(new Error("invalid api key")), false);
  assert.equal(isEffortUnsupported(new Error("context length exceeded")), false);
  assert.equal(isEffortUnsupported(new Error("Thinking level is not supported for this model.")), true);
  assert.equal(isEffortUnsupported(new Error("rate limit exceeded")), false);
  assert.equal(isEffortUnsupported(undefined), false);
});
