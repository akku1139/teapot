/**
 * #124 — "the Tasks markdown view and the edit view have different default
 * heights. It is hard to read as a result."
 *
 * `TodoEditor` renders one of two things behind the same toggle:
 *
 *   view   -> `<div class="content mdpreview" style="max-height:40vh;…">`
 *   edit   -> `<textarea class="mono" rows={5} style="…">`
 *
 * So the two defaults were unrelated: a viewport-relative cap on one side, five
 * intrinsic rows on the other. On a tall window the preview started far larger
 * than the editor it replaced, and toggling between them resized the panel — the
 * jump read as a layout fault rather than a view change.
 *
 * ## The fix, and why it is a class
 *
 * Both take their box from `.todopane` / `.todopane-edit`, which share one
 * height block. A class rather than two matching inline styles, because two
 * inline styles are exactly what drifted.
 *
 * The editor's styling moved from its inline `style` attribute into the sheet,
 * so this also asserts nothing was lost in the move — the earlier version of this
 * change silently dropped `width`, `background`, `border`, `color` and `resize`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

/**
 * The declarations that apply to `selector`.
 *
 * The shared height block is written as a two-selector rule
 * (`.todopane,\n.todopane-edit { … }`), so a lookup for `.todopane-edit {`
 * alone finds nothing. Walk BACK from the selector to the rule's opening brace
 * and take everything up to its close, which covers both shapes.
 */
function rule(selector: string): string {
  const at = css.indexOf(selector);
  if (at === -1) return "";
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

/** every declaration block that mentions the selector, concatenated */
function allRules(selector: string): string {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(selector, from);
    if (at === -1) break;
    const open = css.indexOf("{", at);
    if (open === -1) break;
    const close = css.indexOf("}", open);
    out.push(css.slice(open + 1, close));
    from = close;
  }
  return out.join("\n");
}

test("both views take their height from the shared classes (#124)", () => {
  const view = allRules(".todopane");
  const edit = allRules(".todopane-edit");
  assert.ok(view, "the preview must have a rule (#124)");
  assert.ok(edit, "the editor must have a rule (#124)");
  for (const [name, body] of [["view", view], ["edit", edit]] as const) {
    assert.match(body, /height:\s*11\.5em/, `${name} must pin a height (#124)`);
    assert.match(body, /max-height:\s*40vh/, `${name} must stay capped (#124)`);
    assert.match(body, /overflow-y:\s*auto/, `${name} must scroll rather than grow (#124)`);
    assert.match(body, /box-sizing:\s*border-box/, `${name} so the height means the same thing (#124)`);
  }
});

test("the two heights are identical, so toggling cannot jump (#124)", () => {
  const height = (body: string) => /height:\s*([^;]+);/.exec(body)?.[1]?.trim();
  assert.equal(
    height(allRules(".todopane")),
    height(allRules(".todopane-edit")),
    "both views must resolve to the SAME height (#124)",
  );
});

test("the preview no longer carries an inline height (#124)", () => {
  // an inline style wins over the sheet, so leaving it would defeat the class
  assert.match(
    app,
    /class="content mdpreview todopane"/,
    "the preview must take its box from the class (#124)",
  );
  assert.doesNotMatch(
    app,
    /mdpreview[^>]*style="[^"]*max-height/,
    "and must not still carry an inline max-height (#124)",
  );
});

test("the editor keeps the styling its inline style used to carry (#124)", () => {
  // the move to the sheet must not drop anything — an earlier version of this
  // change lost width, background, border, color and resize, which the build
  // and the smoke test both reported as green
  const body = allRules(".todopane-edit");
  for (const [prop, why] of [
    ["width:\\s*100%", "fill the panel"],
    ["background:\\s*var\\(--bg-darkest\\)", "match the preview"],
    ["border:\\s*none", "no default border"],
    ["color:\\s*var\\(--fg\\)", "readable text"],
    ["font-family:", "monospace, as the class asked for"],
    ["font-size:", "at the stated size"],
    ["resize:\\s*vertical", "still user-resizable"],
    ["padding:", "not flush to the edge"],
  ] as const) {
    assert.match(body, new RegExp(prop), `the editor lost ${prop} (${why}) (#124)`);
  }
});

test("the editor no longer carries an inline style (#124)", () => {
  const i = app.indexOf('id="todo-input"');
  assert.notEqual(i, -1, "the editor must exist (#124)");
  const tag = app.slice(i, app.indexOf("/>", i));
  assert.doesNotMatch(
    tag,
    /\sstyle="/,
    `the editor must take its styling from the sheet (#124); still inline: ${tag.slice(0, 200)}`,
  );
});

test("rows={5} stays as the intrinsic minimum (#124)", () => {
  // the CSS pins the rendered height; rows is the attribute default for anyone
  // who copies the markup, so removing it would be a silent downgrade
  const i = app.indexOf('id="todo-input"');
  assert.match(app.slice(i, app.indexOf("/>", i)), /rows=\{5\}/, "rows must remain (#124)");
});