import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

/**
 * The events fetch must ASK for the session it is showing — decided in ONE place.
 *
 * Reported twice, in opposite directions: "パスは `/session/teapot-10-16854917` なのに
 * `tyb2-8-0161a4af` のセッションのタイムラインになってた", then later tyb2's content under
 * teapot's address.
 *
 * The cause both times was the same expression duplicated at several call sites:
 * `tid !== id` — "send ?session= only when the handle is not the agent id". `tid` falls back to the
 * agent id while the session index loads, so in that state the server was asked WITHOUT a session
 * and answered with the agent's BOUND one. Fixing one copy left the others, which is why the
 * symptom returned reversed rather than gone.
 *
 * So the assertion is structural: NO call site may build the events URL itself.
 */
test("every events call site goes through ONE url builder (#routing)", async () => {
  const src = await readSource("frontend/App.tsx");
  assert.ok(
    src.includes("function eventsUrl("),
    "the events URL must be built in one helper — four copies of it is how the bug kept coming back",
  );
  assert.ok(
    src.includes("function sessionQuery("),
    "and the ?session= decision must be its own helper, so `tid !== id` cannot reappear",
  );
  // no call site assembles `/api/agents/<id>/events` itself
  const inline = src.match(/api\/agents\/\$\{id\}\/events/g) ?? [];
  assert.equal(
    inline.length,
    0,
    `found ${inline.length} hand-built events URL(s); every site must call eventsUrl() so a dropped ` +
      `query parameter cannot differ between the first page, older pages and catch-up`,
  );
  // and the page-dependent bits are still passed through
  for (const param of ["before", "after"]) {
    assert.ok(
      new RegExp(`page\\.${param}`).test(src),
      `${param}= must still reach the query — it is what pages the timeline`,
    );
  }
});

test("the ?session= helper never keys off the agent id (#routing)", async () => {
  const src = await readSource("frontend/App.tsx");
  const at = src.indexOf("function sessionQuery(");
  assert.ok(at > 0, "sessionQuery must exist");
  const body = src.slice(at, src.indexOf("\n  }", at));
  assert.ok(
    !/tid\s*!==\s*agentId/.test(body),
    "comparing the handle against the agent id is the bug: it cannot express 'do I know this " +
      'session?`, and it silently drops the query exactly when the index has not loaded',
  );
  assert.match(
    body,
    /masterSessionIndex\(\)\.has\(tid\)/,
    "the question is whether the index KNOWS the id, and that governs whether it is sent",
  );
});
