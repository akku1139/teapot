/**
 * A `todo` row says WHICH items moved, by update type — not just "tasks updated".
 *
 * "`✅ tasks updated (agent)` があるけど、これの表示は具体的にできない? 前はツールカードそのまま出してたけど、今はそうじゃないので
 * アップデートのタイプ(追加、完了、置換など)によって上手いこと".
 *
 * The event already had the counts; it now records the TEXTS too, so the row can name the items. What matters is that the
 * verb matches what happened — a completion must not read like an addition — and that an older, counts-only event still
 * renders something honest rather than guessing a direction.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeTodo } from "../frontend/lib/todo-summary.ts";

test("a completion reads as a completion, with the items named", () => {
  const s = summarizeTodo({ event: "items", by: "agent", matched: 2, done: ["write the parser", "add tests"] });
  assert.match(s.label, /2 done/);
  assert.ok(!/added/.test(s.label), "a completion must not read like an addition");
  assert.match(s.body, /write the parser/);
  assert.match(s.body, /add tests/);
});

test("each action has its own verb and glyph", () => {
  const added = summarizeTodo({ event: "items", by: "agent", added: 1, addedItems: ["measure in Firefox"] });
  assert.match(added.label, /1 added/);
  assert.match(added.body, /＋ measure in Firefox/);

  const reopened = summarizeTodo({ event: "items", by: "agent", matched: 1, reopened: ["verify on macOS"] });
  assert.match(reopened.label, /1 reopened/);
  assert.match(reopened.body, /↺ verify on macOS/);

  const removed = summarizeTodo({ event: "items", by: "agent", removed: 1, removedItems: ["old step"] });
  assert.match(removed.label, /1 removed/);
  assert.match(removed.body, /－ old step/);
});

test("a mixed update names every kind, and the body groups by kind", () => {
  const s = summarizeTodo({
    event: "items",
    by: "agent",
    matched: 2,
    added: 1,
    done: ["finish the parser"],
    reopened: ["check the edge case"],
    addedItems: ["write the note"],
  });
  assert.match(s.label, /done/);
  assert.match(s.label, /added/);
  assert.match(s.label, /reopened/);
  const lines = s.body.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /✔ finish the parser/, "done first");
  assert.match(lines[1]!, /＋ write the note/, "then added");
  assert.match(lines[2]!, /↺ check the edge case/, "then reopened");
});

test("an item that did not match is called out, not silently dropped", () => {
  const s = summarizeTodo({ event: "items", by: "agent", matched: 1, done: ["real item"], unknown: ["typo item"] });
  assert.match(s.body, /⚠ not found: typo item/);
});

test("replacing the whole list does not invent per-item detail", () => {
  const s = summarizeTodo({ event: "set", by: "operator" });
  assert.match(s.label, /replaced/);
  assert.equal(s.body, "", "there is no delta to report, and claiming one would be a lie");
});

test("an ITEM event with no detail at all is 'updated', not 'replaced'", () => {
  /**
   * Absence of counts is not evidence of a replacement — an older log carries neither. Claiming "replaced" there would assert
   * something the event does not say.
   */
  const s = summarizeTodo({ event: "items", by: "operator" });
  assert.match(s.label, /tasks updated \(operator\)/);
  assert.equal(s.body, "");
});

test("a counts-only event (an older log) says 'updated' and claims no direction", () => {
  const s = summarizeTodo({ event: "items", by: "human", matched: 3 });
  assert.equal(s.label, "✅ tasks updated (operator)", "the wording the operator asked for, and `human` is not the word");
  assert.equal(s.body, "");
});

test("an event that names no kind but carries ITEMS is an item update, not a replacement", () => {
  /**
   * `set` is the literal event name the server writes for a wholesale replacement. An event that only says `{by, items}` (an
   * older producer, or a log from before the name existed) is describing ITEMS, so reading it as "replaced" claims a rewrite
   * that never happened — and that is exactly the fixture the smoke harness uses.
   */
  const s = summarizeTodo({ by: "operator", items: [{ text: "ship it", done: false }] } as never);
  assert.match(s.label, /tasks updated \(operator\)/);
  assert.ok(!/replaced/.test(s.label));
});

test("the actor is always 'operator', never 'human'", () => {
  for (const by of ["human", "operator", "agent"]) {
    assert.ok(!/human/.test(summarizeTodo({ event: "set", by }).label), `by=${by}`);
  }
});
