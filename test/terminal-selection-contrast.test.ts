import { test } from "node:test";
import assert from "node:assert/strict";
import { selectionFor, themeColors, retintTerminal } from "../frontend/lib/terminal-theme.ts";

/**
 * A terminal selection must be VISIBLE against the terminal's own background.
 *
 * Reported as "ライトテーマでターミナルの選択中の色が背景と同じっぽい". xterm does NOT derive
 * `selectionBackground` from the palette — it ships a fixed light highlight, which reads fine on a
 * dark terminal and vanishes on `--term-bg: #ffffff`. So a drag looked like it did nothing, and a
 * copy had no visible source.
 *
 * `themeColors()` named the cursor for the same class of reason (#137: a near-black caret on a
 * near-white background) and had left selection unset. This pins that it is set now, and that the
 * derived wash actually separates from the background.
 */

/** relative luminance, enough to compare two colours */
const lum = (hex: string): number => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return NaN;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i]!, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** the selection colour composited over the terminal background — what the eye actually sees */
const composite = (sel: string, bg: string): string => {
  const m = /^#(..)(..)(..)(..)$/.exec(sel);
  if (!m) return sel;
  const a = parseInt(m[4]!, 16) / 255;
  const bgm = /^#(..)(..)(..)$/.exec(bg);
  if (!bgm) return sel;
  const ch = [m[1], m[2], m[3]].map((h, i) =>
    Math.round(parseInt(h!, 16) * a + parseInt(bgm[i + 1]!, 16) * (1 - a)),
  );
  return "#" + ch.map((v) => v.toString(16).padStart(2, "0")).join("");
};

test("the selection is set at all — xterm does not derive it (#term)", () => {
  const t = themeColors();
  assert.ok(t.selectionBackground, "without this, xterm's fixed light highlight is used (#term)");
  assert.match(t.selectionBackground!, /^#[0-9a-f]{8}$|^rgba/, "an alpha colour, so it works over any bg (#term)");
});

test("the selection separates from BOTH a white and a near-black background (#term)", () => {
  /**
   * Driven over the real palettes from app.css rather than one hardcoded pair: the bug appeared only
   * on light themes, so a test that checked a dark pair would have passed through it.
   */
  for (const [name, bg, fg] of [
    ["light", "#ffffff", "#24272f"],
    ["dark", "#0d0e12", "#dcdee4"],
    ["coffee", "#1d1712", "#ecdcc3"],
    ["matrix", "#030503", "#33ff77"],
  ] as const) {
    const sel = selectionFor(fg);
    const seen = composite(sel, bg);
    const contrast = Math.abs(lum(seen) - lum(bg));
    assert.ok(
      contrast > 0.08,
      `${name}: a selection must be visibly different from the background ` +
        `(bg ${bg} → selection ${seen}, contrast ${contrast.toFixed(3)}) (#term)`,
    );
  }
});

test("re-theming notices a selection change (#term)", () => {
  /**
   * `retintTerminal` skips the write when the theme looks unchanged. Adding a field without adding it
   * to that comparison leaves a live terminal on the OLD palette forever — the same trap the cursor
   * fields hit in #137, which is why the comparison is asserted here rather than assumed.
   */
  const stale = { options: { theme: { background: "#000", foreground: "#fff", cursor: "#fff", cursorAccent: "#000", selectionBackground: "#ff0000ff" } } };
  retintTerminal(stale as never);
  // the ambient palette in a DOM-less test falls back to dark, so the selection differs → a write
  assert.notEqual(
    stale.options.theme.selectionBackground,
    "#ff0000ff",
    "a changed selection must trigger the re-theme (#term)",
  );
});
