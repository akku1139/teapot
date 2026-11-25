/**
 * A decision's header is ONE line the same height as a tool's, and its label ends in an ellipsis.
 *
 * Reported: "decisionのラインが謎に数px太いんだけどバグっぽい? `text-overflow: ellipsis;` もついてないし (たぶんbashだけに当たってる
 * のでツールカード自体のcssに当てるべき)".
 *
 * MEASURED against the built stylesheet in headless Firefox, a decision summary stood 21.85px against a tool summary's 18px, and
 * the label was cut off with no ellipsis at all. Two causes, both visible only as geometry:
 *
 *   1. the decision BODY margin (`.embed.decision .content`) also matched the HEADER label, which carries `class="content
 *      inline-md"` — a descendant selector cannot tell a flex item inside `summary` from prose below it;
 *   2. the label is built by the markdown renderer, so its text arrives inside a child `<p>`. `text-overflow` clips the INLINE
 *      content of the box that declares it, and a child block is not that box's inline content — the label was silently cut.
 *
 * After both: 18px, the same as a tool header. A stylesheet is the one legitimate source read in this repo (happy-dom does no
 * layout), and this is a CSS CONTRACT — the rendered requirement cannot be stated any other way.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

function ruleBody(selector: string): string {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `no rule for ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

test("the decision body's margin is a CHILD rule, so it cannot reach the header label", () => {
  const body = ruleBody(".embed.decision > .content {");
  assert.match(body, /margin-top/, "this rule exists to space the body under the header");
  assert.ok(
    !css.includes(".embed.decision .content {"),
    "a descendant selector here also matches the label, which carries .content — that is the 3.85px",
  );
});

test("a markdown label's rendered children are INLINE, or the ellipsis cannot apply", () => {
  const body = ruleBody(".embed summary .inline-md > *,");
  assert.match(body, /display:\s*inline/, "a child <p> is a block box, and text-overflow does not reach into one");
  assert.match(body, /margin:\s*0/, "a rendered paragraph carries margins that would fatten the line it sits in");
});

test("a header label takes the header's line-height, not prose's", () => {
  const body = ruleBody(".embed summary .inline-md {");
  assert.match(
    body,
    /line-height:\s*inherit/,
    ".content sets 1.45 for body prose; on a 13px label that is 18.85px against a tool header's 18px",
  );
});

test("the label inside a summary is still the only part allowed to shrink", () => {
  const body = ruleBody(".embed summary > b,\n.embed summary > .meta {");
  assert.match(body, /min-width:\s*0/, "without this the label refuses to shrink and pushes the row wider");
  assert.match(body, /text-overflow:\s*ellipsis/);
  assert.match(body, /white-space:\s*nowrap/, "text-overflow applies to a single line only");
});
