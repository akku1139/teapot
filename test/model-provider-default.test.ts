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
import { readSourceUrl } from "./helpers/source.ts";
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

test("the poll-driven re-sync must not undo a deliberate provider choice (#3)", () => {
  // the regression this guards: a defaultless provider leaves the draft empty,
  // the next poll reads that as "not mid-edit" and pulls the dropdown back
  assert.equal(mayResyncProvider(true), false, "a touched dropdown is the operator's");
  assert.equal(mayResyncProvider(false), true, "an untouched one still follows an external change");
  const app = readSourceUrl(new URL("../frontend/App.tsx", import.meta.url));
  assert.match(app, /mayResyncProvider\(providerTouched\)/, "and it must be wired (#3)");
});

test("the provider dropdown is wired to the rule (#3)", () => {
  const app = readSourceUrl(new URL("../frontend/App.tsx", import.meta.url));
  const select = app.indexOf("modelOnProviderSwitch(");
  assert.notEqual(select, -1, "the provider onchange must consult modelOnProviderSwitch (#3)");
  const from = app.lastIndexOf("onchange", select);
  const to = app.indexOf('title="provider (OpenAI-compatible endpoint)"', select);
  const handler = app.slice(from, to);
  assert.match(handler, /setModelProvider\(next\)/, "the switch must set the provider in the same handler (#3)");
  assert.match(handler, /setModelDraft\(/, "and select the new provider's model in it (#3)");
  assert.match(handler, /loadModels\(next\)/, "the model catalogue must follow the provider (#3)");
  assert.ok(
    app.includes("placeholder={modelPlaceholderFor("),
    "the placeholder must come from the same rule (#3)",
  );
});

test("the 🧦 model box has ONE apply, and it sends the model AND the effort (#3 follow-up)", () => {
  // Reported: "model と effort を別々で apply できるボタンがあるけど、どっちが効いたのか
  // わかりにくい" — there were two buttons for one form, and neither said what it
  // carried. Pressing the one beside `effort` did NOT send the model edit sitting
  // right above it. One button removes the ambiguity, and it must send BOTH fields
  // in the single request the endpoint already accepts.
  const app = readSourceUrl(new URL("../frontend/App.tsx", import.meta.url));
  // the box runs from its heading down to the "current:" line printed under it
  // (the button's own closing tag must be INCLUDED, or the only apply in the box
  // is sliced off and the assertion passes vacuously)
  const boxStart = app.indexOf(">\u{1F9E6} model<");
  assert.notEqual(boxStart, -1, "the 🧦 model box must be locatable");
  // The box ends at the "current:" line printed under it. Anchoring on the
  // button's own LABEL would make this test fail every time the label is
  // reworded, which is not the property under test.
  const boxEnd = app.indexOf('<div class="meta">\n              current: {sel()!.model}');
  assert.notEqual(boxEnd, -1, "the end of the model box must be locatable");
  const box = app.slice(boxStart, boxEnd);

  const applies = box.match(/>apply[^<]*<\/button>/g) ?? [];
  assert.equal(
    applies.length,
    1,
    `exactly one apply button must live in the model box, got: ${JSON.stringify(applies)}`,
  );
  // and its label must NOT try to enumerate what it sends — the operator only
  // needs "apply", because it applies the whole box
  assert.equal(
    applies[0],
    ">apply</button>",
    `the apply button label must be just "apply", got ${applies[0]}`,
  );

  // and that one request carries both halves of the form
  const onclick = box.slice(box.lastIndexOf("onclick"));
  assert.match(onclick, /provider: modelProvider\(\)/, "the apply must send the provider");
  assert.match(onclick, /model: modelDraft\(\)/, "and the model");
  assert.match(
    onclick,
    /reasoningEffort: effortDraft\(\)/,
    "and the effort — a single button that silently dropped it would be the same bug in reverse",
  );
});
