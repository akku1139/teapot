import assert from "node:assert/strict";
import test from "node:test";
import { themeWant } from "../frontend/lib/theme-store.ts";

const base = { preview: null, auto: false, prefersLight: false, dark: "ct-dark", light: "ct-light", fixed: "ct-dark" };

test("a preview beats the system slot, because the preview is what you are looking at", () => {
  /**
   * With "follow the system" on, clicking a card shows it immediately — that is the preview. It has to beat
   * the slot the system picked, or the page paints the clicked theme while the appearance editor keeps
   * describing the system's one. Reported: "プレビュー適用は最後に選択したテーマなのに、color edit/wallpaperは
   * それじゃなくてシステムテーマ側のが出てる". MEASURED in Firefox (auto on, system dark, then clicking the
   * light card): page painted ct-light, background picker showed ct-dark's wallpaper; now both ct-light.
   */
  assert.equal(themeWant({ ...base, auto: true, preview: "ct-light" }), "ct-light");
  assert.equal(themeWant({ ...base, auto: true, prefersLight: true, preview: "ct-dark" }), "ct-dark");
  // and with auto off the preview still wins — it is a preview, not a slot
  assert.equal(themeWant({ ...base, preview: "ct-light" }), "ct-light");
});

test("follow the system picks the slot for the current appearance", () => {
  assert.equal(themeWant({ ...base, auto: true, prefersLight: true }), "ct-light");
  assert.equal(themeWant({ ...base, auto: true, prefersLight: false }), "ct-dark");
  // a light preference never falls through to the dark slot, and vice versa
  assert.equal(themeWant({ ...base, auto: true, prefersLight: true, fixed: "ct-dark" }), "ct-light");
});

test("without auto the fixed choice is the theme", () => {
  assert.equal(themeWant({ ...base, auto: false, fixed: "ct-light" }), "ct-light");
});
