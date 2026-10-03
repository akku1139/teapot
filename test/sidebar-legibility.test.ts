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

test("a collapsed chat is still clickable (#66)", () => {
  // #66's title is the real bug: "you cannot select from the chat list without
  // expanding the sub-agent list". The row click was guarded so a collapsed chat
  // could only be reopened through its ~9px caret — and on a row that looked
  // inactive nobody looks for a control there. Clicking now selects the chat AND
  // expands it, so the collapsed row is never a dead end.
  assert.match(
    lastRule(".agent-item.collapsed"),
    /cursor:\s*pointer/,
    "a collapsed chat must invite the click that opens it (#66)",
  );
  // no rule may switch its hover off — that was what made the row look inert
  assert.doesNotMatch(
    css,
    /\.agent-item\.collapsed:hover\s*\{[^}]*background:\s*none/,
    "a collapsed chat must light up on hover like any other selectable row (#66)",
  );
});

test("the collapsed caret is what shows the state (#66)", () => {
  // the caret glyph flips ▾/▸ in the component; this asserts the row still
  // renders it, so "collapsed" is never conveyed by opacity alone
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  assert.match(app, /\{off \? "▸" : "▾"\}/, "the caret must reflect the collapsed state (#66)");
});

/**
 * The #66 regression guard, made STRUCTURAL.
 *
 * This previously asserted `assert.match(onclick, /select\(row\.a\.id\)/)` over a
 * slice of source. That regex matches the call even when it is unreachable —
 * putting it inside `if (false)` left all 34 sidebar tests passing with the chat
 * permanently unable to open, which is the exact bug #66 was.
 *
 * So the handler is parsed, not grepped: statements are collected from the
 * block and each is asserted on its own, with the guard checked separately. A
 * dead call is then dead in the model too, and the assertion fails.
 */
function sidebarRowOnClick(src: string): string {
  const anchor = 'onclick={() => {\n                  if (row.chatCollapsedGroup)';
  const at = src.indexOf(anchor);
  assert.notEqual(at, -1, "the sidebar row must have a click handler (#66)");
  // walk braces from the block's opening to find its real end
  const open = src.indexOf("{", src.indexOf("=>", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced braces in the sidebar row handler (#66)");
}

/** top-level statements of a handler body, brace/paren aware */
function statementsOf(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if ("{((".includes(c)) depth++;
    else if ("})".includes(c)) depth--;
    else if (c === ";" && depth === 0) {
      const stmt = body.slice(start, i).trim();
      if (stmt) out.push(stmt);
      start = i + 1;
    }
  }
  const tail = body.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

test("clicking a collapsed chat selects it and expands it (#66)", () => {
  const body = sidebarRowOnClick(readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8"));
  const stmts = statementsOf(body);

  // 1. selecting must be a TOP-LEVEL statement — not nested in any guard
  const selectStmt = stmts.find((x) => x.includes("select(row.a.id)"));
  assert.ok(selectStmt, `select(row.a.id) must appear (#66); got ${JSON.stringify(stmts)}`);
  assert.doesNotMatch(
    selectStmt,
    /^\s*(if|for|while|switch)\b/,
    `select must NOT be inside a conditional — a dead select is the #66 bug (#66); got ${selectStmt}`,
  );

  // 2. expanding must be guarded on exactly the collapsed case
  const expandStmt = stmts.find((x) => x.includes("toggleWsGroup"));
  assert.ok(expandStmt, "the expand must appear (#66)");
  assert.match(
    expandStmt,
    /^if \(row\.chatCollapsedGroup\)/,
    `the expand is guarded on the collapsed state (#66); got ${expandStmt}`,
  );
  assert.match(
    expandStmt,
    /toggleWsGroup\(`chat:\$\{row\.a\.id\}`, row\.a\.id, true\)/,
    `and it passes isCollapsed=true so it EXPANDS rather than toggling shut (#66); got ${expandStmt}`,
  );

  // 3. order matters: expand before select, so the chat is open when selected
  assert.ok(
    stmts.indexOf(expandStmt) < stmts.indexOf(selectStmt),
    `expanding first means the chat is already open when it becomes selected (#66); got ${JSON.stringify(stmts)}`,
  );

  // 4. and the dead-end guard must be GONE — a collapsed row is never inert
  assert.doesNotMatch(
    body,
    /if \(!row\.chatCollapsedGroup\)/,
    `a collapsed row must never be a dead end (#66); got ${body}`,
  );
});

test("the dead-end guard cannot hide inside any statement (#66)", () => {
  // a second, cheap net: no branch anywhere in the handler may SKIP the select
  const body = sidebarRowOnClick(readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8"));
  const branches = body.match(/if\s*\([^)]*\)\s*(?!\{)/g) ?? [];
  // every `if` in this handler must be the collapse guard itself
  for (const b of branches) {
    assert.match(
      b,
      /if\s*\(row\.chatCollapsedGroup\)/,
      `the only conditional in this handler should be the collapse guard (#66); found ${b}`,
    );
  }
});

