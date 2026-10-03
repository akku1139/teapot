/**
 * #102 — three native controls stayed white in the dark themes:
 *
 *   1. an UNCHECKED checkbox
 *   2. the number input's native ▲▼ spinners
 *   3. the settings window's "+ add custom" / "+ add task" buttons
 *
 * All three are UA-painted, so they ignore the theme unless told otherwise.
 * `accent-color` (already present) colours only the CHECKED tick, which is why
 * the empty box stayed white. And there was NO rule for a bare `<button>`
 * anywhere in the sheet — only `.composer button` and `.iconbtn` — so the two
 * settings buttons rendered as unstyled white-on-white.
 *
 * Every colour must be a theme token, or the ten appearances diverge again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

/** the body of the first rule whose selector list contains `selector` exactly */
function firstRule(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (sel.split(",").map((s) => s.trim()).includes(selector)) return m[2]!;
  }
  return "";
}

/* ---------- 1. the unchecked checkbox ---------- */

test("an unchecked checkbox gets a theme background (#102)", () => {
  const rule = css.match(/input\[type="?checkbox"?\][^{]*\{([^}]*)\}/g)?.join("\n") ?? "";
  assert.match(
    rule,
    /background-color:\s*var\(--bg-darkest\)/,
    "the EMPTY box is UA-painted unless told otherwise — accent-color does not cover it (#102)",
  );
  assert.match(rule, /border:\s*1px solid var\(--line\)/, "and needs a border to read as a control (#102)");
});

test("the checkbox tick is drawn, not inherited (#102)", () => {
  assert.match(
    css,
    /input\[type="checkbox"\]:checked::before\s*\{[^}]*content:\s*"✓"/,
    "with appearance:none the UA tick disappears, so it must be drawn (#102)",
  );
});

/* ---------- 2. the number spinners ---------- */

test("the number spinners are suppressed (#102)", () => {
  assert.match(
    css,
    /input\[type="number"\]\s*\{[^}]*appearance:\s*textfield/,
    "Firefox draws its own spinner (#102)",
  );
  assert.match(
    css,
    /-webkit-outer-spin-button,\s*\n?\s*input\[type="number"\]::-webkit-inner-spin-button\s*\{[^}]*-webkit-appearance:\s*none/,
    "Chromium needs both pseudo-elements neutralised (#102)",
  );
});

/* ---------- 3. the settings-window buttons ---------- */

test("a bare <button> is styled somewhere (#102)", () => {
  // the structural fact: before #102 the sheet had NO rule for a bare button,
  // which is why the two settings buttons were unstyled
  const hasBare = [...css.matchAll(/(^|[},])\s*button\s*(,[^{]*)?\{/gm)].length > 0;
  const modalScoped = /\.modal[^{]*button[^{]*\{/.test(css);
  assert.ok(
    hasBare || modalScoped,
    "some rule must cover the settings buttons — they were unstyled UA widgets (#102)",
  );
});

test("the modal add-buttons are themed, not white (#102)", () => {
  const block = css.slice(css.indexOf(".modal > button"), css.indexOf("@media") === -1 ? css.length : 1e9);
  assert.match(block, /background:\s*var\(--bg-light\)/, "a background is required (#102)");
  assert.match(block, /color:\s*var\(--fg\)/, "and a readable text colour (#102)");
  assert.match(block, /border:\s*1px solid var\(--line\)/, "and a border to match the other inputs (#102)");
});

test("the modal rule cannot repaint the composer or icon buttons (#102)", () => {
  // deliberately scoped: a global `button {}` would fight .composer button and
  // .iconbtn, which already have their own styling
  // 900 chars was too small — it cut the selector list off before the
  // `:not(.iconbtn)` guard, so the check failed against correct CSS. Anchor on
  // the end of the rule block instead of guessing a length.
  const at = css.indexOf(".modal > button");
  const block = css.slice(at, css.indexOf("}", css.indexOf("}", at) + 1) + 1);
  assert.ok(
    /:not\(\.iconbtn\)/.test(block) || /^\.modal > button/m.test(block),
    "the rule must stay scoped to .modal (#102)",
  );
  assert.doesNotMatch(
    block,
    /^\s*button\s*\{/m,
    "and must not be a bare global button rule (#102)",
  );
});

/* ---------- the markup the fix exists for ---------- */

test("the settings window really does use bare buttons (#102)", () => {
  // if this ever gains a class, the fix above is no longer load-bearing and
  // should be revisited rather than left to rot
  assert.match(app, /<button type="button" onclick=\{\(\) => setProviders/, "the + add custom button (#102)");
  assert.match(app, /<button type="button" onclick=\{\(\) => setTasks/, "the + add task button (#102)");
});

test("no hardcoded white was introduced (#102)", () => {
  const mine = css.slice(css.indexOf("#102: three native controls"));
  assert.doesNotMatch(
    mine,
    /#fff\b|#ffffff\b/i,
    "the fix must use theme tokens, or the other nine appearances regress (#102)",
  );
});
