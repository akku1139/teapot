import { test } from "node:test";
import assert from "node:assert/strict";
import { stripSourceComments, readSource } from "./helpers/source.ts";

/**
 * Appearance is a DRAFT until Save, and no theme slot may be lost on the way.
 *
 * Two reports, one root cause:
 *
 *   "follow the systemの時にシステムテーマとは逆側のテーマをクリックしても何も起きない"
 *   "save settingsボタンがあるのにテーマはsaveしなくても適用確定してるから設定の操作に一貫性が無い"
 *
 * `pickThemeCard` called `props.theme.setLight(id)`, which was the bare Solid setter — it changed a
 * signal and wrote nothing. MEASURED: clicking a light card with the OS dark left the painted theme
 * `dark` and `teapot.theme.light` unset, so the click was invisible AND unpersisted.
 *
 * Fixing that by making the setters persist would then make the PREVIEW a commit, which is the
 * second half of the complaint. So the two jobs are separated:
 *
 *   setAuto/setDark/setLight/setActive → paint only (preview)
 *   commitAppearance                    → localStorage (save)
 *   revertAppearance                    → restore the stored state (close without saving)
 */
test("appearance setters are PREVIEW-only; storage belongs to commitAppearance (#theme)", async () => {
  const app = stripSourceComments(readSource("frontend/App.tsx"));
  const at = app.indexOf("setDark: ");
  assert.ok(at > 0, "the theme control object must exist");
  const block = app.slice(at, at + 2600);

  // the preview setters must not write storage — otherwise clicking a card commits it.
  // Matched to the END of the assignment (the next `\n          ` at the same indent) so a
  // multi-line arrow body is covered too; a one-line regex missed exactly that shape.
  for (const name of ["setDark", "setLight", "setActive"]) {
    // the assignment runs until the NEXT sibling key (or the commit block)
    const start = block.indexOf(`${name}: `);
    assert.ok(start >= 0, `${name} must be present`);
    const rest = block.slice(start);
    const next = rest.slice(1).search(/\n\s+(light|setLight|setThemes|setActive|commitAppearance):/);
    const body = next === -1 ? rest : rest.slice(0, next + 1);
    assert.ok(
      !/localStorage/.test(body),
      `${name} must NOT write localStorage — a preview that stores is a commit, which is the ` +
        `"saveしなくても適用確定してる" report (#theme)`,
    );
  }
  // and the commit path must exist and write all four slots
  assert.match(
    block,
    /commitAppearance:/,
    "a commit path is what the save button calls (#theme)",
  );
  const commit = block.slice(block.indexOf("commitAppearance:"));
  for (const key of ["teapot.theme.auto", "teapot.theme.dark", "teapot.theme.light", '"teapot.theme"']) {
    assert.ok(commit.includes(key), `commitAppearance must persist ${key} (#theme)`);
  }
});

test("the settings dialog previews, commits on save, and reverts on close (#theme)", async () => {
  const src = stripSourceComments(readSource("frontend/components/ConfigModal.tsx"));
  // a draft captured from STORAGE at open, so a discard restores what was stored
  assert.match(
    src,
    /const storedAppearance = \{/,
    "the stored appearance must be captured once, or a discard restores the preview (#theme)",
  );
  assert.match(src, /props\.theme\.commitAppearance\(draftOf\(\)\)/, "save must commit the draft");
  assert.match(
    src,
    /revertAppearance\(\)/,
    "closing must revert — otherwise an unsaved preview silently becomes the state (#theme)",
  );
});

test("following the system marks BOTH slots, and the last click previews (#theme)", async () => {
  /**
   * "follow systemの時はdarkとlightでそれぞれ選択中のやつに枠が出て、最後に押したテーマが
   * プレビューされるべきなのに前バージョンから変わってない".
   *
   * Two separate misses:
   *
   *   1. only `paintedIdFor()` was marked — the slot the OS is IN — so the other choice was
   *      invisible without flipping the system setting;
   *   2. the painter resolved `want` from that same OS slot, so clicking a LIGHT card while the OS
   *      is dark asked for the dark slot and nothing changed. Measured: painted stayed `dark`.
   */
  const modal = stripSourceComments(readSource("frontend/components/ConfigModal.tsx"));
  const chosen = modal.slice(modal.indexOf("const themeCardChosen"));
  assert.match(
    chosen.slice(0, 500),
    /id === props\.theme\.dark\(\) \|\| id === props\.theme\.light\(\)/,
    "following the system, BOTH slot choices carry a frame — marking only the painted one hides " +
      "the other choice entirely (#theme)",
  );

  const app = stripSourceComments(readSource("frontend/App.tsx"));
  // the PAINTER (not the background-image helper) must honour the preview override
  const paintAt = app.indexOf("document.documentElement.dataset.theme = active");
  assert.ok(paintAt > 0, "the painter must exist");
  const before = app.slice(Math.max(0, paintAt - 2600), paintAt);
  assert.match(
    before,
    /previewTheme\(\)/,
    "the painter must read the preview override — otherwise a light card clicked while the OS is " +
      "dark cannot be previewed, because slot resolution asks for the dark slot (#theme)",
  );
  assert.match(
    before,
    /previewId \?\?/,
    "and the override must WIN over slot resolution (#theme)",
  );
});
