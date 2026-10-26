import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLabel, agentLabelWithId } from "../frontend/lib/agent-label.ts";
test("the label prefers the session title and falls back to the slug (#ux)", () => {
  assert.equal(agentLabel({ id: "tyb2-9", sessionTitle: "オーディオの問題" }), "オーディオの問題");
  assert.equal(agentLabel({ id: "tyb2-9" }), "tyb2-9", "a session with no prompt yet still needs a name");
  assert.equal(agentLabel({ id: "tyb2-9", sessionTitle: "   " }), "tyb2-9", "whitespace is not a title");
  assert.equal(agentLabel(null), "");
});

test("the slug is added only when the title replaced it (#ux)", () => {
  assert.equal(agentLabelWithId({ id: "a", sessionTitle: "T" }), "T — a");
  assert.equal(agentLabelWithId({ id: "a" }), "a", "repeating the id as its own qualifier is noise");
  assert.equal(agentLabelWithId({ id: "a", sessionTitle: "T" }, "br0"), "T — a — br0");
});
