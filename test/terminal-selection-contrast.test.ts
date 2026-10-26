import { test } from "node:test";
import assert from "node:assert/strict";
import { selectionFor, themeColors, retintTerminal } from "../frontend/lib/terminal-theme.ts";

const lum = (hex: string): number => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return NaN;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i]!, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

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
  const stale = { options: { theme: { background: "#000", foreground: "#fff", cursor: "#fff", cursorAccent: "#000", selectionBackground: "#ff0000ff" } } };
  retintTerminal(stale as never);
  assert.notEqual(
    stale.options.theme.selectionBackground,
    "#ff0000ff",
    "a changed selection must trigger the re-theme (#term)",
  );
});
