/**
 * #100 — "a `queued…` message (the same one) appears TWICE on the timeline.
 * Cancel it and one remains."
 *
 * Two writers can add an echo for the same message:
 *
 *   1. the #87 rebuild effect — materialises an echo for any id in the server's
 *      `pendingPromptQueue`, so an echo survives a reload;
 *   2. the send path — appends one when the POST resolves.
 *
 * The rebuild checks what it already holds, so whichever writes FIRST wins and
 * the other appends a duplicate. The `agent-update` snapshot carrying the queue
 * can arrive before the POST resolves, so this is a genuine race, not a fixed
 * order — and both writers are code added in this session.
 *
 * `reconcilePending` cannot catch it: it trims to the server's queued COUNT,
 * which is 1, so it never inspects two echoes that agree on a single id.
 *
 * Cancel explains the rest of the report: cancel filters by `promptId`, so it
 * removes BOTH echoes and leaves the withdrawn log row — "cancel it and one
 * remains".
 *
 * So the invariant is enforced in `writePending`, the one point every writer
 * passes through. Fixing either writer alone would leave the other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface Echo {
  id: string;
  text: string;
  at: number;
  promptId?: string;
}

/** the dedupe as implemented in App.tsx's writePending */
function dedupe(next: Echo[]): Echo[] {
  const seen = new Set<string>();
  const out: Echo[] = [];
  for (let i = next.length - 1; i >= 0; i--) {
    const p = next[i]!;
    if (!p.promptId) {
      out.push(p); // no id: cannot be matched, keep it
      continue;
    }
    if (seen.has(p.promptId)) continue;
    seen.add(p.promptId);
    out.push(p);
  }
  return out.reverse();
}

const echo = (promptId: string | undefined, text = "hello"): Echo => ({
  id: `p${promptId ?? Math.random()}`,
  promptId,
  text,
  at: 1,
});

test("two writers for one promptId leave ONE echo (#100)", () => {
  // the exact race: the rebuild writes, then the send path appends
  assert.equal(dedupe([echo("p1"), echo("p1")]).length, 1, "must not render twice (#100)");
});

test("distinct prompts are all kept (#100)", () => {
  const out = dedupe([echo("p1", "a"), echo("p2", "b"), echo("p3", "c")]);
  assert.equal(out.length, 3, "three queued messages must all show (#100)");
  assert.deepEqual(
    out.map((p) => p.text),
    ["a", "b", "c"],
    "and keep their order (#100)",
  );
});

test("an echo with no promptId is never dropped (#100)", () => {
  // cannot be matched by id, so it must survive the dedupe — otherwise a message
  // sent before the id was assigned would vanish
  assert.equal(dedupe([echo(undefined), echo(undefined)]).length, 2, "id-less echoes are kept (#100)");
  assert.equal(dedupe([echo(undefined), echo("p1")]).length, 2, "id-less mixed with id'd (#100)");
});

test("the LAST write for an id wins (#100)", () => {
  // whichever writer lands second carries the fresher text, so it must survive
  // in either order — the race has no fixed sequence
  assert.equal(dedupe([{ ...echo("p1"), text: "first" }, { ...echo("p1"), text: "second" }])[0]!.text, "second");
  assert.equal(dedupe([{ ...echo("p1"), text: "second" }, { ...echo("p1"), text: "first" }])[0]!.text, "first");
});

test("a duplicate keeps its own SLOT, not its position (#100)", () => {
  // I expected ["dup","second","third"] here and was wrong: the surviving copy
  // is the LAST one written, so it stays at index 1 and the others keep theirs.
  // Printing the actual output is what corrected me.
  const out = dedupe([echo("p1", "first"), echo("p2", "second"), echo("p1", "dup"), echo("p3", "third")]);
  assert.deepEqual(
    out.map((p) => p.text),
    ["second", "dup", "third"],
    "the last write wins and stays in its own slot (#100)",
  );
  // what matters is that no id appears twice and the others are undisturbed
  assert.deepEqual(
    out.map((p) => p.promptId),
    ["p2", "p1", "p3"],
    "one entry per promptId (#100)",
  );
});

test("writePending is the place that enforces it (#100)", () => {
  // structural: the guard has to be at the choke point, or one writer escapes it
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  const at = app.indexOf("const writePending =");
  assert.notEqual(at, -1, "writePending must exist (#100)");
  const body = app.slice(at, app.indexOf("\n  };", at));
  assert.match(body, /seen\.has\(id\)/, "writePending must dedupe on promptId (#100)");
  assert.match(body, /if \(!id\)/, "and must keep id-less echoes (#100)");
  assert.match(body, /deduped\.reverse\(\)/, "preserving order (#100)");
});

test("both writers still exist — the fix does not remove a path (#100)", () => {
  // the #87 rebuild and the send path are both still needed; only the duplicate
  // is gone
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  assert.match(app, /pendingPromptQueue/, "the #87 rebuild survives (#100)");
  assert.match(app, /setPendingMsgs\(/, "the send path survives (#100)");
});
