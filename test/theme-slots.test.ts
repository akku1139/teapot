/**
 * A THEME SELECTION MUST LAND IN THE SLOT THE PAINTER READS.
 *
 * "follow the system を入れてるときにテーマ複製したりするとやっぱりちょっと変な挙動になる / わかりに
 * にくいロジックエラーで説明難しいんだけど..."
 *
 * The difficulty in describing it was that nothing failed: the control responded and the card
 * highlighted, but the value written (`teapot.theme`) was the FIXED slot while the painter was
 * reading `teapot.theme.dark` / `.light`. So the copy existed, was saved, and was never painted.
 *
 * These cases pin the decision, because three call sites share it — a card click, the editor's
 * select, and "duplicate current" — and a disagreement between them is invisible until someone
 * compares the panel against the picture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { slotForSelection, paintedIdFor } from "../frontend/lib/theme-slots.ts";

test("not following the system, every selection goes to the ONE fixed slot (#theme-slots)", () => {
  assert.deepEqual(slotForSelection(false, "dark"), { slot: "fixed", key: "teapot.theme" });
  assert.deepEqual(
    slotForSelection(false, "light"),
    { slot: "fixed", key: "teapot.theme" },
    "with one slot, a light theme is still that slot — writing a light-specific key would be a " +
      "value the painter never reads while following nothing",
  );
});

test("following the system, a theme fills the slot for its OWN mode (#theme-slots)", () => {
  assert.deepEqual(
    slotForSelection(true, "dark"),
    { slot: "dark", key: "teapot.theme.dark" },
    "a dark theme must populate the dark slot",
  );
  assert.deepEqual(
    slotForSelection(true, "light"),
    { slot: "light", key: "teapot.theme.light" },
    "a light theme must populate the LIGHT slot even while the OS is dark — otherwise there is " +
      "no way to choose what the other appearance will show",
  );
});

test("the SLOT and the storage KEY never disagree (#theme-slots)", () => {
  // a mismatched pair (slot "light", key "teapot.theme.dark") would write one store and highlight
  // the other, which is the same class of bug this module exists to prevent
  for (const auto of [false, true]) {
    for (const mode of ["dark", "light"] as const) {
      const { slot, key } = slotForSelection(auto, mode);
      assert.ok(key.startsWith("teapot.theme"), `unexpected key ${key}`);
      if (slot === "fixed") assert.equal(key, "teapot.theme");
      else assert.equal(key, `teapot.theme.${slot}`, `slot ${slot} must write its own key, got ${key}`);
    }
  }
});

test("the card marked selected is the one actually PAINTED (#theme-slots)", () => {
  const base = { fixed: "preset-dark", dark: "mine-dark", light: "mine-light" };
  assert.equal(
    paintedIdFor({ ...base, auto: false, prefersLight: true }),
    "preset-dark",
    "not following the system, the OS preference is irrelevant — the fixed slot is what paints",
  );
  assert.equal(
    paintedIdFor({ ...base, auto: true, prefersLight: false }),
    "mine-dark",
    "following the system while the OS is dark, the DARK slot is on screen",
  );
  assert.equal(
    paintedIdFor({ ...base, auto: true, prefersLight: true }),
    "mine-light",
    "…and the LIGHT slot when the OS is light",
  );
});
