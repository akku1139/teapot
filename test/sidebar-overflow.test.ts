import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBody } from "./helpers/css.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

function firstRule(selector: string): string {
  return cssRuleBody(css, selector);
}

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

test("a sidebar row cannot be wider than the sidebar (#60)", () => {
  const row = firstRule(".agent-item ");
  assert.match(
    row,
    /min-width:\s*0/,
    ".agent-item must be allowed to shrink inside the flex sidebar (#60)",
  );
});

test("the chat id ellipsises so the badges keep their width (#60)", () => {
  const shrinkable = shrinkableRule().body;
  assert.match(shrinkable, /min-width:\s*0/, "the id needs min-width:0 to shrink (#60)");
  assert.match(shrinkable, /overflow:\s*hidden/, "and must clip its overflow (#60)");
  assert.match(shrinkable, /text-overflow:\s*ellipsis/, "showing an ellipsis instead (#60)");
  assert.match(shrinkable, /white-space:\s*nowrap/, "on a single line (#60)");
});

test("the badges are explicitly excluded from shrinking (#60)", () => {
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

test("the sidebar never scrolls horizontally (#60)", () => {
  const sidebar = firstRule(".sidebar ");
  assert.match(sidebar, /overflow-x:\s*hidden/, "the panel must clip its X axis (#60)");
  assert.match(sidebar, /overflow-y:\s*auto/, "vertical scrolling is still wanted (#60)");
});

test("the scrolling list inside it can shrink too (#60)", () => {
  const list = firstRule(".agent-list ");
  assert.match(list, /min-width:\s*0/, ".agent-list must shrink within the flex column (#60)");
  assert.match(list, /overflow-y:\s*auto/, "and still scroll vertically (#60)");
});

test("the goal-done tick cannot be squeezed (#60)", () => {
  assert.match(firstRule(".agent-item .goaldone"), /flex-shrink:\s*0/, "the ✓ must not shrink (#60)");
});
