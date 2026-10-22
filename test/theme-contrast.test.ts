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
import { PRESET_PALETTES } from "../frontend/theme-store.ts";

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
