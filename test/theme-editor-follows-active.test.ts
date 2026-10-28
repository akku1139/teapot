import assert from "node:assert/strict";
import test from "node:test";
import { themeBeingEdited } from "../frontend/lib/theme-store.ts";

const p = {
  bgDarkest: "#111111", bgDark: "#222222", bgMid: "#333333", bgLight: "#444444", fg: "#eeeeee",
  dim: "#999999", line: "#555555", acc: "#58a6ff", ok: "#3fb950", warn: "#d29922", err: "#f85149",
  tool: "#a371f7", termBg: "#000000", termFg: "#ffffff",
};
const dark = { id: "ct-dark", label: "Mine dark", mode: "dark" as const, palette: p, backgroundImage: "/a.png" };
const light = { id: "ct-light", label: "Mine light", mode: "light" as const, palette: p, backgroundImage: "/b.png" };

test("the editor edits the theme ON SCREEN, not the fixed fallback", () => {
  /**
   * The background-image picker renders whatever theme the editor picked, so "which theme is the editor
   * editing" IS "which wallpaper does the picker show". Reported twice: "背景選択ボタンバグってない?
   * 当たってる背景と違うやつがでてるよ", then "v0.37.96 入れたのに直ってない / follow the systemのとき".
   *
   * With "follow the system" on there are two candidate ids and only one is the truth: `paintedId` is the
   * theme on screen, `activeId` is the fixed fallback nobody is looking at. MEASURED in Firefox (auto on,
   * system dark, fixed=light): picker showed /b.png while the page painted /a.png; passing `paintedId`
   * makes both /a.png.
   */
  assert.equal(themeBeingEdited([dark, light], dark.id, light.id)?.id, dark.id);
  assert.equal(themeBeingEdited([dark, light], light.id, dark.id)?.id, light.id);
});

test("a stale pin cannot win, and a deleted theme falls back", () => {
  // `editingId` is seeded once when the modal is created and is not updated by picking a theme.
  assert.equal(themeBeingEdited([dark, light], light.id, undefined)?.id, "ct-light");
  // the theme in use is gone (just deleted) — fall back rather than show nothing
  assert.equal(themeBeingEdited([dark, light], "ct-gone", light.id)?.id, "ct-light");
  assert.equal(themeBeingEdited([dark], "ct-gone", "ct-gone")?.id, "ct-dark");
  assert.equal(themeBeingEdited([], "x", undefined), undefined);
});
