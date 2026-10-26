import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  reconcileLiveBuffer,
  isCoveredByLog,
  isLiveStatus,
  pruneDeadLiveBuffers,
  type LiveBuf,
} from "../frontend/lib/live-buffer.ts";

const _here = path.dirname(fileURLToPath(import.meta.url));

const buf: LiveBuf = { text: "agent1 was here", reasoning: "", at: Date.now() };
const logHas = [{ type: "message", data: { role: "assistant", content: "agent1 was here" } }];

test("a stale buffer with NO log copy is KEPT for one more frame (#40, #172b)", () => {
  assert.equal(
    reconcileLiveBuffer(buf, [], "idle"),
    buf,
    "no assistant message in the log yet, so this bubble is not redundant yet",
  );
  assert.equal(reconcileLiveBuffer(buf, logHas, "idle"), null, "persisted → drop (#40)");
  assert.equal(
    reconcileLiveBuffer({ text: "", reasoning: "", at: Date.now() }, [], "idle"),
    null,
    "an empty bubble has nothing to flash, so it can go at once",
  );
});

test("a buffer whose text is already in the log is dropped (#40)", () => {
  assert.equal(
    reconcileLiveBuffer(buf, logHas, "running"),
    null,
    "the original report: agent2 showed agent1's text — it is persisted, so drop it (#40)",
  );
});

test("a genuine in-flight stream SURVIVES A → B → A (#40)", () => {
  assert.equal(
    reconcileLiveBuffer(buf, [], "running"),
    buf,
    "an unpersisted stream must be kept (#40)",
  );
});

test("a parked agent (waiting) keeps its buffer (#40)", () => {
  assert.equal(reconcileLiveBuffer(buf, [], "waiting"), buf, "waiting is live (#40)");
});

test("an empty but streaming buffer is kept while live (#40)", () => {
  const fresh: LiveBuf = { text: "", reasoning: "", at: Date.now() };
  assert.equal(reconcileLiveBuffer(fresh, [], "running"), fresh, "first chunk, nothing logged (#40)");
});

test("live means the same thing in both places (#40)", () => {
  assert.equal(isLiveStatus("waiting"), true, "waiting is live (#40)");
  assert.equal(isCoveredByLog(buf, [], "waiting"), false, "and must NOT read as covered (#40)");
  assert.equal(isCoveredByLog(buf, [], "running"), false, "same for running (#40)");
  assert.equal(isLiveStatus("idle"), false, "idle is not live (#40)");
});

test("the prune helper uses the shared predicate (#40)", () => {
  const kept = pruneDeadLiveBuffers(
    new Map([["a", buf]]),
    () => "waiting",
  );
  assert.equal(kept.size, 1, "prune must agree that a waiting agent is live (#40)");
  const dropped = pruneDeadLiveBuffers(
    new Map([["a", buf]]),
    () => "idle",
  );
  assert.equal(dropped.size, 0, "and that an idle one is not (#40)");
});

