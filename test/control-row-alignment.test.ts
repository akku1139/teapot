/**
 * A row of controls aligns on the CENTRE, and `.iconbtn` must not decide that for its parent.
 *
 * Reported: "new agent ウィンドウで go と ↑ の縦位置がズレてて謎". MEASURED against the built stylesheet in headless Firefox: `go`
 * at top 37px, `↑` at top 44px, in one row whose input is 33px tall — a 7px drop, and only on the icon button.
 *
 * The cause was `align-self: flex-end` on `.iconbtn`, added for the maximized composer (#44) where a `stretch` parent pulled the
 * button into a tall strip. `flex-end` cannot stretch either, so `center` fixes #44 just as well — and the composer, which is
 * the case that actually wanted bottom alignment, sets `align-items: flex-end` on `.composer form` itself.
 *
 * A stylesheet is the one legitimate source read here (happy-dom does no layout), and this is a CSS CONTRACT: the rendered
 * requirement cannot be stated any other way.
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

test("the icon button centres itself, so it cannot drop to the bottom of a taller row", () => {
  const body = ruleBody(".iconbtn {");
  assert.match(body, /align-self:\s*center/, "flex-end is what put `↑` 7px below `go`");
  assert.ok(!/align-self:\s*flex-end/.test(body), "the composer sets its own alignment and does not need this");
});

test("a control ROW centres its items", () => {
  const body = ruleBody(".ctlrow {");
  assert.match(body, /display:\s*flex/);
  assert.match(body, /align-items:\s*center/, "a flex row defaults to stretch, which leaves a short button looking sunk");
});

test("the composer's icon buttons sit on its BOTTOM line, however many lines the prompt grows to", () => {
  /**
   * MEASURED in headless Firefox with a four-line draft: `send` at bottom 655, `⤢` and `📎` at 655 as well, once this rule
   * exists — before it they were centred against a 24px taller box. `.iconbtn`'s own `center` is right for an ordinary row,
   * so the composer states the exception in one place instead of every button opting in.
   */
  const body = ruleBody(".composer form .iconbtn {");
  assert.match(
    body,
    /align-self:\s*flex-end/,
    "a centred attach button floats up beside the last line while `send` stays down",
  );
});

test("the composer keeps the bottom alignment it was written for (#44)", () => {
  const body = ruleBody(".composer form {");
  assert.match(
    body,
    /align-items:\s*flex-end/,
    "the tall-composer case is the container's to declare, not every icon button's",
  );
});
