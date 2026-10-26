import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const at = css.indexOf(selector);
  if (at === -1) return "";
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

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

test("the editor keeps the styling its inline style used to carry (#124)", () => {
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
