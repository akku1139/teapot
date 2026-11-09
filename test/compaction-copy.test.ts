/**
 * The ⧉ copy button on a compaction row must copy the checkpoint (#202: "実バグ: compactionのcopyが不発").
 *
 * `rawOf` answered "" for every type it did not know, and compaction was one of them, so the button was there and copied
 * nothing — the operator's clipboard was unchanged with no error anywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { rawOf } from "../frontend/lib/timeline-row.ts";

const ev = (data: Record<string, unknown>) =>
  ({ id: "e1", seq: 1, ts: "2026-01-01T00:00:00Z", session: "s", branch: "br0", parent: null, type: "compaction", data }) as never;

test("a compaction row copies its summary and usage line", () => {
  const text = rawOf(ev({
    mode: "summarize",
    tokensBefore: 615000,
    tokensAfter: 68000,
    contextLine: "context 68% used (615k/900k tokens, 135k until compaction)",
    summary: "- the operator asked for the queue label fix",
  }));
  assert.ok(text.length > 0, "the clipboard must actually receive something");
  assert.match(text, /context compacted/);
  assert.match(text, /615k → 68k tok/, "the sizes are part of the checkpoint");
  assert.match(text, /68% used/, "and so is the usage line it was recorded with");
  assert.match(text, /queue label fix/, "and the summary itself");
});

test("a compaction row with no summary still copies its header", () => {
  // a FAILED summarise pass logs the event without a summary; the row must still be copyable
  const text = rawOf(ev({ mode: "truncate", tokensBefore: 900000, tokensAfter: 200000 }));
  assert.match(text, /context compacted/);
  assert.match(text, /truncate/);
});
