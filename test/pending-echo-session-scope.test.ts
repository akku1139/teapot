/**
 * #87 — "with a pending message, go to another session and come back: the
 * timeline no longer shows that it is pending."
 *
 * The top bar kept counting it (that comes from the server's `pendingPromptIds`)
 * while the timeline showed the message as a settled log row. The two disagreed,
 * and the timeline read as "already sent".
 *
 * Cause: `pendingMsgs` was ONE global list, cleared on every session switch —
 * while every other per-session store here survives one (`liveByAgent`,
 * `timelineCache`, `drafts`). So the echoes were simply gone on return, and
 * `stillPendingIds` (derived from that list) no longer covered the queued
 * prompt, so its log row rendered as settled.
 *
 * Now keyed by the same handle the timeline uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

test("pending echoes are stored per session, not globally (#87)", () => {
  assert.match(
    app,
    /const pendingBySession = new Map<string, PendingEcho\[\]>/,
    "echoes must be keyed by session (#87)",
  );
  assert.match(app, /const pendingKey = \(\): string =>/, "and addressed through one key (#87)");
});

test("a session switch saves the outgoing echoes and restores the incoming (#87)", () => {
  // the line that caused the bug was a bare `setPendingMsgs([])`
  assert.doesNotMatch(
    app,
    /setPendingMsgs\(\[\]\)/,
    "the switch must not CLEAR the echoes (#87) — that is the whole bug",
  );
  const sw = app.slice(app.indexOf("#87: this used to CLEAR the list"), app.indexOf("#87: this used to CLEAR the list") + 400);
  assert.match(
    sw,
    /writePending\(prevTid \|\| prevId/,
    "the outgoing session's echoes must be SAVED (#87)",
  );
  assert.match(
    sw,
    /setPendingMsgs\(pendingFor\(tid \|\| id\)\)/,
    "and the incoming session's RESTORED (#87)",
  );
});

test("every mutation of the echo list goes through the per-session writer (#87)", () => {
  // a bare setPendingMsgs would update the signal but not the map, so the echo
  // would vanish again on the next switch
  const writes = [...app.matchAll(/setPendingMsgs\(/g)].map((m) => m.index);
  for (const at of writes) {
    const line = app.slice(app.lastIndexOf("\n", at) + 1, app.indexOf("\n", at));
    // the signal is only ever set directly by writePending and by the restore
    const allowed =
      /setPendingMsgs\(next\)/.test(line) || /setPendingMsgs\(pendingFor\(/.test(line) || /setPendingMsgs\(\[\]\)/.test(line);
    assert.ok(
      allowed,
      `setPendingMsgs must go through writePending so the map stays in step (#87); got: ${line.trim()}`,
    );
  }
});

test("the echo set is not re-derived from the timeline on return (#87)", () => {
  // the pending indicator must survive a switch, so the per-session map is the
  // single source of truth for which echoes belong to a session
  assert.match(
    app,
    /if \(next\.length === 0\) pendingBySession\.delete\(key\);/,
    "an emptied session drops its entry rather than accumulating (#87)",
  );
  assert.match(
    app,
    /else pendingBySession\.set\(key, next\);/,
    "and a session with echoes is remembered (#87)",
  );
});
