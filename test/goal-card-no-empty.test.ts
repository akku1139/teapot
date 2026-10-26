import { test } from "node:test";
import assert from "node:assert/strict";
import { goalLine, isPlaceholderDetail } from "../frontend/lib/goal-timeline.ts";

function assertHasBody(data: Record<string, unknown>, why: string) {
  const line = goalLine(data as never);
  const body = String(line.detail ?? "").trim();
  assert.ok(body.length > 0, `${why}: an empty card reads as a verdict never delivered (#101); label=${line.label}`);
  assert.ok(
    !isPlaceholderDetail(body),
    `${why}: the body must SAY something, not be a placeholder (#101); got ${JSON.stringify(body)}`,
  );
}

test("a status event with no text still gets a body (#101)", () => {
  assertHasBody({ event: "status", status: "paused" }, "the reported case");
  assertHasBody({ event: "status", status: "queued" }, "any bare status");
});

test("an explicit text is preserved verbatim (#101)", () => {
  const line = goalLine({ event: "status", status: "paused", text: "operator paused it" } as never);
  assert.equal(line.detail, "operator paused it", "real detail must not be overwritten (#101)");
  assert.equal(line.label, "🎯 goal paused", "the label is unchanged (#101)");
});

test("a status event with NO status still gets a body (#41)", () => {
  assertHasBody({ event: "status", status: "" }, "no status recorded");
});

test("no goal event renders an EMPTY card (#41/#51/#101)", () => {
  const events: Record<string, unknown>[] = [
    { event: "status", status: "paused" },
    { event: "status", status: "done" },
    { event: "status", status: "active" },
    { event: "status", status: "" },
    { event: "audit", verdict: "approved", detail: "" },
    { event: "audit", verdict: "approved", feedback: "checked every line" },
    { event: "audit", verdict: "changes-required" },
    { event: "audit-failed", detail: "" },
    { event: "unknown-thing" },
    { event: "unknown-thing", text: "has text" },
    {},
  ];
  for (const e of events) {
    const line = goalLine(e as never);
    if (line.hasCard !== true) continue; 
    assert.ok(
      String(line.detail ?? "").trim().length > 0,
      `no empty cards: ${JSON.stringify(e)} produced a CARD with no body (#101)`,
    );
  }
});

test("an approved audit with no reason stays a LABEL, not a card (#51)", () => {
  const line = goalLine({ event: "audit", verdict: "approved", detail: "" } as never);
  assert.equal(line.hasCard, false, "no reason means no card (#51)");
  assert.equal(line.label, "✅ audit: approved", "the label still reads (#51)");
});

test("the fallback names the status rather than reading generically (#101)", () => {
  const line = goalLine({ event: "status", status: "paused" } as never);
  assert.match(String(line.detail), /paused/, "the body must name the status (#101)");
});
