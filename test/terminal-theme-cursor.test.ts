/**
 * #137 — light theme で terminal cursor が見えない。
 *
 * `themeColors()` は `background` / `foreground` しか返さず、`Terminal` にも
 * `theme: themeColors()` だけを渡す。xterm の既定 cursor 色はテーマに追随
 * しないので、ライトテーマ（白背景）にダーク用の cursor が残る。
 *
 * さらに `retintTerminal()` の差分比較も background / foreground だけ。
 * cursor 良好で bg/fg が同一のテーマ（例: ダーク→別ダーク、あるいは旧形状の
 * theme オブジェクト）では cursor が取り残される。
 *
 * このモジュールは App.tsx から production import される実装本体であり、
 * 純粋な構造体型のみで solid / xterm を import しない — テストは DOM なしで
 * 実コードを実行する（#75 の source grep テストを再発させないため）。
 *
 * Required:
 *   - themeColors() は cursor / cursorAccent を明示する（cursor = foreground,
 *     cursorAccent = background を既定とし、CSS 変数での上書きを許す）
 *   - retintTerminal() は cursor / cursorAccent の差分でも再テーマする
 *     （bg/fg が同一でも cursor が違えば書く）
 *   - 全フィールドが一致する場合は書かない（無駀な再テーマを避ける既存契約）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { themeColors, retintTerminal, type XtermTheme } from "../frontend/terminal-theme.ts";

test("themeColors explicitly names the cursor colours (#137)", () => {
  const want = themeColors();
  assert.ok(want.background, "background resolved (fallback applies outside the DOM)");
  assert.ok(want.foreground, "foreground resolved");
  assert.equal(want.cursor, want.foreground, "cursor follows the foreground: visible on BOTH themes (#137)");
  assert.equal(want.cursorAccent, want.background, "cursorAccent follows the background (#137)");
});

test("retintTerminal re-themes when only the CURSOR colours differ (#137)", () => {
  // the light-theme trap: bg/fg already match the active palette but the caret
  // was left by the OTHER mode (or predates the cursor fields entirely)
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
