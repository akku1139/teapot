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

test("the session index shares its in-flight request, and the latch means LANDED (#routing)", async () => {
  /**
   * MEASURED at boot, after the ?session= fix had already shipped:
   *
   *     want=tyb2-8-0161a4af  owner=undefined  idx=0  agents=tyb2-8,teapot-10
   *
   * The index was EMPTY when the deep link resolved, so no owner was found and the boot fell
   * through to `localStorage` — opening another agent's session under this URL. Reloading
   * /session/tyb2-8-0161a4af showed teapot-10's timeline.
   *
   * Cause: `refreshSessionIndex` set its `fetched` latch BEFORE awaiting. `refreshAgents()` fires an
   * un-awaited refresh at boot, so the `await` in `onMount` found the latch set, returned
   * immediately, and the caller read an index that had not arrived. A boolean cannot distinguish
   * "in flight" from "landed".
   */
  const src = await readSource("frontend/App.tsx");
  const at = src.indexOf("async function refreshSessionIndex(");
  assert.ok(at > 0, "refreshSessionIndex must exist");
  const body = src.slice(at, src.indexOf("\n  }\n", at));

  assert.match(
    body,
    /if \(indexInFlight\) return indexInFlight/,
    "a second caller must JOIN the request in flight — returning early with an empty index is how " +
      "the deep link lost its owner",
  );
  assert.match(
    body,
    /indexInFlight = run/,
    "the in-flight promise must be recorded so concurrent callers can await it",
  );
  // the latch is set INSIDE the fetch, i.e. after the data arrived
  const latchAt = body.indexOf("indexFetched = true");
  const awaitAt = body.indexOf("await api(\"/api/sessions\")");
  assert.ok(awaitAt > 0, "the fetch must be awaited");
  assert.ok(
    latchAt > awaitAt,
    "the `landed` latch must be set AFTER the data arrives — setting it before the await makes " +
      "every later caller read an empty index",
  );
  // and a failure must not leave it latched forever
  assert.match(
    body,
    /catch \{[\s\S]{0,120}\}/,
    "a failed fetch must leave the latch clear so the next caller retries",
  );
  assert.ok(
    !/catch \{[\s\S]{0,200}indexFetched = true/.test(body),
    "and must certainly not mark the index as fetched on failure",
  );
});
