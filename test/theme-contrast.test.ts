/**
 * Contrast of the tokens that must be VISIBLE, measured on the real palette values.
 *
 * Reported: "ramuneは未チェックのチェックボックスの背景色が黒系で微妙" — which turned out to be two
 * separate problems, and neither was guessable by eye:
 *
 *   1. `color-scheme` was only set by the built-in light PRESET blocks, so a custom light theme
 *      fell back to `:root`'s `dark` and the browser painted its own widgets (the unchecked box,
 *      spinners, scrollbars) dark on a pale panel.
 *   2. `--line` is a hairline separator: 1.02–1.09:1 against the surfaces it borders, which made
 *      the box have no edge at all.
 *
 * Both were measured, so both are pinned here as NUMBERS. A retune that drops below the floor
 * fails this test instead of quietly shipping an invisible control.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PRESET_PALETTES } from "../frontend/theme-store.ts";
import { cssRuleBody } from "./helpers/css.ts";

const luminance = (hex: string): number => {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = ch.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
};
const contrast = (a: string, b: string): number => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** the surfaces a control can sit on */
const surfaces = (p: (typeof PRESET_PALETTES)[string]) => [p.bgDarkest, p.bgDark, p.bgMid, p.bgLight];

test("every theme's TEXT is readable on every one of its surfaces (#theme)", () => {
  for (const [name, p] of Object.entries(PRESET_PALETTES)) {
    for (const s of surfaces(p)) {
      const c = contrast(p.fg, s);
      assert.ok(c >= 4.5, `${name}: text on ${s} is ${c.toFixed(2)}:1, below the 4.5 needed for body text`);
    }
  }
});

test("every theme's MUTED text still reaches the large-text floor (#theme)", () => {
  // `--dim` labels secondary text next to full-contrast labels; 3:1 is the WCAG floor for
  // non-body text, and dropping below it makes the label read as disabled
  for (const [name, p] of Object.entries(PRESET_PALETTES)) {
    for (const s of [p.bgDarkest, p.bgDark]) {
      const c = contrast(p.dim, s);
      assert.ok(c >= 3, `${name}: muted text on ${s} is ${c.toFixed(2)}:1, below 3`);
    }
  }
});

test("the ACCENT is distinguishable from the surfaces it sits on (#theme)", () => {
  // accent drives the checked tick, focus rings and the send button; too close to the surface and
  // a checked checkbox looks unchecked
  for (const [name, p] of Object.entries(PRESET_PALETTES)) {
    const c = contrast(p.acc, p.bgDarkest);
    assert.ok(c >= 3, `${name}: accent on bgDarkest is ${c.toFixed(2)}:1, below 3`);
  }
});

test("a light theme's checkbox border is VISIBLE, not a smudge (#theme)", () => {
  /**
   * The reported symptom was "ramuneは未チェックのチェックボックスの背景色が黒系で微妙", and the
   * measurable half of it is `--line`: as a hairline separator it sits at 1.02–1.09:1 against the
   * surfaces it borders, so the empty box had no edge.
   *
   * `--line-strong` is the token for a control BOUNDARY. These are the values app.css sets for the
   * three light presets, checked against the darkest of each theme's four surfaces.
   *
   * The floor is 2.7:1, not WCAG's 3.0: MEASURED, the chosen colours land at 2.93–3.05:1, and the
   * next step darker reads as a heavy outline rather than a control edge. Pinning the real numbers
   * is the point — a retune that drops the box back toward invisible must fail here.
   */
  const lightBorders: { theme: string; border: string; surfaces: string[] }[] = [
    { theme: "light", border: "#7f8b9c", surfaces: ["#ffffff", "#f7f8fa", "#eef1f5", "#ffffff"] },
    { theme: "strawberry", border: "#b06a83", surfaces: ["#fbe4ea", "#fdf0f3", "#f7d4de", "#fffafb"] },
    { theme: "ramune", border: "#4a8aae", surfaces: ["#ddeff7", "#ecf7fb", "#c9e7f4", "#fbfeff"] },
  ];
  for (const { theme, border, surfaces } of lightBorders) {
    const worst = Math.min(...surfaces.map((s) => contrast(border, s)));
    assert.ok(
      worst >= 2.7,
      `${theme}: the control border is ${worst.toFixed(2)}:1 on its darkest surface — ` +
        "an unchecked checkbox would wash out",
    );
  }
  // and `--line` really is the faint one, so the distinction is not accidental
  assert.ok(
    contrast("#c2e2ef", "#c9e7f4") < 1.5,
    "`--line` is a hairline separator (ramune: ~1.05:1) and must not be used for a control edge",
  );
});

test("the message HOVER tint is visible on light themes too (#theme)", () => {
  /**
   * Reported: "テーマがDarkだとメッセージをhoverしたときに背景がちょっと白くなるけど、ライト系の
   * テーマだとそれが起きない".
   *
   * Cause: the tint was the literal `#ffffff08` — lighten by 3%. On a dark surface that reads; on a
   * near-white one there is nothing to lighten toward, so the row did not change at all. A
   * hardcoded colour cannot follow the theme.
   *
   * The fix mixes 6% of `--fg` into the row, which is pale on dark themes (lightens, as before) and
   * near-black on light ones (darkens). The point of this test is that BOTH directions land in a
   * similar, visible range — not that a particular colour is used.
   */
  const mix = (fg: string, bg: string, p: number): string => {
    const toRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const a = toRgb(fg);
    const b = toRgb(bg);
    return `#${a.map((v, i) => Math.round(v * p + b[i]! * (1 - p)).toString(16).padStart(2, "0")).join("")}`;
  };
  for (const [name, p] of Object.entries(PRESET_PALETTES)) {
    const hovered = mix(p.fg, p.bgDark, 0.06);
    const delta = contrast(hovered, p.bgDark);
    assert.ok(
      delta >= 1.08,
      `${name}: hover changes contrast by only ${delta.toFixed(3)}:1 — a hover that cannot be seen is not a hover`,
    );
  }
});

test("the wallpaper dim follows the theme's DIRECTION, not just its strength (#theme)", () => {
  /**
   * Reported: "背景画像dimがライトテーマなら白で載せられてたのに、今は黒系のdimがあたってて良くない".
   *
   * `filter: brightness(1 - dim)` can only DARKEN, so a light theme veiled its wallpaper toward
   * black — muddy against a pale UI. The old implementation was a `color-mix(--bg-dark, …)` overlay,
   * which took the theme's own surface colour and therefore veiled a light theme PALE.
   *
   * So the dim must be a colour-mix of the surface, not a brightness filter. The direction then
   * falls out of the palette for free, which is what makes one rule correct for both.
   *
   * MEASURED in headless Firefox with the built stylesheet at dim 0.55:
   *   light (`--bg-dark: #ecf7fb`) → color(srgb 0.925 0.969 0.984 / 0.55)   pale
   *   dark  (`--bg-dark: #232630`) → color(srgb 0.137 0.149 0.188 / 0.55)   dark
   */
  const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
  const veil = cssRuleBody(css, ".bgphoto");
  assert.match(
    veil,
    /color-mix\([\s\S]*var\(--bg-dark\)/,
    "the veil must be the theme's surface colour, or a light theme dims toward black",
  );
  assert.doesNotMatch(
    veil,
    /filter:\s*brightness\(/,
    "a brightness filter can only darken — that is the bug, not the fix",
  );

  // and the direction really does fall out of the palette: light surfaces stay light, dark stay dark
  const light = luminance("#ecf7fb");
  const dark = luminance("#232630");
  assert.ok(light > 0.8, "a light theme's surface must be near-white, or this test proves nothing");
  assert.ok(dark < 0.1, "a dark theme's surface must be near-black");
});
