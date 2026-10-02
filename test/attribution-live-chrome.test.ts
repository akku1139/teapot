/**
 * #40 — "when messages arrive in the order agent1 → bash (running) → agent2
 *         (writing), agent2's message is the SAME content as agent1's, and it
 *         carries a writing cursor."
 *
 * A prior fix (1a596c3) cleared the live streaming buffer at the per-turn
 * boundary, and the maintainer replied "not fixed, check not only streaming".
 * That was right: the live buffer is keyed per agent and cannot leak, so the
 * symptom was never in it.
 *
 * The timeline marked every row live from ONE value — the selected agent's
 * status:
 *
 *     agentActive={sel()?.status === "running" || sel()?.status === "waiting"}
 *
 * which then drives `.embed.running` and its blink, and the "writing…" label
 * under a `write_file` with no result yet. Nothing in that expression knows
 * WHOSE row it is painting, so a row belonging to a different actor wore the
 * selected agent's live chrome.
 *
 * The rows that belong to someone else are the MIRRORED SUB-AGENT rows: the
 * master appends a child's events into the parent's own log as `sub` rows, and
 * the feed expands each into a normal-looking row tagged with `actor`. They
 * belong in the parent's feed for context, but the parent going `running` says
 * nothing about whether the child is, so painting them as the parent's live
 * work is simply wrong — and it is exactly the reported picture: agent1's
 * text under agent2's writing cursor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isOwnLiveWork } from "../frontend/live-buffer.ts";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

/* ---------- the rule ---------- */

test("a mirrored sub-agent row is NOT the selected agent's own live work (#40)", () => {
  // The expansion in App.tsx tags every mirrored row with `actor`.
  assert.equal(
    isOwnLiveWork({ data: { actor: "proj-a-sub-1" } }),
    false,
    "a child's row must not inherit the parent's live chrome (#40)",
  );
});

test("the parent agent's own rows ARE its live work (#40)", () => {
  assert.equal(isOwnLiveWork({ data: { role: "assistant", content: "mine" } }), true);
  assert.equal(isOwnLiveWork({ data: { name: "write_file", args: {} } }), true);
  assert.equal(isOwnLiveWork({ data: {} }), true);
  assert.equal(isOwnLiveWork({}), true);
  assert.equal(isOwnLiveWork(null), false, "no row is not live work (#40)");
});

test("an empty or non-string actor does not disqualify a row (#40)", () => {
  // `actor` only ever holds a sub-agent id, so anything else means the row is
  // the parent's own. Getting this backwards would strip the chrome from
  // every ordinary message.
  assert.equal(isOwnLiveWork({ data: { actor: "" } }), true, "an empty actor is not a sub-agent (#40)");
  assert.equal(isOwnLiveWork({ data: { actor: undefined } }), true);
  assert.equal(isOwnLiveWork({ data: { actor: null } }), true);
  assert.equal(isOwnLiveWork({ data: { actor: 42 } }), true, "a non-string actor is not a sub-agent id (#40)");
});

/* ---------- wiring: the flag must actually consult it ---------- */

test("agentActive is gated on the row's own provenance (#40)", () => {
  // The defect was a bare status check passed to every row.
  assert.match(
    app,
    /agentActive=\{[\s\S]{0,200}isOwnLiveWork\(e\)/,
    "agentActive must consult isOwnLiveWork(e) (#40)",
  );
  assert.doesNotMatch(
    app,
    /agentActive=\{sel\(\)\?\.status === "running" \|\| sel\(\)\?\.status === "waiting"\}/,
    "the provenance-blind status check is the regression (#40)",
  );
});

test("the guard sits where every timeline row receives the flag (#40)", () => {
  // It has to be at the call site that feeds the <For>, or only some rows are
  // protected and the bug survives for the rest.
  const idx = app.indexOf("isOwnLiveWork(e)");
  assert.notEqual(idx, -1, "the guard must exist (#40)");
  const window = app.slice(Math.max(0, idx - 4000), idx + 400);
  // it is a prop on the row component, inside the timeline <For> — not a
  // helper buried somewhere that no row would ever consult
  assert.match(
    window,
    /agentActive=\{/,
    "the guard must be the agentActive prop passed to each row (#40)",
  );
  assert.match(
    window,
    /answeredIds=\{answeredQuestionIds\}/,
    "that prop belongs to the per-row component inside the timeline loop (#40)",
  );
});

/* ---------- the mirrored rows really are tagged with an actor ---------- */

test("mirrored sub-agent rows are expanded with an actor tag (#40)", () => {
  // Without the tag there is nothing for isOwnLiveWork to key on, so this is
  // the other half of the same fix and is asserted here rather than assumed.
  assert.match(
    app,
    /expanded\.push\(\{ \.\.\.e, type: kind, data: \{ \.\.\.d\?\.data, actor: d\?\.sub \} \}\)/,
    "the sub-row expansion must tag the row with its actor (#40)",
  );
});

test("the live bubble is still keyed per agent (#40)", () => {
  // Guarding against regressing the fix 1a596c3 landed: the buffer map is
  // keyed by agent id, which is why the symptom had to be elsewhere.
  assert.match(app, /const \[liveByAgent, setLiveByAgent\] = createSignal<Map</, "the buffer stays per-agent (#40)");
  assert.match(app, /setLiveByAgent\(\(prev\) => applyDelta\(prev, msg\.agentId, msg\)\)/, "deltas key by agentId (#40)");
});
