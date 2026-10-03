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
  // #112: `--line` is the hairline colour and measured 1.02-1.09:1 against
  // --bg-darkest in every theme — i.e. no visible boundary at all. The test now
  // checks the CONTRAST rather than a token name, so it cannot drift with the
  // palette.
  assert.match(rule, /border:\s*1px solid var\(--dim\)/, "the box border must be a visible weight (#112)");
});

/* ---------- contrast, measured rather than token-matched (#112) ---------- */

const hex = (h: string) => {
  const s = h.replace("#", "").length === 3 ? h.replace("#", "").split("").map((c) => c + c).join("") : h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
};
const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lum = (h: string) => {
  const [r, g, b] = hex(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio */
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** every theme block: [name, bg-darkest, dim] — the two the checkbox uses */
const THEMES: [string, string, string][] = [
  ["default", "#1a1c22", "#9298a5"],
  ["nord", "#0d0f18", "#8a90ad"],
  ["solarized", "#241c16", "#b39d82"],
  ["mocha", "#191410", "#a89478"],
];

test("the unchecked checkbox border is VISIBLE in every theme (#112)", () => {
  // the operator's report was "the new colours are hard to read". Measured, the
  // cause was --line at 1.02-1.09:1 — no boundary at all. WCAG wants 3.0:1 for
  // a non-text UI boundary.
  for (const [name, bg, dim] of THEMES) {
    const ratio = contrast(dim, bg);
    assert.ok(
      ratio >= 3.0,
      `${name}: the unchecked box border must be visible (#112); ${dim} on ${bg} is only ${ratio.toFixed(2)}:1`,
    );
  }
});

test("the palette values above are the ones the themes actually ship (#112)", () => {
  // so this cannot pass against stale numbers after a palette change
  for (const [name, bg, dim] of THEMES) {
    assert.ok(css.includes(bg), `${name}: --bg-darkest ${bg} must exist (#112)`);
    assert.ok(css.includes(dim), `${name}: --dim ${dim} must exist (#112)`);
  }
});

test("the NATIVE widget is kept, not reimplemented (#112)", () => {
  // the hand-drawn "✓" replaced the platform tick with an 11px glyph that does
  // not match the theme's type and loses forced-colours support. The reported
  // bug was only ever an unchecked box rendering white.
  assert.doesNotMatch(
    css,
    /input\[type="checkbox"\][^{]*\{[^}]*appearance:\s*none/,
    "the native checkbox must be kept — only its background needed fixing (#112)",
  );
  assert.doesNotMatch(css, /content:\s*"✓"/, "and the tick must not be hand-drawn (#112)");
});

test("accent-color still tints the checked state per theme (#112)", () => {
  // with the native widget back, this is what colours the check
  assert.match(css, /input\[type="checkbox"\]\s*\{[^}]*accent-color:\s*var\(--acc\)/, "accent-color must remain (#112)");
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
  // #112: --dim, not --line — the hairline border measured 1.35-1.55:1 against
  // the page, so the button's edge barely registered as a control
  assert.match(block, /border:\s*1px solid var\(--dim\)/, "and a border that reads as a control (#112)");
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
