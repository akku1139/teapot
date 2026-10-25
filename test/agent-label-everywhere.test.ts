import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLabel, agentLabelWithId } from "../frontend/lib/agent-label.ts";
import { readSource, stripSourceComments } from "./helpers/source.ts";

/**
 * An agent is called the same thing in the header, the tab, and the left panel.
 *
 * Reported: "`<title>` と上部バーのチャットタイトルが左パネルのタイトルじゃなくて、チャットのslugに
 * なってる". The panel preferred `sessionTitle` ("オーディオの問題は…") while the header and
 * `document.title` printed the raw id (`tyb2-9`) — a slug the operator never typed. Three places
 * naming the same thing, with two rules.
 */
test("the label prefers the session title and falls back to the slug (#ux)", () => {
  assert.equal(agentLabel({ id: "tyb2-9", sessionTitle: "オーディオの問題" }), "オーディオの問題");
  assert.equal(agentLabel({ id: "tyb2-9" }), "tyb2-9", "a session with no prompt yet still needs a name");
  assert.equal(agentLabel({ id: "tyb2-9", sessionTitle: "   " }), "tyb2-9", "whitespace is not a title");
  assert.equal(agentLabel(null), "");
});

test("the slug is added only when the title replaced it (#ux)", () => {
  // where the id must stay matchable (tooltips, the tab), and only when it is not already the label
  assert.equal(agentLabelWithId({ id: "a", sessionTitle: "T" }), "T — a");
  assert.equal(agentLabelWithId({ id: "a" }), "a", "repeating the id as its own qualifier is noise");
  assert.equal(agentLabelWithId({ id: "a", sessionTitle: "T" }, "br0"), "T — a — br0");
});

test("all three surfaces go through the shared label (#ux)", () => {
  const app = stripSourceComments(readSource("frontend/App.tsx"));
  // the header
  assert.match(app, /<span class="title"[^>]*>\{agentLabel\(sel\(\)\)\}/, "the header uses the label");
  // the tab title
  // the tab title: `base` is built from the same label, and document.title uses `base`
  const baseAt = app.indexOf("const base = a");
  assert.ok(baseAt > 0, "the tab title's text must be built somewhere");
  assert.match(app.slice(baseAt, baseAt + 300), /agentLabel\(/, "the tab uses the label");
  assert.match(app.slice(baseAt, baseAt + 500), /document\.title =/, "and that is what document.title shows");
  // a fourth surface cannot pick a different rule
  assert.doesNotMatch(
    app,
    /<span class="title">\{sel\(\)!\.id\}/,
    "printing the raw slug in the header is the reported bug (#ux)",
  );
});
