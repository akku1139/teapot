/**
 * Switching the provider in the right panel must select that provider's
 * configured default model.
 *
 * The dropdown and the model input are two controls for one value. Changing
 * the provider used to leave the model input holding whatever it held before —
 * so the provider's own default was never selected, and `apply` sent the OLD
 * provider's model id to the new endpoint.
 *
 * The rule is extracted into `frontend/model-selection.ts` so it is testable
 * without rendering (happy-dom does no layout, and the Solid tree is not
 * mountable here) — and the wiring is asserted on App.tsx, because a helper
 * only the tests import proves nothing (#75).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import { modelOnProviderSwitch, modelPlaceholderFor, providerDefaultModel } from "../frontend/model-selection.ts";

const PROVIDERS = {
  openrouter: { model: "anthropic/claude-sonnet-4" },
  anthropic: { model: "" }, // no default configured
  local: { model: "qwen3-coder" },
};

test("the provider's own default model wins", () => {
  assert.equal(providerDefaultModel(PROVIDERS, "openrouter"), "anthropic/claude-sonnet-4");
  assert.equal(
    modelOnProviderSwitch(PROVIDERS, "local", { provider: "openrouter", model: "old/model" }),
    "qwen3-coder",
  );
});

test("a foreign model is never carried across", () => {
  // `anthropic` declares no default, so the old provider's model must NOT ride
  // along — that is the bug: apply would send openrouter's model to anthropic.
  assert.equal(
    modelOnProviderSwitch(PROVIDERS, "anthropic", { provider: "openrouter", model: "anthropic/claude-sonnet-4" }),
    "",
  );
});

test("re-selecting the agent's own provider keeps the agent's model", () => {
  // moving the dropdown back to where it started must not blank the field
  assert.equal(
    modelOnProviderSwitch(PROVIDERS, "openrouter", { provider: "openrouter", model: "anthropic/claude-sonnet-4" }),
    "anthropic/claude-sonnet-4",
  );
});

test("no agent and no default resolves to empty, not to a crash", () => {
  assert.equal(modelOnProviderSwitch(undefined, "openrouter", undefined), "");
  assert.equal(modelOnProviderSwitch(PROVIDERS, "", undefined), "");
});

test("the placeholder names what a bare apply would use", () => {
  // the input is empty for a defaultless provider, so the placeholder must
  // still tell the truth about the model an empty field resolves to
  assert.equal(modelPlaceholderFor(PROVIDERS, "local", { model: "stale" }), "qwen3-coder");
  assert.equal(modelPlaceholderFor(PROVIDERS, "anthropic", { model: "stale" }), "stale");
});

test("the provider dropdown is wired to the rule (#3)", () => {
  const app = readSource(new URL("../frontend/App.tsx", import.meta.url).pathname);
  const select = app.indexOf("modelOnProviderSwitch(");
  assert.notEqual(select, -1, "the provider onchange must consult modelOnProviderSwitch (#3)");
  // it must run on the SAME handler that changes the provider, not somewhere
  // else in the panel — bounded by the select's own title attribute
  const from = app.lastIndexOf("onchange", select);
  const to = app.indexOf('title="provider (OpenAI-compatible endpoint)"', select);
  assert.ok(to > from, "the select's title attribute must still follow its handler");
  const handler = app.slice(from, to);
  assert.match(handler, /setModelProvider\(next\)/, "the switch must set the provider in the same handler (#3)");
  assert.match(handler, /setModelDraft\(/, "and select the new provider's model in it (#3)");
  assert.match(handler, /loadModels\(next\)/, "the model catalogue must follow the provider (#3)");
  assert.doesNotMatch(
    handler,
    /setModelDraft\(""\)/,
    "the draft must be RESOLVED for the new provider, not merely cleared (#3)",
  );
  assert.match(
    app,
    /placeholder=\{modelPlaceholderFor\(/,
    "the placeholder must come from the same rule (#3)",
  );
});
