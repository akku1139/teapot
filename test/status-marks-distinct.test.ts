import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import { cssRuleBody } from "./helpers/css.ts";

/**
 * Every status needs a mark a person can tell apart, in BOTH places it appears.
 *
 * Two reports, one cause — a state that shared its colour with a different state:
 *
 *   1. "セッションがwaitingなのに左パネルではアイコンが灰色" — `.dot.waiting` was `--dim`, the same
 *      colour as `stopped`, so an agent parked on `wait_children` or a background job read as dead.
 *   2. "タイムライン上部もask_userと色かぶってる疑惑" — `.badge.waiting`, `.badge.needs_operator`
 *      AND `.badge.done` were all `--acc`, MEASURED as `rgb(88, 101, 242)` for all three.
 *
 * The one rule, applied to both surfaces:
 *
 *   running         --ok    alive, moving              (dot: filled + glow)
 *   waiting         --ok    alive, holding its own work (dot: hollow ring — not consuming anything)
 *   needs_operator  --acc   alive, holding for a HUMAN  (the only colour that means "you")
 *   done            --ok    finished                    (the accent belongs to "you", not "finished")
 *   stopped         --dim   nothing running
 *
 * The dot must separate `waiting` from `running` by SHAPE (filled vs hollow), because the colour is
 * shared on purpose; the badge separates them by WORD, so sharing the colour there is correct.
 */
const dot = (st: string) => cssRuleBody(readSource("frontend/app.css"), `.dot.${st}`);
const badge = (st: string) => cssRuleBody(readSource("frontend/app.css"), `.badge.${st}`);

test("waiting is not the grey of stopped (#status)", () => {
  const w = dot("waiting");
  assert.doesNotMatch(
    w,
    /background:\s*var\(--dim\)/,
    "a parked-but-alive agent must not be the same grey as a stopped one — that is the " +
      "'waiting なのにアイコンが灰色' report (#status)",
  );
  assert.match(w, /--ok/, "it is alive, so it belongs to the same colour family as running (#status)");
});

test("waiting and running differ by SHAPE, not only by colour (#status)", () => {
  const r = dot("running");
  const w = dot("waiting");
  // running is a filled disc with a glow; waiting is a hollow ring
  assert.match(r, /background:\s*var\(--ok\)/, "running is filled (#status)");
  assert.match(r, /box-shadow:\s*0 0 6px/, "and glows (#status)");
  assert.match(w, /background:\s*transparent/, "waiting is HOLLOW — the shape is what separates them (#status)");
  assert.match(w, /inset/, "an inset ring, or the hollow disc has no edge (#status)");
  assert.doesNotMatch(w, /0 0 6px/, "waiting must not glow: it is holding, not producing (#status)");
});

test("needs_operator is the only accent mark among the live states (#status)", () => {
  assert.match(dot("needs_operator"), /var\(--acc\)/, "a human is needed — the one colour that means 'you' (#status)");
  assert.doesNotMatch(dot("waiting"), /var\(--acc\)/, "waiting needs nobody (#status)");
});

test("the badge does not paint waiting, needs_operator and done the same (#status)", () => {
  assert.match(badge("waiting"), /var\(--ok\)/, "waiting is alive, not 'you' (#status)");
  assert.match(badge("needs_operator"), /var\(--acc\)/, "needs_operator keeps the accent (#status)");
  assert.match(badge("done"), /var\(--ok\)/, "the accent belongs to 'you', not to 'finished' (#status)");
});
