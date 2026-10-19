/**
 * Switching the provider in the right panel must select that provider's
 * configured default model.
 *
 * The dropdown and the model input are two controls for one value. Changing the
 * provider used to leave the model input holding whatever it held before — so
 * the provider's own default was never selected, and `apply` sent the OLD
 * provider's model id to the new endpoint.
 *
 * The rule lives in frontend/model-selection.ts so it is testable without
 * rendering; the WIRING is asserted on App.tsx, because a helper only the tests
 * import proves nothing (#75).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mayResyncProvider,
  modelOnProviderSwitch,
  modelPlaceholderFor,
  providerDefaultModel,
} from "../frontend/model-selection.ts";

const PROVIDERS = {
  openrouter: { model: "anthropic/claude-sonnet-4" },
  anthropic: { model: "" }, // no default configured
  local: { model: "qwen3-coder" },
};

test("the provider's own default model is selected, and a foreign one never carried across", () => {
  assert.equal(providerDefaultModel(PROVIDERS, "openrouter"), "anthropic/claude-sonnet-4");
  assert.equal(
    modelOnProviderSwitch(PROVIDERS, "local", { provider: "openrouter", model: "old/model" }),
    "qwen3-coder",
    "the new provider's default wins",
  );
  // `anthropic` declares no default, so openrouter's model must NOT ride along —
  // that is the bug: apply would send openrouter's model id to anthropic
  assert.equal(
    modelOnProviderSwitch(PROVIDERS, "anthropic", { provider: "openrouter", model: "anthropic/claude-sonnet-4" }),
    "",
  );
  // moving the dropdown back where it started must not blank the field
  assert.equal(
    modelOnProviderSwitch(PROVIDERS, "openrouter", { provider: "openrouter", model: "anthropic/claude-sonnet-4" }),
    "anthropic/claude-sonnet-4",
  );
  assert.equal(modelOnProviderSwitch(undefined, "openrouter", undefined), "", "no provider, no agent, no crash");
});

test("the placeholder names what a bare apply would use (#3)", () => {
  // an emptied field still has to say which model it resolves to
  assert.equal(modelPlaceholderFor(PROVIDERS, "local", { model: "stale" }, "openrouter"), "qwen3-coder");
  assert.equal(modelPlaceholderFor(PROVIDERS, "openrouter", { model: "now" }, "openrouter"), "now");
});

