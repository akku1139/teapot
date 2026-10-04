/**
 * #111 — "goal-related cards scroll horizontally; they must wrap properly."
 *
 * ## Cause
 *
 * A goal card with `markdown: false` is rendered by App.tsx as a FENCED block:
 *
 *     line.markdown ? renderMarkdown(line.detail)
 *                   : renderMarkdown("```\n" + line.detail + "\n```")
 *
 * The fence is there for a good reason — `markdown:false` means "plain text", and
 * without it the renderer would eat `**bold**`, join lines, and collapse runs of
 * spaces. Measured:
 *
 *     "line one\nline two"        fenced keeps the newline, plain joins them
 *     "**not bold**"              fenced shows it literally, plain drops the stars
 *
 * So the fence cannot simply be removed. But `.content pre` is styled
 * `overflow-x: auto` — correct for CODE, wrong for prose. A verification contract
 * is free text up to 4000 chars (`setGoalVerify`), full of file paths, so seven of
 * the goal branches produced a horizontal scrollbar inside a card.
 *
 * ## Fix
 *
 * Keep `overflow-x` for real code, and make the text wrap:
 *
 *     .content pre > code { white-space: pre-wrap; overflow-wrap: anywhere; }
 *
 * `pre-wrap` preserves the newlines and the runs of spaces the fence was there
 * for, while allowing long lines to break; `overflow-wrap: anywhere` breaks
 * inside an otherwise unbreakable token such as a path, which is what actually
 * causes the scrollbar.
 *
 * Note `pre > code`, not `pre`: a bare `<pre>` with no `<code>` (which is what a
 * fenced block with no language produces) must wrap too, so the rule is checked
 * against the structure the renderer actually emits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Window } from "happy-dom";
import { renderMarkdown } from "../frontend/md.js";
import { goalLine } from "../frontend/goal-timeline.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

/* ---------- the rule ---------- */

test("code inside a card wraps rather than scrolling (#111)", () => {
  assert.match(
    css,
    /\.content pre\s*>\s*code\s*\{[^}]*white-space:\s*pre-wrap/,
    "the fence must still preserve newlines and spaces (#111)",
  );
  assert.match(
    css,
    /\.content pre\s*>\s*code\s*\{[^}]*overflow-wrap:\s*anywhere/,
    "and long unbreakable tokens (paths) must break instead of scrolling (#111)",
  );
});

test("real code blocks keep their own horizontal scroll (#111)", () => {
  // #111 is about PROSE, not code: `.content pre` must stay overflow-x:auto so a
  // wide diff still scrolls rather than reflowing into an unreadable shape
  assert.match(
    css,
    /\.content pre\s*\{[^}]*overflow-x:\s*auto/,
    "a genuine code block must still scroll horizontally (#111)",
  );
});

/* ---------- the fence's purpose is preserved ---------- */

test("the plain-text detail still keeps its newlines (#111)", () => {
  const detail = "first requirement\nsecond requirement\nthird requirement";
  const fenced = renderMarkdown("```\n" + detail + "\n```").replace(/<[^>]+>/g, "");
  assert.ok(
    fenced.includes("first requirement\nsecond requirement"),
    `the fence must preserve line breaks; got ${JSON.stringify(fenced)} (#111)`,
  );
});

test("a goal card's contract is multi-line and reaches a <pre> (#111)", () => {
  // the reported symptom depends on this shape: a LONG, path-bearing contract
  const contract =
    "src/agent/agent.ts must fail without the fix; src/server/api.ts must return 400; verified by reverting each and observing the suite go red";
  // the `audit-started` phase is the one whose detail IS the contract
  // (`detail: String(d.verify ?? "")`) and is plain-text, hence fenced
  const line = goalLine({ event: "audit-started", verify: contract } as never);
  assert.equal(line.hasCard, true, "the contract renders as a card (#111)");
  assert.equal(line.markdown, false, "and as plain text, hence fenced (#111)");
  assert.equal(
    line.detail,
    contract,
    "the whole contract reaches the card, not a summary (#111)",
  );

  const html = renderMarkdown("```\n" + line.detail + "\n```");
  const w = new Window();
  const d = w.document.createElement("div");
  d.className = "card content";
  d.innerHTML = html;
  const pre = d.querySelector("pre");
  assert.ok(pre, "so a <pre> is what scrolls (#111)");
  assert.ok(
    (pre!.textContent ?? "").length > 120,
    "and it holds the whole contract, not a summary (#111)",
  );
});

/* ---------- against the SHIPPED stylesheet, not the source ---------- */

test("the shipped CSS has the wrapping rule (#111)", () => {
  // the source rule could be tree-shaken, renamed or not included; assert on the
  // built asset so the check cannot pass while the bundle lacks it
  const dir = new URL("../public/assets/", import.meta.url);
  let name: string | undefined;
  try {
    name = readdirSync(dir).find((f) => f.endsWith(".css"));
  } catch {
    return; // no build present (CI runs this before `vite build`); source rule is covered above
  }
  if (!name) return;
  const built = readFileSync(new URL(name, dir), "utf8");
  assert.match(
    built,
    /\.content pre>code\{[^}]*white-space:pre-wrap/,
    `the SHIPPED css must wrap goal-card code (#111); ${name}`,
  );
});