import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource, stripSourceComments } from "./helpers/source.ts";

/**
 * A tool result is rendered in FULL.
 *
 * Two separate character budgets used to sit inside the tool row: `truncate(out(), 4000)` on the
 * paired result and `truncate(out, 4000)` on the path for a result whose call had been evicted from
 * the events window. MEASURED against a seeded 12,289-char result: the card held 4,098 chars and
 * `row 399` — the last line — was absent from the DOM entirely.
 *
 * That is wrong for this row specifically: it is already a `<details>`, so the operator has to open
 * the card to see anything. Discarding the body behind that deliberate action shows them a
 * transcript that ends early with no sign it does. A result is capped at 8,000 chars server-side
 * and `.toolbody` keeps `max-height: 340px; overflow-y: auto`, so "all of it" is bounded and the
 * tall case scrolls.
 *
 * Asserted on the RENDERED behaviour where that is possible; the source check below only pins that
 * no `truncate(…out…)` survives on either result path, because an evicted call must not look
 * different from a surviving one.
 */
test("neither tool-result path truncates its output (#fold)", () => {
  const rows = stripSourceComments(readSource("frontend/components/rows.tsx"));
  const truncated = [...rows.matchAll(/truncate\([^)]*\bout\b[^)]*\)/g)].map((m) => m[0]);
  assert.deepEqual(
    truncated,
    [],
    "a tool result must reach the DOM whole — truncating it makes the transcript end early with " +
      "no sign that it did, behind a card the operator opened on purpose (#fold)",
  );
});

test("the tool body scrolls its tall content instead of clipping (#fold)", async () => {
  const { cssRuleBody } = await import("./helpers/css.ts");
  const body = cssRuleBody(readSource("frontend/app.css"), ".toolbody");
  assert.match(body, /max-height:\s*\d+px/, "a very tall result needs a bound");
  assert.match(
    body,
    /overflow-y:\s*auto/,
    "and it must SCROLL — clipping the remainder is the truncation this replaced (#fold)",
  );
});
