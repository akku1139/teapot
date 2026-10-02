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

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

/** Body of the LAST rule whose selector list contains `selector` exactly. */
function lastRule(selector: string): string {
  let i = 0;
  let found = "";
  for (;;) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    const prevClose = css.lastIndexOf("}", open);
    const sel = css
      .slice(prevClose === -1 ? 0 : prevClose + 1, open)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    let depth = 0;
    let close = -1;
    for (let j = open; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close === -1) break;
    if (sel.split(",").some((p) => p.trim() === selector)) found = css.slice(open + 1, close);
    i = close + 1;
  }
  if (!found) throw new Error(`no rule whose selector is exactly ${selector}`);
  return found;
}

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

test("a collapsed chat still does not react to a row click (#66)", () => {
  // keeping this is correct: the row is inert, the CARET is the control.
  assert.match(lastRule(".agent-item.collapsed"), /cursor:\s*default/, "the row must not invite a click (#66)");
  assert.match(
    lastRule(".agent-item.collapsed:hover"),
    /background:\s*none/,
    "and must not light up on hover (#66)",
  );
});

test("the collapsed caret is what shows the state (#66)", () => {
  // the caret glyph flips ▾/▸ in the component; this asserts the row still
  // renders it, so "collapsed" is never conveyed by opacity alone
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  assert.match(app, /\{off \? "▸" : "▾"\}/, "the caret must reflect the collapsed state (#66)");
});
