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
// #126: normalises CRLF so source anchors behave the same on Windows
import { readSource } from "./helpers/source.ts";

const css = readSource(new URL("../frontend/app.css", import.meta.url));

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
  // #66's title is "you cannot select from the chat list without expanding the
  // sub-agent list", and what that actually described was the APPEARANCE: a
  // collapsed parent rendered at `opacity: .5` with `cursor: default`, so it
  // read as greyed-out and disabled. That was a styling bug and this is its fix
  // — full-contrast name, pointer cursor, row still clickable.
  //
  // An earlier attempt also made the click EXPAND the chat. That was an
  // over-correction (#85): the operator's collapse state is theirs, and forcing
  // it open on every visit made the sub-agent list impossible to keep away.
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
  const app = readSource(new URL("../frontend/App.tsx", import.meta.url));
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
  // The handler has been two shapes: a block (`onclick={() => { ... }}`) and a
  // single expression (`onclick={() => select(row.a.id)}` — the current form,
  // since #85 removed the expand). Both must be locatable, or the tests would
  // silently stop finding it.
  const block = src.indexOf("onclick={() => {\n                  if (row.chatCollapsedGroup)");
  const expr = src.indexOf("onclick={() => select(row.a.id)");
  const at = block !== -1 ? block : expr;
  assert.notEqual(at, -1, "the sidebar row must have a click handler (#66)");
  if (block === -1) {
    // expression form: up to the closing paren of the attribute
    const arrow = src.indexOf("=>", at) + 2;
    // the expression ends at the ")" that closes the JSX attribute
    const end = src.indexOf(")", arrow);
    return src.slice(arrow, end + 1);
  }
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

test("clicking a collapsed chat selects it WITHOUT expanding it (#66/#85)", () => {
  const body = sidebarRowOnClick(readSource(new URL("../frontend/App.tsx", import.meta.url)));
  const stmts = statementsOf(body);

  // 1. selecting must be a TOP-LEVEL statement — not nested in any guard. A dead
  //    select is the #66 bug, and a regex cannot see deadness.
  const selectStmt = stmts.find((x) => x.includes("select(row.a.id)"));
  assert.ok(selectStmt, `select(row.a.id) must appear (#66); got ${JSON.stringify(stmts)}`);
  assert.doesNotMatch(
    selectStmt,
    /^\s*(if|for|while|switch)\b/,
    `select must NOT be inside a conditional — a dead select is the #66 bug (#66); got ${selectStmt}`,
  );

  // 2. #85: the row must NOT touch the collapse state. The operator's collapse
  //    is theirs; forcing it open on every visit made the sub-agent list
  //    impossible to keep out of the way. The caret is the only control.
  assert.doesNotMatch(
    body,
    /toggleWsGroup|setWsCollapsed|chatCollapsed/,
    `the row click must not expand or collapse anything (#85); got ${body}`,
  );

  // 3. and the dead-end guard must be gone entirely
  assert.doesNotMatch(
    body,
    /if \(!row\.chatCollapsedGroup\)/,
    `a collapsed row must never be a dead end (#66); got ${body}`,
  );
});

test("the caret remains the control that expands (#85)", () => {
  // The other half of #85: removing expand-on-select must not remove the ability
  // to expand. The caret handler still toggles, in both directions.
  const app = readSource(new URL("../frontend/App.tsx", import.meta.url));
  // #81 wrapped the toggle in a block that also clears the second collapse store,
  // so the literal prefix is gone. Assert the call, which is the actual rule.
  const caretAt = app.indexOf("toggleWsGroup(`chat:${row.a.id}`, row.a.id, off)");
  assert.ok(caretAt > 0, "the caret must still toggle the chat group (#85)");
  const around = app.slice(caretAt - 200, caretAt + 200);
  assert.match(
    around,
    /toggleWsGroup\(`chat:\$\{row\.a\.id\}`, row\.a\.id, off\)/,
    `the caret passes the current state, so it toggles both ways (#85); got ${around.slice(120, 260)}`,
  );
});


test("the row handler has no conditional at all (#66/#85)", () => {
  // The handler is now a single unconditional `select(...)`. A conditional here
  // could only reintroduce either bug: guard it and the row becomes a dead end
  // (#66), or branch on the collapsed state and it forces the subtree open
  // (#85). So the assertion is simply "no branches".
  const body = sidebarRowOnClick(readSource(new URL("../frontend/App.tsx", import.meta.url)));
  assert.doesNotMatch(
    body,
    /\b(if|for|while|switch)\b/,
    `the row handler must be unconditional (#66/#85); got ${body}`,
  );
});


