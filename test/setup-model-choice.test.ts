/**
 * #144 — "the default model is GPT-4o, which is not good."
 *
 * The preset list pre-filled a model for each provider, so "the default model"
 * was really "the model we guessed for you": `gpt-4o-mini` on the OpenAI entry,
 * `anthropic/claude-sonnet-4` on OpenRouter. Both problems at once — a model two
 * generations stale on one hand, and a first run that silently costs money
 * before the operator has decided anything on the other.
 *
 * There is no default to get right here. The wizard already discovers the
 * endpoint's real catalogue (typed baseUrl → `/api/setup/models`), so the model
 * is the OPERATOR's choice, made from what their account can actually use.
 *
 * So the presets only carry a baseUrl and a hint now, and the fetched list is a
 * CHOICE rather than autocomplete fodder: clickable rows showing ctx/price, and
 * a client-side "pick a model" instead of the server's generic
 * "baseUrl and model are required" after a round trip.
 *
 * Verified in the built bundle: three models fetched → three rows, the field
 * empty on load, submitting empty explains itself, clicking a row selects it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

const app = readSource(new URL("../frontend/App.tsx", import.meta.url).pathname);

/** the provider preset table */
function presets(): string {
  const at = app.indexOf("const PROVIDER_PRESETS: ProviderPreset[] = [");
  assert.notEqual(at, -1, "the preset table must exist");
  const end = app.indexOf("\n];", at);
  assert.notEqual(end, -1, "the preset table must terminate");
  return app.slice(at, end);
}

test("no preset pre-fills a model (#144)", () => {
  const table = presets();
  // every entry must be `model: ""` — a suggested model is the thing that made
  // the first run pick a stale, paid model on the operator's behalf
  const filled = table
    .split("\n")
    .filter((l) => /model:\s*"[^"]+"/.test(l));
  assert.deepEqual(
    filled,
    [],
    `the wizard must not suggest a model — the operator picks from the endpoint's own list (#144):\n${filled.join("\n")}`,
  );
  // and the specific stale one must stay gone
  assert.doesNotMatch(table, /gpt-4o/, "gpt-4o-mini was the reported default (#144)");
});

test("the fetched catalogue is a CHOICE, not autocomplete (#144)", () => {
  // with nothing pre-filled the list carries the whole decision, so it must be
  // clickable and show what each model costs
  assert.match(app, /const filteredModels = \(\) =>/, "the catalogue must be filterable by what is typed (#144)");
  assert.match(app, /class=\{"wizmodel"/, "rows must be clickable choices (#144)");
  assert.match(app, /onclick=\{\(\) => setModel\(m\.id\)\}/, "clicking a row must select it (#144)");
  assert.match(app, /specOf\(m\.id\)/, "and each row shows its ctx/price (#144)");
  // capped, or a 400-model endpoint pushes the rest of the form off screen
  assert.match(app, /slice\(0, 40\)/, "the list must be capped (#144)");
});

test("submitting with no model explains itself instead of failing server-side (#144)", () => {
  const at = app.indexOf("const submit = async (e: Event) => {");
  assert.notEqual(at, -1, "the wizard submit must exist");
  const body = app.slice(at, app.indexOf("props.onDone();", at));
  assert.match(body, /if \(!model\(\)\.trim\(\)\)/, "it must check the model first (#144)");
  assert.match(body, /pick a model/, "and say what to do about it (#144)");
});

test("the example config does not ship a stale model either (#144)", () => {
  const ex = readSource(new URL("../teapot.config.example.json", import.meta.url).pathname);
  assert.doesNotMatch(ex, /gpt-4o/, "the example still advertised the stale model (#144)");
});
