import { test } from "node:test";
import assert from "node:assert/strict";


test("the URL never carries an AGENT id — two tabs must not collapse onto one session (#routing)", async () => {
  /**
   * Reported: two tabs open on `/session/tyb2-8` and `/session/teapot-10`, reload after a server
   * restart, and BOTH open the same session.
   *
   * The mechanism: `select()` resolved the timeline handle as `latestSessionOf(id) ?? id`, and the
   * `?? id` fired whenever the session INDEX had not landed. That agent id was then written into the
   * URL by `navigate()`. An agent id is not a session id — it resolves through
   * `resolveTimelineSession` to that agent's LATEST session — so every tab that deep-linked an agent
   * id converged on one session. The URL is shared state between tabs, which is why the wrong value
   * there is a cross-tab bug rather than a display glitch.
   */
  const { linkableSessionId } = await import("../frontend/lib/session-index.ts");
  const index = new Map([
    ["tyb2-8-0161a4af", "tyb2-8"],
    ["teapot-10-16854917", "teapot-10"],
  ]);
  const agents = ["tyb2-8", "teapot-10"];

  // the real ids go through, and stay distinct
  assert.equal(linkableSessionId("tyb2-8-0161a4af", index, agents), "tyb2-8-0161a4af");
  assert.equal(linkableSessionId("teapot-10-16854917", index, agents), "teapot-10-16854917");

  // an AGENT id is refused: it would merge the tabs
  assert.equal(
    linkableSessionId("tyb2-8", index, agents),
    null,
    "writing an agent id into the URL makes every tab resolve to that agent's latest session",
  );

  /**
   * An UNKNOWN session id is still written, deliberately.
   *
   * The index may legitimately lack a session directory that has not been scanned yet, and blanking
   * the URL would drop a deep link the operator just opened. What must never be written is an id
   * that IS an agent id — that is the value which merges tabs.
   */
  assert.equal(
    linkableSessionId("tyb2-8-0161a4af", new Map(), agents),
    "tyb2-8-0161a4af",
    "a session id the index cannot confirm yet still identifies a timeline",
  );
  assert.equal(
    linkableSessionId("tyb2-8", new Map(), agents),
    null,
    "and an agent id is refused even before the index lands, which is the case that broke two tabs",
  );
  assert.equal(linkableSessionId("", index, agents), null);
});
