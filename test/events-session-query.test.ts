import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

/**
 * The events fetch must ASK for the session it is showing.
 *
 * Reported: "タブを開いたときにパスは `/session/teapot-10-16854917` なのに `tyb2-8-0161a4af` の
 * セッションのタイムラインになってた" — the address bar named one conversation and the feed showed
 * another.
 *
 * The query was built as `tid !== id`, i.e. "send ?session= only when the handle is not the agent
 * id". But `tid` falls back to the agent id while the session index is loading, and in that state
 * the server is asked WITHOUT a session — so it answers with the agent's BOUND session, which need
 * not be the one in the URL. Two sources of truth, disagreeing.
 *
 * The assertion is on the CONDITION rather than the string: what matters is that a known session id
 * is always sent, and that the guard does not depend on comparing against the agent id.
 */
test("a known session id is always sent to the events endpoint (#routing)", async () => {
  const src = await readSource("frontend/App.tsx");
  const at = src.indexOf("const sessQ =");
  assert.ok(at > 0, "the events query is built somewhere");
  const stmt = src.slice(at, src.indexOf(";", at));
  assert.ok(
    /masterSessionIndex\(\)\.has\(tid\)/.test(stmt),
    "the session must be sent whenever the index KNOWS it — keying on `tid !== id` drops it " +
      "exactly when tid fell back to the agent id, and the server then answers with the bound " +
      "session instead of the one in the URL",
  );
  assert.ok(
    !/tid\s*!==\s*id/.test(stmt),
    "comparing against the agent id is the bug: it cannot express 'do I know this session?'",
  );
  // and it must be a query param on the events fetch
  assert.ok(
    /session=\$\{encodeURIComponent\(tid\)\}/.test(stmt),
    "the id must actually reach the query string",
  );
});
