/**
 * #60 — "the left panel sometimes scrolls horizontally."
 *
 * Reported as happening "when a sub-agent has notifications and sub-agents and
 * also has a checkmark" — i.e. a chat row carrying several trailing badges at
 * once: the 🔔 unread count, the 🧩 sub-agent count, and the ✓ goal-done tick.
 *
 * The row is a flex line, and every badge in it is `flex-shrink: 0` (deliberate
 * — a badge that collapsed to a sliver would be unreadable). That left exactly
 * one item with no intrinsic limit: the chat's own id. A long id plus a few
 * badges could therefore exceed the sidebar's width, and because
 * `.sidebar { overflow-y: auto }` computes `overflow-x` to `auto` too, the
 * panel itself gained a horizontal scrollbar and the whole tree could be
 * scrolled sideways out of view.
 *
 * The fix is the `min-width: 0` + ellipsis contract the notification list and
 * the runtime panel already use: the id is the one item allowed to shrink, and
 * the panel clips X instead of scrolling it.
 *
 * happy-dom does no layout, so these pin the CSS contract that governs it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

/** Body of the FIRST rule whose SELECTOR list contains `selector`. */
function firstRule(selector: string): string {
  let i = 0;
  for (;;) {
    const open = css.indexOf("{", i);
    if (open === -1) throw new Error(`no rule with selector ${selector}`);
    const prevClose = css.lastIndexOf("}", open);
    const selStart = prevClose === -1 ? 0 : prevClose + 1;
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
    if (close === -1) throw new Error(`unterminated rule at ${open}`);
    if (css.slice(selStart, open).includes(selector)) return css.slice(open + 1, close);
    i = close + 1;
  }
}

/**
 * Body of the rule that lets the chat id shrink.
 *
 * Located by its DECLARATION rather than by a slice of the selector: the
 * explanatory comment above it names the same classes the selector excludes,
 * so matching on selector text finds the comment's block instead.
 */
function shrinkableRule(): { selector: string; body: string } {
  const at = css.indexOf("min-width: 0; overflow: hidden; text-overflow: ellipsis");
  assert.notEqual(at, -1, "the shrinkable-id rule must exist (#60)");
  const open = css.lastIndexOf("{", at);
  const selStart = css.lastIndexOf("}", open) + 1;
  return {
    selector: css.slice(selStart, open),
    body: css.slice(open + 1, css.indexOf("}", open)),
  };
}

/* ---------- 1: the row must not be able to exceed its container ---------- */

test("a sidebar row cannot be wider than the sidebar (#60)", () => {
  const row = firstRule(".agent-item ");
  assert.match(
    row,
    /min-width:\s*0/,
    ".agent-item must be allowed to shrink inside the flex sidebar (#60)",
  );
});

/* ---------- 2: the id is the one item that shrinks ---------- */

test("the chat id ellipsises so the badges keep their width (#60)", () => {
  // The defect: every badge in the row is flex-shrink:0, so the id was the
  // only candidate — and without min-width:0 a flex item refuses to shrink
  // below its content width, so it never did.
  const shrinkable = shrinkableRule().body;
  assert.match(shrinkable, /min-width:\s*0/, "the id needs min-width:0 to shrink (#60)");
  assert.match(shrinkable, /overflow:\s*hidden/, "and must clip its overflow (#60)");
  assert.match(shrinkable, /text-overflow:\s*ellipsis/, "showing an ellipsis instead (#60)");
  assert.match(shrinkable, /white-space:\s*nowrap/, "on a single line (#60)");
});

test("the badges are explicitly excluded from shrinking (#60)", () => {
  // the exclusions live in the SELECTOR, not the body
  const shrinkable = shrinkableRule().selector;
  for (const cls of [
    "dot",
    "caret",
    "caret-spacer",
    "notifbadge",
    "subcount",
    "subtag",
    "ghosttag",
    "mini-cron",
    "goaldone",
  ]) {
    assert.ok(
      shrinkable.includes(`.${cls}`),
      `.${cls} must keep its intrinsic width — a collapsed badge is unreadable (#60)`,
    );
  }
});

/* ---------- 3: the panel must clip, not scroll sideways ---------- */

test("the sidebar never scrolls horizontally (#60)", () => {
  // THE decisive bit: `overflow-y: auto` alone computes `overflow-x` to `auto`,
  // so an overflowing row scrolls the entire panel sideways. Only an explicit
  // hidden clips it.
  const sidebar = firstRule(".sidebar ");
  assert.match(sidebar, /overflow-x:\s*hidden/, "the panel must clip its X axis (#60)");
  assert.match(sidebar, /overflow-y:\s*auto/, "vertical scrolling is still wanted (#60)");
});

test("the scrolling list inside it can shrink too (#60)", () => {
  const list = firstRule(".agent-list ");
  assert.match(list, /min-width:\s*0/, ".agent-list must shrink within the flex column (#60)");
  assert.match(list, /overflow-y:\s*auto/, "and still scroll vertically (#60)");
});

/* ---------- the ✓ needs a class to be excluded ---------- */

test("the goal-done tick carries a class so the row can spare it (#60)", () => {
  // The ✓ is a bare fixed-width glyph. Left unclassed it would match the
  // "shrinkable" rule above and be the one badge that could collapse.
  assert.match(app, /class="goaldone"/, "the ✓ must be classable (#60)");
  assert.match(firstRule(".agent-item .goaldone"), /flex-shrink:\s*0/, "and must not shrink (#60)");
});

/* ---------- the badges the report names must still exist ---------- */

test("the three badges from the report are all still rendered (#60)", () => {
  const row = app.slice(app.indexOf('class={"agent-item"'), app.indexOf('class={"agent-item"') + 3000);
  assert.match(row, /notifbadge/, "the 🔔 unread badge must remain (#60)");
  assert.match(row, /subcount/, "the 🧩 sub-agent count must remain (#60)");
  assert.match(row, /goaldone/, "the ✓ goal tick must remain (#60)");
});
