import test from "node:test";
import assert from "node:assert/strict";
import { restoreTop, spotFromRows } from "../frontend/lib/scroll-return.ts";

test("the spot is the row under the viewport's top edge, not the first row", () => {
  const rows = [
    { eid: "e1", session: "s1", top: -160, height: 120 }, // entirely scrolled past
    { eid: "e2", session: "s1", top: -40, height: 120 }, // crosses the top edge: this is the anchor
    { eid: "e3", session: "s1", top: 80, height: 120 },
  ];
  const spot = spotFromRows(rows, 0, "s1");
  assert.deepEqual(spot, { session: "s1", eid: "e2", offset: 40 }, "how deep into the anchor row the viewport began");
  // round trip: 40px into a row whose content top is 200 puts the reader at 240
  assert.equal(
    restoreTop({ session: "s1", eid: "e2", offset: 40 }, [{ eid: "e2", session: "s1", top: 200, height: 120 }], 5000),
    240,
    "capture then restore returns the same scrollTop",
  );
});

test("the spot is stamped with the TIMELINE id, not with the row's own session", () => {
  /**
   * MEASURED: the rows carry the session name stored in the LOG, which stops matching the timeline id as soon as the
   * session is copied or renamed — the capture then saved under `mediapad-…` while the restore looked up `sw-A`, and the
   * reader always landed at the tail. The rows on screen ARE the timeline being left, so the caller's id is what the
   * spot is keyed by.
   */
  const spot = spotFromRows([{ eid: "e2", session: "logged-name", top: -10, height: 80 }], 0, "timeline-id");
  assert.deepEqual(spot, { session: "timeline-id", eid: "e2", offset: 10 }, "keyed by the timeline, anchored on the row");
  assert.equal(spotFromRows([{ eid: "e2", session: "s1", top: -10, height: 80 }], 0, ""), null, "no id, no spot");
});

test("restoring requires the SAME event in the SAME session", () => {
  const spot = { session: "s1", eid: "e2", offset: 30 };
  const rows = [
    { eid: "e1", session: "s1", top: 0, height: 400 },
    { eid: "e2", session: "s1", top: 400, height: 400 },
  ];
  assert.equal(restoreTop(spot, rows, 5000), 430, "the row's content position plus how deep the reader was into it");
  // the anchor is resolved in the CURRENT feed, so a matching id is the row the reader was on
  assert.equal(
    restoreTop(spot, [{ eid: "e2", session: "s2", top: 400, height: 400 }], 5000),
    430,
    "the row is found by id in the feed that is on screen",
  );
  assert.equal(restoreTop(spot, [{ eid: "zz", session: "s1", top: 400, height: 400 }], 5000), null, "a missing anchor falls back");
  assert.equal(restoreTop(null, rows, 5000), null);
});

test("a spot that resolves to the tail is not a restore", () => {
  // the tail path already puts the reader at the bottom; claiming a restore there would pin a reader who had
  // actually been at the bottom, which is exactly the shape of the old #205 regressions
  const spot = { session: "s1", eid: "last", offset: 0 };
  // the anchor IS the last row, so its top is the maximum scroll position: nothing to restore
  assert.equal(restoreTop(spot, [{ eid: "last", session: "s1", top: 1000, height: 100 }], 1000), null);
  // …while an anchor 100px above the tail is a real restore
  assert.equal(restoreTop(spot, [{ eid: "mid", session: "s1", top: 900, height: 100 }], 1000) === null, true);
  // and clamping never produces a negative position
  // content top 100 + an offset deeper than the row is tall still clamps into the document
  assert.equal(
    restoreTop({ session: "s1", eid: "e2", offset: 500 }, [{ eid: "e2", session: "s1", top: 100, height: 400 }], 1000),
    600,
    "100 + 500, which the caller's max clamps if it is beyond the end",
  );
  assert.equal(restoreTop({ session: "s1", eid: "e1", offset: 0 }, [{ eid: "e1", session: "s1", top: 0, height: 100 }], 1000), 0);
});
