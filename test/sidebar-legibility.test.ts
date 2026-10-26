/**
 * #66 — "why is this greyed out" (about the agent tree).
 *
 * Two separate things made the sidebar look uniformly inactive, and only one
 * of them was recent.
 *
 * 1. `.agent-item` set the chat NAME to `var(--dim)` — the same muted grey used
 *    for the caret, the 🧩 badge and the other chrome. Only `.agent-item.sel`
 *    restored `var(--fg)`, so a sidebar full of chats rendered every name at
 *    reduced contrast with just the selected one bright. The hierarchy was
 *    exactly backwards: the thing you choose between was the faintest thing on
 *    screen.
 *
 * 2. The `collapsed` class added by #18 layered `opacity: .5` on top of that
 *    already-muted colour, making a collapsed chat the least readable row in
 *    the sidebar. A collapsed chat is a deliberate, reversible state the
 *    operator chose — not stale, not disabled, and not something to fade out.
 *
 * happy-dom does no layout or colour, so this pins the stylesheet contract: the
 * name is foreground-coloured, and "collapsed" is expressed by the CARET rather
 * than by opacity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBody } from "./helpers/css.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

/**
 * Body of the LAST rule whose selector list contains `selector` exactly.
 *
 * This used to be a hand-rolled brace scanner here. `cssRuleBody` in helpers/css.ts does
 * the same job AND strips comments first — which is the difference that matters: these
 * assertions look for `color: var(--fg)`, and a rule's own explanatory comment can quote
 * that text verbatim, so commenting the declaration out would still satisfy them. That
 * is a measured failure (#75), not a hypothetical, and it is why the helper exists.
 */
const lastRule = (selector: string): string => cssRuleBody(css, selector);

/* ---------- the name must be legible ---------- */

test("a chat's name renders at full foreground colour (#66)", () => {
  const row = lastRule(".agent-item");
  assert.match(
    row,
    /color:\s*var\(--fg\)/,
    "the chat name is the row's primary content and must not be dimmed (#66)",
  );
  assert.doesNotMatch(
    row,
    /color:\s*var\(--dim\)/,
    "`var(--dim)` is for the caret and badges, not for the name itself (#66)",
  );
});

test("the dimmed colour is still used for the secondary chrome (#66)", () => {
  // the fix must not flatten the hierarchy entirely: the caret, the 🧩 subtag
  // and sub-rows are meant to recede, that is what --dim is FOR.
  assert.match(lastRule(".caret"), /color:\s*var\(--dim\)/, "the caret stays muted (#66)");
  assert.match(lastRule(".agent-item .subtag"), /color:\s*var\(--dim\)/, "the 🧩 tag stays muted (#66)");
});

test("a sub-agent reads as subordinate without being disabled (#66)", () => {
  // once the parent's name is full-brightness, indent alone is a weak cue for
  // "this row is a child", so sub-rows are muted a step — but a SELECTED
  // sub-agent must not look disabled.
  assert.match(lastRule(".agent-item.sub-row"), /color:\s*var\(--dim\)/, "a sub-agent recedes (#66)");
  assert.match(
    lastRule(".agent-item.sub-row.sel"),
    /color:\s*var\(--fg\)/,
    "a selected sub-agent must be fully legible (#66)",
  );
});

/* ---------- selection must still read ---------- */

test("the selected row is distinguished by its background (#66)", () => {
  // `.sel` no longer needs to restate the colour — it inherits --fg already —
  // but it MUST still carry the background, or nothing marks the open chat.
  assert.match(lastRule(".agent-item.sel"), /background:\s*var\(--bg-mid\)/, "selection must be visible (#66)");
});

/* ---------- collapsed must not be dimmed ---------- */

test("a collapsed chat is NOT dimmed (#66)", () => {
  const collapsed = lastRule(".agent-item.collapsed");
  assert.doesNotMatch(
    collapsed,
    /opacity/,
    "a collapsed chat is a deliberate, reversible state — not stale, so it must not fade (#66)",
  );
  assert.doesNotMatch(
    collapsed,
    /color:\s*var\(--dim\)/,
    "and its name stays legible; the caret carries the state (#66)",
  );
});

/*
 * A structural guard used to live here (`sidebarRowOnClick` + `statementsOf`):
 * it parsed the sidebar row's JSX handler out of App.tsx and asserted the
 * `select()` call was reachable. Both helpers were dead — nothing called them —
 * and every test around them was a source-text assertion, so they are gone. The
 * click behaviour is exercised against the real bundle in scripts/smoke-web.ts.
 */

