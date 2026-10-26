import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("echoes are filed under the prompted agent's session, never the viewed timeline (#87)", () => {
  const app = readFileSync("frontend/App.tsx", "utf8");

  const sendAt = app.indexOf("const sendText = async");
  assert.ok(sendAt > 0, "sendText must exist");
  const sendBlock = app.slice(sendAt, app.indexOf("} catch", sendAt));
  assert.match(sendBlock, /const echoKey = agents\(\)\.find\(\(a\) => a\.id === id\)\?\.session/, "the echo key must be derived from the prompted agent's session");
  assert.match(sendBlock, /writePending\(echoKey,/, "and the send path must write under it");
  assert.doesNotMatch(sendBlock, /writePending\(pendingKey\(\)/, "writing under the viewed timeline is the reported bug");

  const rebuildAt = app.indexOf("const queue = sel()?.pendingPromptQueue;");
  assert.ok(rebuildAt > 0, "the queue-rebuild effect must exist");
  const rebuildBlock = app.slice(rebuildAt, rebuildAt + 700);
  assert.match(rebuildBlock, /const key = sel\(\)\?\.session \|\| pendingKey\(\);/, "the rebuild must be filed by the queue's OWNER");

  const countAt = app.indexOf("const queuedCount = () =>");
  assert.ok(countAt > 0, "queuedCount must exist");
  const countBlock = app.slice(countAt, app.indexOf("};", countAt));
  assert.match(countBlock, /sel\(\)\?\.session === pendingKey\(\)/, "the server count is only about the visible feed when the sessions agree");
});
