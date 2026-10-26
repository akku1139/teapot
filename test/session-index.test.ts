import { test } from "node:test";
import assert from "node:assert/strict";

test("the URL never carries an AGENT id — two tabs must not collapse onto one session (#routing)", async () => {
  const { linkableSessionId } = await import("../frontend/lib/session-index.ts");
  const index = new Map([
    ["tyb2-8-0161a4af", "tyb2-8"],
    ["teapot-10-16854917", "teapot-10"],
  ]);
  const agents = ["tyb2-8", "teapot-10"];

  assert.equal(linkableSessionId("tyb2-8-0161a4af", index, agents), "tyb2-8-0161a4af");
  assert.equal(linkableSessionId("teapot-10-16854917", index, agents), "teapot-10-16854917");

  assert.equal(
    linkableSessionId("tyb2-8", index, agents),
    null,
    "writing an agent id into the URL makes every tab resolve to that agent's latest session",
  );

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
