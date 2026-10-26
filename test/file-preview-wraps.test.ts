import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A file preview WRAPS; it never scrolls sideways.
 *
 * Reported as "右パネルfilesからファイルウィンドウの中が横スクロールする / 折り返しにしたほうがいい".
 * `happy-dom` does no layout, so the contract has to be stated as CSS — that is the one legitimate
 * stylesheet read in this repo. What is asserted is the set of declarations that TOGETHER stop the
 * scroll, because each one alone was measurably insufficient:
 *
 *   - `overflow-x: hidden` on the container stops the container scrolling;
 *   - `white-space: pre-wrap` on shiki's own `<pre>` is needed because shiki ships `pre`;
 *   - `display: block` + `min-width: 0` on `<code>` is what actually fixed it — MEASURED, the
 *     code element reported `clientWidth: 0` / `scrollWidth: 157` while BOTH ancestors were
 *     already at 0, because an inline element inside a wrapping `<pre>` has no box to wrap in.
 *
 * The last point is the one worth remembering: a stylesheet can look correct (the computed
 * `white-space` on `<code>` really was `pre-wrap`) and still scroll, because the missing piece was a
 * DISPLAY mode, not a wrap mode.
 */
const css = readFileSync("frontend/app.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** the body of a rule whose SELECTOR LIST contains `selector` (these rules are grouped) */
const rule = (selector: string): string => {
  const bodies: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = m[1]!.split(",").map((s) => s.trim());
    if (selectors.includes(selector)) bodies.push(m[2]!);
  }
  return bodies.join("\n");
};

test("the preview container does not scroll horizontally (#files)", () => {
  const body = rule(".filepreview");
  assert.ok(body, ".filepreview must have its own rule");
  assert.match(body, /overflow-x:\s*hidden/, "the container must not scroll sideways (#files)");
  assert.match(body, /overflow-y:\s*auto|overflow:\s*auto/, "but a long file must still scroll vertically");
});

test("shiki's own pre and code are told to wrap (#files)", () => {
  /**
   * shiki emits `<pre class="shiki">` with `white-space: pre` of its own, so a rule on the wrapper
   * does not reach it. The selector must NAME the inner elements.
   */
  const wrapped = [".shikiwrap .shiki pre", ".shikiwrap .shiki code"];
  for (const sel of wrapped) {
    const body = rule(sel);
    assert.ok(body, `${sel} must be styled, or shiki's own defaults win (#files)`);
    assert.match(body, /white-space:\s*pre-wrap/, `${sel} must wrap (#files)`);
  }
});

test("the code element is a BLOCK with min-width 0 — the reason it scrolled (#files)", () => {
  const body = rule(".shikiwrap .shiki code") + rule(".shikiwrap code.shiki");
  assert.match(body, /display:\s*block/, "an inline <code> has no box to wrap in — MEASURED clientWidth 0 (#files)");
  assert.match(body, /min-width:\s*0/, "and a flex/grid ancestor must be allowed to shrink it (#files)");
});

test("the code background is the THEME's surface, never shiki's white (#files)", () => {
  /**
   * Reported as "ファイルツリーからのコードプレビューでshikiが効いてると背景が真っ白".
   *
   * shiki runs in dual-theme mode (`shiki-themes github-light github-dark`), so its inline style
   * sets `--shiki-light-bg: #fff` on the `<pre>`. Only the LIGHT appearance had an explicit
   * override, so every DARK theme fell through to that white — a preview that blinded the operator
   * in a dark UI. A tool card never had the bug because `.toolbody` paints its own surface
   * underneath; the preview had none.
   *
   * The contract: the container carries the theme surface and shiki's own background is transparent,
   * for EVERY appearance rather than only one.
   */
  // the surface moved to the shared `.shikiwrap`, so a NEW shiki container is correct by
  // construction rather than by remembering to copy three selector lists
  /**
   * The rendered background must MATCH the no-shiki path, which is what "looks right" means here: a
   * plain file inherits the modal's own surface. So the wrapper paints nothing and only makes
   * shiki's inline background lose — MEASURED identical (both `rgba(0,0,0,0)`, radius 0) after this.
   */
  assert.doesNotMatch(rule(".shikiwrap"), /background\s*:/, "the wrapper must not paint a surface (#files)");
  assert.match(rule(".shikiwrap .shiki"), /background-color:\s*transparent/, "shiki's own background must lose (#files)");

  const shikiBg = [...css.matchAll(/([^{}]*\.shikiwrap[^{}]*\.shiki[^{}]*)\{([^}]*)\}/g)]
    .filter((m) => /background-color/.test(m[2]!))
    .map((m) => m[2]!)
    .join("\n");
  assert.match(shikiBg, /background-color:\s*transparent/, "shiki's own background must be transparent (#files)");
  assert.match(shikiBg, /!important/, "it is an inline style on the element, so the rule must win (#files)");
});
