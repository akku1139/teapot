/**
 * #107 — single-key shortcuts fire while the themes panel is open.
 *
 * The keydown handler guarded its shortcut block with `if (showNew() || showCfg())
 * return;`, but the Escape branch in the same handler handles FOUR overlays plus
 * the narrow drawer. The two lists had drifted, so with the themes panel open:
 *
 *   - `t` opened the terminal, and
 *   - `/` moved focus into the composer,
 *
 * both behind a visible overlay. The app mutated state under a panel the operator
 * could see but whose contents they were not interacting with.
 *
 * Settings IS covered by the guard, which is why a control case matters: without
 * one, "no shortcut fired" could just mean "no shortcut was pressed".
 *
 * The fix derives both from one predicate, so adding an overlay means editing one
 * list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

test("the shortcut guard covers every overlay Escape handles (#107)", () => {
  // the predicate must name all five, not the original two
  const at = app.indexOf("const anyOverlayOpen");
  assert.notEqual(at, -1, "the shared predicate must exist (#107)");
  const decl = app.slice(at, app.indexOf(";", at));
  for (const sig of ["showNew()", "showCfg()", "showThemes()", "editing()", "isNarrow()"]) {
    assert.ok(decl.includes(sig), `anyOverlayOpen must include ${sig} (#107)`);
  }
});

test("the shortcut block uses the shared predicate (#107)", () => {
  const at = app.indexOf("if (e.key === \"/\") {");
  assert.notEqual(at, -1, "the shortcut block must exist (#107)");
  const before = app.slice(Math.max(0, at - 400), at);
  assert.match(
    before,
    /if \(anyOverlayOpen\(\)\) return;/,
    "shortcuts must be gated on the SAME predicate Escape uses (#107)",
  );
  assert.doesNotMatch(
    before,
    /if \(showNew\(\) \|\| showCfg\(\)\) return;/,
    "the old narrow two-overlay guard must be gone (#107)",
  );
});

test("Escape still closes every overlay (#107)", () => {
  // the non-regression: sharing a predicate must not cost Escape anything
  const at = app.indexOf('if (e.key === "Escape") {');
  assert.notEqual(at, -1, "the Escape branch must exist (#107)");
  const block = app.slice(at, at + 900);
  for (const [sig, why] of [
    ["setShowNew(false)", "new-agent dialog"],
    ["setShowCfg(false)", "settings dialog"],
    ["setShowThemes(false)", "themes panel"],
    ["setEditing(null)", "message editor"],
    ["closeRight()", "narrow drawer"],
  ] as const) {
    assert.ok(block.includes(sig), `Escape must still close the ${why} (#107)`);
  }
});

test("the themes panel is a real overlay, not an inline decoration (#107)", () => {
  // if it stopped being a popover the guard entry would be wrong
  assert.match(app, /class="themepop"/, "the themes panel must still exist (#107)");
  assert.match(app, /<Show when=\{showThemes\(\)\}>/, "and be gated on its signal (#107)");
});
