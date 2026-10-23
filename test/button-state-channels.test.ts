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

test("an outline button still RESPONDS to hover (#ui)", async () => {
  /**
   * A regression, reported after the ring change: "前バージョンでは透明なボタンをhoverしたら半透明な
   * 背景色が出てたのに、今は出てない".
   *
   * The hover rule was deleted while the block around it was rewritten. Nothing failed — a button
   * with no hover state is simply unresponsive, which no test noticed. The shared `filter:
   * brightness()` cannot substitute: it brightens a FILL, and an outline button has none.
   */
  const css = stripSourceComments(readSource("frontend/app.css"));
  const hover = rulesMatching(css, ["data-bg-image", ":hover", "button"]);
  assert.ok(
    hover.length > 0,
    "a transparent button needs a wallpaper hover rule, or it gives no feedback at all (#ui)",
  );
  assert.ok(
    hover.some((r) => /color-mix|rgba|var\\(--acc\\)/.test(decl(r.body, "background-color") ?? "")),
    `the hover rule must actually paint a translucent background; the shared brightness() filter ` +
      `does nothing without a fill (#ui)`,
  );
});

test("buttons that are PRIMARY actions keep their fill by class, not inline style (#ui)", async () => {
  /**
   * "save goal、save tasks が何故か塗りつぶしボタンになってるのでコンポーネントが適切に切られてない?"
   *
   * They WERE meant to be filled — they are the primary action. What was wrong is that the fill
   * came from an inline `style="background:…"`, which outranks every stylesheet rule, so those
   * buttons could never be reasoned about (and a reader could not tell a deliberate fill from a
   * missed exclusion).
   */
  const app = readSource("frontend/App.tsx");
  const inlineAccent =
    /style="[^"]*background:\s*var\(--(acc|ok)\)[^"]*border:\s*none[^"]*"/.test(app);
  assert.ok(
    !inlineAccent,
    "an accent-filled button must use a class (.primarybtn/.okbtn/.savebtn), not an inline style " +
      "that no stylesheet rule can override (#ui)",
  );
  const css = stripSourceComments(readSource("frontend/app.css"));
  for (const cls of [".primarybtn", ".okbtn"]) {
    const bodies = cssRuleBodies(css, cls);
    assert.ok(bodies.length, `${cls} must exist, or its buttons fall back to the outline treatment`);
    // the FILLED rule is the base one; the wallpaper rule that also matches this selector is the
    // outline override, so search rather than assuming order
    assert.ok(
      bodies.some((b) => /background:\s*var\(--(acc|ok)\)/.test(b)),
      `${cls} must be filled when there is no wallpaper`,
    );
  }
  /**
   * The wallpaper outline must be GLOBAL BY TAG, not a list of class names.
   *
   * Two designs were tried and both failed for the same reason — they were lists of names:
   *
   *   1. `button:not(.copybtn):not(.qopt)…` ("every button except these") gave `.editbtn` a hard
   *      1px rectangle it never asked for: "角丸でも何でも無い枠線が出てる".
   *   2. An allowlist of `.iconbtn`/`.primarybtn`/… reached neither, because `send` and `apply` are
   *      BARE `<button type="submit">` with no class at all — "apply, sendボタンも背景色がある (という
   *      かボタンのコンポーネント作ってない、もしくはグローバルにタグに当てるCSSは無いの?)".
   *
   * The answer to that question is yes: the rule keys on the TAG, and the exceptions are listed.
   * So what is asserted is that a rule matching a plain `button` with no class exists.
   */
  const outlineRules = rulesMatching(css, ["data-bg-image", "button"]);
  assert.ok(outlineRules.length > 0, "there must be wallpaper button rules at all");
  assert.ok(
    outlineRules.some((r) => /button(:where\(|:not\(|\s*\{|,\s*$|\s+)/.test(r.selector) && !/button\./.test(r.selector)),
    "a bare `<button>` (no class) must get the outline treatment — keying on class names leaves " +
      "every class-less submit button filled (#ui)",
  );
});

test("the ACTION buttons are outlines over a wallpaper too (#ui)", async () => {
  /**
   * Reported as a regression in v0.36.7: "透明なテーマのときにstart/stop, (model) apply, save
   * goal/task, send (prompt)あたりのボタンが前はボーダーだけ色を付けるようにしてたはずなのに、今は
   * 塗りつぶされてる".
   *
   * They were excluded from the outline treatment on the reasoning that a primary action "must
   * outrank the rest". That reasoning is wrong over a wallpaper: a filled chip IS the solid tile the
   * outline treatment exists to remove, and these are the buttons an operator looks at most. The
   * hierarchy is carried by the accent border and text instead.
   */
  const css = stripSourceComments(readSource("frontend/app.css"));
  const rules = rulesMatching(css, ["data-bg-image", "button\\.(primarybtn|okbtn|savebtn|runbtn)"]);
  assert.ok(
    rules.length > 0,
    "the action buttons need a wallpaper rule — without one they keep their solid fill (#ui)",
  );
  for (const cls of ["primarybtn", "okbtn", "savebtn", "runbtn"]) {
    const rule = rules.find((r) => new RegExp(`button\\.${cls}\\b`).test(r.selector));
    assert.ok(rule, `.${cls} must be covered by the outline treatment (#ui)`);
    assert.equal(
      decl(rule!.body, "background-color"),
      "transparent",
      `.${cls} must be transparent over a wallpaper, not a filled chip (#ui)`,
    );
    assert.ok(
      /1px solid/.test(decl(rule!.body, "border") ?? ""),
      `.${cls} must be marked by a border once it has no fill (#ui)`,
    );
  }
});

test("a state rule must not LOSE to the base outline rule's :not() chain (#ui)", async () => {
  /**
   * The failure this pins, measured on the running app: a `runbtn danger` element computed
   * `border-color: rgb(127,139,156)` and `color: rgb(230,232,238)` — i.e. the generic outline rule
   * beat the rule written specifically for `.danger`, so the stop button stayed a grey outline
   * while `.chan-head .runbtn.danger { background: var(--err) }` still painted it solid red.
   *
   * Why: `:not()` contributes its ARGUMENT's specificity. A base rule of
   * `button:not(.a):not(.b):not(.c)` scores (0,4,2), which outranks any plausible state selector.
   * `:where()` contributes ZERO, so the base stays weak and state rules win on merit.
   */
  const css = stripSourceComments(readSource("frontend/app.css"));
  const base = rulesMatching(css, ["data-bg-image", "button"]);
  /**
   * A `:not()` is only harmful OUTSIDE `:where()`, and a selector can legitimately contain both
   * (the exceptions wrapped, the `:disabled` guard also wrapped). So strip every `:where(…)` group
   * first — balanced-paren walk, because `:where(:not(a, b))` nests — and only then look for a
   * remaining `:not(`.
   */
  const withoutWhere = (sel: string): string => {
    let out = "";
    let i = 0;
    while (i < sel.length) {
      const at = sel.indexOf(":where(", i);
      if (at === -1) {
        out += sel.slice(i);
        break;
      }
      out += sel.slice(i, at);
      let depth = 0;
      let j = at + ":where".length;
      for (; j < sel.length; j++) {
        if (sel[j] === "(") depth++;
        else if (sel[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      i = j + 1;
    }
    return out;
  };
  /**
   * Only rules that are not themselves STATE rules can be "lost to": a `:hover`/`.active` selector
   * is the top of the cascade, so its `:not(:disabled)` guard cannot outrank anything that matters.
   * The dangerous case is the BASE rule, which every other rule has to beat.
   */
  const isStateRule = (sel: string) =>
    /:hover|\.active|\.done|\.paused|\.danger|\.(primarybtn|okbtn|savebtn|runbtn|goalstate)\b/.test(sel);
  const withNotChain = base.filter((r) => !isStateRule(r.selector) && withoutWhere(r.selector).includes(":not("));
  assert.deepEqual(
    withNotChain.map((r) => r.selector.trim()),
    [],
    "a wallpaper button rule must not use a bare :not() chain — it scores higher than the state " +
      "rules it is supposed to lose to. Wrap the exceptions in :where() instead (#ui)",
  );
  assert.ok(
    base.some((r) => /button:where\(/.test(r.selector)),
    "the base outline rule must use :where() so state rules can override it (#ui)",
  );
  const danger = rulesMatching(css, ["data-bg-image", "runbtn\\.danger"]);
  assert.ok(danger.length > 0, "the stop state needs its own rule (#ui)");
  assert.ok(
    danger.some((r) => /var\(--err\)/.test(decl(r.body, "border") ?? "")),
    "stop must be marked by a red BORDER, not a red fill (#ui)",
  );
  // the RESTING rule must not fill; a hover tint is fine and is checked elsewhere
  for (const r of danger.filter((x) => !/:hover/.test(x.selector))) {
    assert.match(
      String(decl(r.body, "background")),
      /transparent/,
      `"${r.selector.trim()}" must not paint a fill — a full red rectangle is what was reported (#ui)`,
    );
  }
});

test("a state button keeps ITS OWN colour on hover (#ui)", async () => {
  /**
   * Reported: "背景画像のあるテーマでsave tasks (緑色)をhoverするとなぜか青色になる" — and the three
   * goal controls did it too.
   *
   * The generic hover rule set `border-color: var(--acc)` and `color: var(--acc)` on every outlined
   * button. `.okbtn`/`.savebtn`/`.goalstate` declare their colour EARLIER, so the generic rule won
   * on order and any state colour vanished under the pointer. A colour that only holds when the
   * cursor is elsewhere is not a state colour.
   *
   * So: the generic hover must EXCLUDE the buttons that carry a state colour, and each of them must
   * get its own hover whose tint follows `currentColor`.
   */
  const css = stripSourceComments(readSource("frontend/app.css"));
  const hovers = rulesMatching(css, ["data-bg-image", ":hover"]);
  const generic = hovers.find((r) => /button:where\(/.test(r.selector) && !/currentColor/.test(r.body));
  assert.ok(generic, "the generic outline hover must exist");
  for (const cls of ["primarybtn", "okbtn", "savebtn", "runbtn", "goalstate"]) {
    assert.ok(
      new RegExp(`\\.${cls}\\b`).test(generic!.selector),
      `the generic hover must EXCLUDE .${cls} — otherwise it repaints that button accent-blue ` +
        `under the pointer and its own colour is only visible when the cursor is elsewhere (#ui)`,
    );
  }
  // and each state button has a hover of its own that tints with its own colour
  for (const cls of ["okbtn", "savebtn", "goalstate"]) {
    const own = hovers.find(
      (r) => new RegExp(`button\\.${cls}:hover`).test(r.selector) && /currentColor/.test(r.body),
    );
    assert.ok(
      own,
      `.${cls} needs its own hover using currentColor, or it has no hover feedback once excluded (#ui)`,
    );
  }
});

test("every settings section keeps a LEGEND with text (#ui)", async () => {
  /**
   * The API password was moved from "live update" to "runtime" by editing around it, and the
   * replacement swallowed the runtime `<legend>agent runtime</legend>` — leaving a bare `<legend>`
   * that closed the element early. TypeScript accepted it (the JSX still balanced once the label
   * landed elsewhere), so nothing caught it until the section rendered with a missing heading.
   *
   * A section with no heading is not a cosmetic problem: the panel is a list of collapsed
   * fieldsets, and the legend is the only thing that says which one you are in.
   */
  const src = (await import("./helpers/source.ts")).readSource("frontend/components/ConfigModal.tsx");
  const fieldsets = src.split("<fieldset").slice(1);
  assert.ok(fieldsets.length >= 5, `expected several sections, found ${fieldsets.length}`);
  for (const f of fieldsets) {
    const hidden = /section\(\) !== "([a-z]+)"/.exec(f);
    const legend = /<legend>([\s\S]*?)<\/legend>/.exec(f);
    assert.ok(legend, `the "${hidden?.[1] ?? "?"}" section has no legend — its heading is gone`);
    const text = legend![1]!.replace(/\{[^}]*\}/g, "").replace(/<[^>]*>/g, "").trim();
    assert.ok(
      text.length > 0,
      `the "${hidden?.[1] ?? "?"}" section's legend is EMPTY — the label was lost in an edit`,
    );
  }
});
