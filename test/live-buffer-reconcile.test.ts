/**
 * #40 — "agent1 → bash (running) → agent2 (writing): agent2's message is
 * agent1's content, with the writing cursor on it."
 *
 * ## Why the earlier fixes all passed while this still reproduced
 *
 * `19b4aab` → `08eaa30` → `2e058a8` were each individually correct, because the
 * recovery mechanism they added only covered ONE case: a MISSED transition to
 * `idle`. The pruning effect depends on `agents()` alone:
 *
 *     const list = agents();
 *     setLiveByAgent((prev) => pruneDeadLiveBuffers(prev, …));
 *
 * So a session switch could never trigger it — and if the agent was ALREADY idle
 * when the switch happened, the snapshot did not change at all, so no prune was
 * even scheduled:
 *
 *     A open, buffer streaming, A settles
 *     A → B        (buffer hidden, still present)
 *     B → A        (buffer reappears WITH the cursor — never revalidated)
 *
 * The missing operation was reconciling the selected agent's buffer against the
 * timeline just loaded. `select()` cleared `events()` but never touched
 * `liveByAgent`.
 *
 * ## The paired tests
 *
 * The obvious "fix" — clear the buffer on every switch — passes the first test
 * and introduces the OPPOSITE bug. Both are asserted here, because either alone
 * is a plausible regression.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  reconcileLiveBuffer,
  isCoveredByLog,
  isLiveStatus,
  pruneDeadLiveBuffers,
} from "../frontend/live-buffer.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readSource(path.join(here, "..", "frontend", "App.tsx"));

const buf = { text: "agent1 was here", streaming: true };
const logHas = [{ type: "message", data: { role: "assistant", content: "agent1 was here" } }];

/* ---------- the stale case: A → B → A with A already idle ---------- */

test("a stale buffer is dropped when returning to a settled agent (#40)", () => {
  // exactly the reported reproduction: the snapshot never changed, so no prune
  // was scheduled, and the old text came back with the writing cursor
  assert.equal(
    reconcileLiveBuffer(buf, [], "idle"),
    null,
    "an idle agent's buffer must not reappear (#40)",
  );
});

test("a buffer whose text is already in the log is dropped (#40)", () => {
  assert.equal(
    reconcileLiveBuffer(buf, logHas, "running"),
    null,
    "the original report: agent2 showed agent1's text — it is persisted, so drop it (#40)",
  );
});

/* ---------- the inverse: a genuine stream must survive ---------- */

test("a genuine in-flight stream SURVIVES A → B → A (#40)", () => {
  // the opposite failure mode: clearing on every switch destroys real work the
  // operator is briefly looking away from
  assert.equal(
    reconcileLiveBuffer(buf, [], "running"),
    buf,
    "an unpersisted stream must be kept (#40)",
  );
});

test("a parked agent (waiting) keeps its buffer (#40)", () => {
  // `waiting` is an ask_user pause: the turn is unfinished and its answer has not
  // reached the log, so the bubble is the only copy
  assert.equal(reconcileLiveBuffer(buf, [], "waiting"), buf, "waiting is live (#40)");
});

test("an empty but streaming buffer is kept while live (#40)", () => {
  const fresh = { text: "", streaming: true };
  assert.equal(reconcileLiveBuffer(fresh, [], "running"), fresh, "first chunk, nothing logged (#40)");
});

/* ---------- "live" must mean one thing ---------- */

test("live means the same thing in both places (#40)", () => {
  // pruneDeadLiveBuffers kept `running` AND `waiting`; isCoveredByLog only
  // honoured `running`, so the two could disagree about the same buffer in one tick
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

/* ---------- the wiring, which was the real bug twice already ---------- */

test("select() reconciles the buffer after loading the timeline (#40)", () => {
  // `select()` cleared events() but never touched liveByAgent, so nothing could
  // revalidate on a session switch
  const at = app.indexOf("async function select(");
  assert.notEqual(at, -1, "select() must exist (#40)");
  // #126: select() is ~171,000 chars, so a 4200-char window found none of this.
  // Take a real slice up to the NEXT top-level declaration instead.
  const end = app.indexOf("\n  async function ", at + 10);
  const block = app.slice(at, end === -1 ? at + 12000 : end);
  assert.match(block, /reconcileLiveBuffer\(/, "select() must reconcile (#40)");
  const rec = block.indexOf("reconcileLiveBuffer(");
  assert.ok(
    rec > block.indexOf("another switch won"),
    "reconciliation must run after loadEvents (#40)",
  );
});

test("the reconcile runs AFTER loadEvents, not before (#40)", () => {
  const at = app.indexOf("reconcileLiveBuffer(cur, events()");
  assert.notEqual(at, -1, "it must read the LOADED events (#40)");
  const before = app.lastIndexOf("setEvents([])", at);
  assert.ok(before !== -1 && before < at, "and must come after events were fetched (#40)");
});

/* ---------- the WS hello snapshot was being discarded ---------- */

test("the WS hello snapshot is applied, not discarded (#40)", () => {
  assert.match(
    app,
    /if \(msg\.kind === "hello" && Array\.isArray\(msg\.agents\)\) \{/,
    "the authoritative snapshot sent on connect must be handled (#40)",
  );
  assert.match(app, /msg\.kind === "hello"/, "the handler must exist (#40)");
});

test("hello, agent-update and REST share one merge (#40)", () => {
  assert.match(app, /function mergeAgentSnapshots\(/, "one merge helper (#40)");
  const uses = [...app.matchAll(/mergeAgentSnapshots\(/g)].length;
  assert.ok(uses >= 3, `all three snapshot paths must use it (#40); found ${uses - 1} call sites`);
});
