/**
 * HOVER AND ACTIVE MUST USE DIFFERENT VISUAL CHANNELS.
 *
 * With a wallpaper, buttons are outlines (transparent fill, thin border) so a dense toolbar reads
 * as controls over the photo rather than as a row of solid tiles. That change erased the only
 * signal some buttons had: `.iconbtn.active` (the right-panel toggle) and `.goalstate.on.*` (the
 * goal controls) were FILLED.
 *
 * The first repair gave "active" a tinted background and the operator rejected it —
 * "hoverでも背景色がつくからアクティブに背景色付けるのはちょっと微妙かも?" — because hover already
 * fills, so hover and active would share one channel with two meanings.
 *
 * The contract therefore is:
 *   - ACTIVE is a coloured border plus an inset RING, keeping a transparent background;
 *   - HOVER is a faint fill, and must not repaint an engaged control.
 *
 * Asserted on declarations rather than pixels because the suite has no browser, and because this is
 * a design contract: the values may be retuned, the channels may not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource, stripSourceComments } from "./helpers/source.ts";
import { cssRuleBodies } from "./helpers/css.ts";

/** the declarations of a property within one rule body, as a raw string */
function decl(body: string, prop: string): string | null {
  const m = body.match(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "i"));
  return m ? m[1]!.trim() : null;
}

/** every rule whose selector mentions all of `needles`, as [selector, body] */
function rulesMatching(css: string, needles: readonly string[]): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  // a deliberately simple scanner: app.css has no nested braces inside declarations
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1]!.trim();
    if (needles.every((n) => new RegExp(n).test(selector))) out.push({ selector, body: m[2]! });
  }
  return out;
}

test("an ENGAGED outline button is a RING, never a fill (#ui)", async () => {
  const css = stripSourceComments(readSource("frontend/app.css"));
  const engaged = rulesMatching(css, ["data-bg-image", "\\.active|on\\.done|on\\.paused"]);
  assert.ok(
    engaged.length > 0,
    "there must be a wallpaper-specific rule for the engaged state, or a transparent outline " +
      "button has no way to show that it is engaged (#ui)",
  );
  const ringed = engaged.filter((r) => /inset/.test(decl(r.body, "box-shadow") ?? ""));
  assert.ok(
    ringed.length > 0,
    "the engaged state must draw a RING (an inset box-shadow) — a channel hover does not use. " +
      "A tinted fill was tried and rejected because hover already fills (#ui)",
  );
  for (const r of ringed) {
    assert.equal(
      decl(r.body, "background-color"),
      "transparent",
      `"${r.selector.trim()}" must keep a transparent background: a tinted fill is exactly what ` +
        `the operator rejected (#ui)`,
    );
  }
});

test("hover does not repaint an engaged control (#ui)", async () => {
  const css = stripSourceComments(readSource("frontend/app.css"));
  const hoveredEngaged = rulesMatching(css, ["data-bg-image", ":hover", "\\.active|goalstate\\.on"]);
  assert.ok(
    hoveredEngaged.length > 0,
    "an engaged+hovered control needs its own rule, or it inherits the hover fill and the two " +
      "states become indistinguishable (#ui)",
  );
  for (const r of hoveredEngaged) {
    assert.equal(
      decl(r.body, "background-color"),
      "transparent",
      `"${r.selector.trim()}" must neutralise the hover fill (#ui)`,
    );
  }
});

test("the unselected theme card carries no visible border (#ui)", async () => {
  /**
   * Reported: "themesの各テーマの外側に四角いボーダーがついてる (選択中のおボーダーではない)のでちょっと
   * ダサい". Every tile had `1px solid var(--line)` at rest, so the grid read as a wall of boxes; the
   * preview's own colours already give the tile its edge.
   */
  const css = stripSourceComments(readSource("frontend/app.css"));
  const body = cssRuleBodies(css, ".themecard-preview")[0];
  assert.ok(body, "the theme preview needs a base rule");
  const border = decl(body!, "border");
  assert.ok(
    border !== null && /transparent/.test(border),
    `the resting card border must be transparent so only the SELECTED tile shows a ring; got ` +
      `border: ${String(border)} (#ui)`,
  );
  // and selecting one must still be visible
  const on = rulesMatching(css, ["\\.themecard\\.on", "themecard-preview"]);
  assert.ok(
    on.some((r) => /var\\(--acc\\)/.test(decl(r.body, "border-color") ?? "") || /inset|0 0 0/.test(decl(r.body, "box-shadow") ?? "")),
    "the selected card must still be marked, or removing the resting border removed the only cue (#ui)",
  );
});
