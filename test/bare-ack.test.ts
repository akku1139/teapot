/**
 * A turn that ends on "reported." / "報告済み。" must not stop the work.
 *
 * The system prompt used to say "end the turn right after the call (a short 'reported.' is fine)", so models filed a
 * report and answered "reported." — and the Japanese variant "報告済み。" appears WITHOUT the tool call at all, which the
 * loop never noticed: with no goal set (or auto-continue off) the round ended and the task stopped mid-way.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isBareAcknowledgement } from "../src/agent/ack.ts";

test("acknowledgements in both wordings are recognised", () => {
  for (const text of [
    "reported.",
    "Reported",
    "reported！",
    "done.",
    "done",
    "ok",
    "noted",
    "報告済み。",
    "報告しました。",
    "了解",
    "承知しました",
    "完了しました",
    "進捗を報告しました。",
  ]) {
    assert.equal(isBareAcknowledgement(text), true, text);
  }
});

test("a real report is not an acknowledgement", () => {
  for (const text of [
    "done — tests pass and the next step is the scroll fix",
    "報告します: 3ファイル修正、テストは緑、次はスクロール",
    "reported. Now fixing the queue label, next I will release 0.37.177",
    "ok, but the release is still blocked on sigstore",
    "",
    "   ",
  ]) {
    assert.equal(isBareAcknowledgement(text), false, JSON.stringify(text));
  }
});

test("a multi-line message is never just an acknowledgement", () => {
  assert.equal(isBareAcknowledgement("done\n"), true, "a trailing newline is still one line");
  assert.equal(isBareAcknowledgement("done\n- item"), false, "a list is content");
});
