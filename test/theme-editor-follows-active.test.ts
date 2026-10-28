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

test("the editor follows the theme in use, not the one it was pinned to", () => {
  /**
   * The background-image picker renders whatever theme the editor picked, so "which theme is the editor
   * editing" IS "which wallpaper does the picker show". Reported: "背景選択ボタンバグってない? 当たってる
   * 背景と違うやつがでてるよ".
   *
   * The pin is real — `editingId` is seeded when the modal is created and picking a theme does not update
   * it. MEASURED in Firefox with two custom themes: opening settings on the dark theme and then clicking
   * the light card left `picker: /a.png` while the page had `/b.png`; after this rule it is `/b.png`.
   */
  assert.equal(themeBeingEdited([dark, light], "ct-light", "ct-dark")?.id, "ct-light");
  assert.equal(themeBeingEdited([dark, light], "ct-light", undefined)?.id, "ct-light");
});

test("a deleted active theme falls back instead of showing nothing", () => {
  assert.equal(themeBeingEdited([dark, light], "ct-gone", "ct-light")?.id, "ct-light");
  assert.equal(themeBeingEdited([dark], "ct-gone", "ct-gone")?.id, "ct-dark");
  assert.equal(themeBeingEdited([], "x", undefined), undefined);
});
