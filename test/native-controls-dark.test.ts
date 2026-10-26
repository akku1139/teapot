import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBodies } from "./helpers/css.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

function firstRule(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (sel.split(",").map((s) => s.trim()).includes(selector)) return m[2]!;
  }
  return "";
}

test("an unchecked checkbox gets a theme background (#102)", () => {
  const rule = css.match(/input\[type="?checkbox"?\][^{]*\{([^}]*)\}/g)?.join("\n") ?? "";
  assert.match(
    rule,
    /background-color:\s*var\(--bg-darkest\)/,
    "the EMPTY box is UA-painted unless told otherwise — accent-color does not cover it (#102)",
  );
  assert.match(
    rule,
    /border:\s*1px solid var\(--line-strong\)/,
    "the box border must use the control-boundary token, not the hairline (#112)",
  );
});

const hex = (h: string) => {
  const s = h.replace("#", "").length === 3 ? h.replace("#", "").split("").map((c) => c + c).join("") : h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
};
const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lum = (h: string) => {
  const [r, g, b] = hex(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const THEMES: [string, string, string][] = [
  ["default", "#1a1c22", "#9298a5"],
  ["nord", "#0d0f18", "#8a90ad"],
  ["solarized", "#241c16", "#b39d82"],
  ["mocha", "#191410", "#a89478"],
];

test("the unchecked checkbox border is VISIBLE in every theme (#112)", () => {
  for (const [name, bg, dim] of THEMES) {
    const ratio = contrast(dim, bg);
    assert.ok(
      ratio >= 3.0,
      `${name}: the unchecked box border must be visible (#112); ${dim} on ${bg} is only ${ratio.toFixed(2)}:1`,
    );
  }
});

test("the palette values above are the ones the themes actually ship (#112)", () => {
  for (const [name, bg, dim] of THEMES) {
    assert.ok(css.includes(bg), `${name}: --bg-darkest ${bg} must exist (#112)`);
    assert.ok(css.includes(dim), `${name}: --dim ${dim} must exist (#112)`);
  }
});

test("the NATIVE widget is kept, not reimplemented (#112)", () => {
  assert.doesNotMatch(
    css,
    /input\[type="checkbox"\][^{]*\{[^}]*appearance:\s*none/,
    "the native checkbox must be kept — only its background needed fixing (#112)",
  );
  assert.doesNotMatch(css, /content:\s*"✓"/, "and the tick must not be hand-drawn (#112)");
});

test("accent-color still tints the checked state per theme (#112)", () => {
  assert.match(css, /input\[type="checkbox"\]\s*\{[^}]*accent-color:\s*var\(--acc\)/, "accent-color must remain (#112)");
});

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

test("a bare <button> is styled somewhere (#102)", () => {
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
  assert.match(block, /border:\s*1px solid var\(--dim\)/, "and a border that reads as a control (#112)");
});

test("the modal rule cannot repaint the composer or icon buttons (#102)", () => {
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

test("no hardcoded white was introduced (#102)", () => {
  const mine = css.slice(css.indexOf("#102: three native controls"));
  assert.doesNotMatch(
    mine,
    /#fff\b|#ffffff\b/i,
    "the fix must use theme tokens, or the other nine appearances regress (#102)",
  );
});

test("the sheet declares color-scheme so UA widgets follow the theme (#102)", () => {
  const decls = css.match(/color-scheme:\s*(dark|light)/g) ?? [];
  assert.ok(
    decls.some((d) => /dark/.test(d)),
    "the dark default must be declared — without it every native control paints light (#102)",
  );
});

test("the LIGHT themes override color-scheme, or their widgets would stay dark (#102)", () => {
  const light = ["light", "strawberry", "ramune"];
  for (const t of light) {
    const block = new RegExp(`\\[data-theme="${t}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    assert.match(
      block,
      /color-scheme:\s*light/,
      `the ${t} theme must set color-scheme: light inside its own block (#102)`,
    );
  }
});

test("the dark themes do NOT set color-scheme: light (#102)", () => {
  for (const t of ["midnight", "tea", "coffee", "matcha", "matrix", "sunset"]) {
    const block = new RegExp(`\\[data-theme="${t}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    assert.doesNotMatch(block, /color-scheme:\s*light/, `${t} is dark (#102)`);
  }
});

test("every theme either declares color-scheme or inherits the dark default (#102)", () => {
  const themes = [...new Set([...css.matchAll(/\[data-theme="([a-z]+)"\]/g)].map((m) => m[1]!))];
  assert.equal(themes.length, 9, `theme count changed — re-check which are light: ${themes.join(", ")}`);
  const light = ["light", "strawberry", "ramune"];
  assert.deepEqual(
    themes.filter((t) => light.includes(t)).sort(),
    [...light].sort(),
    "the light set must exactly match the themes that declare color-scheme: light",
  );
});
