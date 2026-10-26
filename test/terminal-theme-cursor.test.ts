import { test } from "node:test";
import assert from "node:assert/strict";
import { themeColors, retintTerminal, type XtermTheme } from "../frontend/lib/terminal-theme.ts";

test("themeColors explicitly names the cursor colours (#137)", () => {
  const want = themeColors();
  assert.ok(want.background, "background resolved (fallback applies outside the DOM)");
  assert.ok(want.foreground, "foreground resolved");
  assert.equal(want.cursor, want.foreground, "cursor follows the foreground: visible on BOTH themes (#137)");
  assert.equal(want.cursorAccent, want.background, "cursorAccent follows the background (#137)");
});

test("retintTerminal re-themes when only the CURSOR colours differ (#137)", () => {
  const want = themeColors();
  const stale: XtermTheme = { background: want.background, foreground: want.foreground, cursor: "#ff00ff-stale" };
  const term = { options: { theme: stale } };
  retintTerminal(term);
  assert.equal(term.options.theme?.background, want.background, "re-themed from the live palette");
  assert.equal(term.options.theme?.cursor, want.cursor, "the stale cursor was replaced (#137)");
  assert.equal(term.options.theme?.cursorAccent, want.cursorAccent, "#137");
});

test("retintTerminal leaves a terminal whose full theme already matches", () => {
  const want = themeColors();
  const cur: XtermTheme = { ...want };
  const term = { options: { theme: cur } };
  retintTerminal(term);
  assert.equal(term.options.theme, cur, "an exact match must not churn (existing contract)");
});

test("retintTerminal writes when ANY field differs (bg/fg path kept)", () => {
  const want = themeColors();
  const term = { options: { theme: { background: "#000000", foreground: want.foreground, cursor: want.cursor, cursorAccent: want.cursorAccent } } };
  retintTerminal(term);
  assert.equal(term.options.theme?.background, want.background, "a background drift still re-themes (the original #137 path)");
});
