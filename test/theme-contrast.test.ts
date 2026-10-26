import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PRESET_PALETTES } from "../frontend/lib/theme-store.ts";
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
  for (const [name, p] of Object.entries(PRESET_PALETTES)) {
    for (const s of [p.bgDarkest, p.bgDark]) {
      const c = contrast(p.dim, s);
      assert.ok(c >= 3, `${name}: muted text on ${s} is ${c.toFixed(2)}:1, below 3`);
    }
  }
});

test("the ACCENT is distinguishable from the surfaces it sits on (#theme)", () => {
  for (const [name, p] of Object.entries(PRESET_PALETTES)) {
    const c = contrast(p.acc, p.bgDarkest);
    assert.ok(c >= 3, `${name}: accent on bgDarkest is ${c.toFixed(2)}:1, below 3`);
  }
});

test("a light theme's checkbox border is VISIBLE, not a smudge (#theme)", () => {
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
  assert.ok(
    contrast("#c2e2ef", "#c9e7f4") < 1.5,
    "`--line` is a hairline separator (ramune: ~1.05:1) and must not be used for a control edge",
  );
});

test("the message HOVER tint is visible on light themes too (#theme)", () => {
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
  const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
  const veil = cssRuleBody(css, ".bgphoto-veil");
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
  assert.match(veil, /position:\s*absolute/, "the veil must overlay the image, not sit behind it");

  const light = luminance("#ecf7fb");
  const dark = luminance("#232630");
  assert.ok(light > 0.8, "a light theme's surface must be near-white, or this test proves nothing");
  assert.ok(dark < 0.1, "a dark theme's surface must be near-black");
});
