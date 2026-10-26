import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mayResyncProvider,
  modelOnProviderSwitch,
  modelPlaceholderFor,
  providerDefaultModel,
} from "../frontend/lib/model-selection.ts";

const PROVIDERS = {
  openrouter: { model: "anthropic/claude-sonnet-4" },
  anthropic: { model: "" }, 
  local: { model: "qwen3-coder" },
};

test("the provider's own default model is selected, and a foreign one never carried across", () => {
  assert.equal(providerDefaultModel(PROVIDERS, "openrouter"), "anthropic/claude-sonnet-4");
  assert.equal(
    modelOnProviderSwitch(PROVIDERS, "local", { provider: "openrouter", model: "old/model" }),
    "qwen3-coder",
    "the new provider's default wins",
  );
  assert.equal(
    modelOnProviderSwitch(PROVIDERS, "anthropic", { provider: "openrouter", model: "anthropic/claude-sonnet-4" }),
    "",
  );
  assert.equal(
    modelOnProviderSwitch(PROVIDERS, "openrouter", { provider: "openrouter", model: "anthropic/claude-sonnet-4" }),
    "anthropic/claude-sonnet-4",
  );
  assert.equal(modelOnProviderSwitch(undefined, "openrouter", undefined), "", "no provider, no agent, no crash");
});

test("the placeholder names what a bare apply would use (#3)", () => {
  assert.equal(modelPlaceholderFor(PROVIDERS, "local", { model: "stale" }, "openrouter"), "qwen3-coder");
  assert.equal(modelPlaceholderFor(PROVIDERS, "openrouter", { model: "now" }, "openrouter"), "now");
});

