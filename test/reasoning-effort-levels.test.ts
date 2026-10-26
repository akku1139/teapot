import { test } from "node:test";
import assert from "node:assert/strict";
import { clampEffort, effortForRequest, effortChoosable, type LlmConfig } from "../src/agent/llm.ts";

const base = { apiKey: "k", model: "m", reasoningEffort: "high" } as const;
const OR: LlmConfig = { ...base, baseUrl: "https://openrouter.ai/api/v1", supportedParameters: ["reasoning_effort"] };

test("a level the model LACKS clamps to the nearest weaker one (#150)", () => {
  const levels = ["max", "high", "low"];
  assert.equal(clampEffort("medium", levels), "low", "must not escalate to high (#150)");
  assert.equal(clampEffort("minimal", levels), "low", "nor leave the model's range");
  assert.equal(clampEffort("high", levels), "high", "a supported level passes through");
});

test("the model's own TOP tier is reachable, even though we do not offer it (#150)", () => {
  assert.deepEqual(
    effortForRequest({ ...OR, reasoningEffort: "high", supportedEfforts: ["max", "high", "low"] }),
    { reasoning_effort: "high" },
  );
  assert.deepEqual(
    clampEffort("high", ["max"]) as string,
    "max",
    "with nothing weaker available, the weakest supported level is the honest match",
  );
});

test("only `none` is not a degradation target (#150)", () => {
  assert.equal(clampEffort("minimal", ["none", "low"]), "low");
});

test("an unknown level list, or a bespoke level name, is left alone (#150)", () => {
  assert.equal(clampEffort("high", undefined), "high");
  assert.equal(clampEffort("high", []), "high");
  assert.equal(clampEffort("turbo", ["low", "high"]), "turbo");
});

test("monotonic: a stronger request never resolves weaker than a weaker one (#150)", () => {
  const levels = ["low", "high", "max"];
  const order = ["minimal", "low", "medium", "high"];
  const resolved = order.map((l) => clampEffort(l, levels));
  for (let i = 1; i < resolved.length; i++) {
    assert.ok(
      levels.indexOf(resolved[i]!) >= levels.indexOf(resolved[i - 1]!),
      `clamping must not invert the order: ${JSON.stringify(resolved)}`,
    );
  }
});

test("the picker offers exactly the model's levels when it publishes them (#150)", () => {
  const e = effortForRequest({ ...OR, reasoningEffort: "medium", supportedEfforts: ["max", "high", "low"] });
  assert.deepEqual(e, { reasoning_effort: "low" }, "the sent value is clamped (#150)");
});

test("a model whose catalogue omits the parameter does not offer the control (#150)", () => {
  assert.equal(effortChoosable(["temperature", "tools"]), false, "256 of 458 models are in this group");
  assert.equal(effortChoosable(undefined), true, "unpublished is not the same as unsupported");
});
