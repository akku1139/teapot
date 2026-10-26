import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBody } from "./helpers/css.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

function ruleBody(token: string): string {
  return cssRuleBody(css, token);
}

test("modal controls may shrink below their content width (#36)", () => {
  const body = ruleBody(".modal select");
  assert.match(
    body,
    /min-width:\s*0/,
    "a <select> sized to its longest option overflows the dialog without min-width:0",
  );
});

test("the modelbox rule the fix mirrors really does set min-width:0", () => {
  assert.match(ruleBody(".modelbox select"), /min-width:\s*0/);
});
