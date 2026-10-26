import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceUrl } from "./helpers/source.ts";
import { composerValueChanged, shouldWriteComposerValue } from "../frontend/lib/composer-ime.ts";

const _app = readSourceUrl(new URL("../frontend/App.tsx", import.meta.url));

test("no write reaches the DOM while a composition is in progress (#IME)", () => {
  assert.equal(shouldWriteComposerValue(true), false, "a mid-composition write cancels the conversion");
  assert.equal(shouldWriteComposerValue(false), true, "outside a composition the sync must run");
  assert.equal(composerValueChanged("same", "same"), false);
  assert.equal(composerValueChanged("x", ""), true, "clearing after send must reach the DOM");
});

