import { test } from "node:test";
import assert from "node:assert/strict";

interface Echo {
  id: string;
  text: string;
  at: number;
  promptId?: string;
}

function dedupe(next: Echo[]): Echo[] {
  const seen = new Set<string>();
  const out: Echo[] = [];
  for (let i = next.length - 1; i >= 0; i--) {
    const p = next[i]!;
    if (!p.promptId) {
      out.push(p); 
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
  assert.equal(dedupe([echo(undefined), echo(undefined)]).length, 2, "id-less echoes are kept (#100)");
  assert.equal(dedupe([echo(undefined), echo("p1")]).length, 2, "id-less mixed with id'd (#100)");
});

test("the LAST write for an id wins (#100)", () => {
  assert.equal(dedupe([{ ...echo("p1"), text: "first" }, { ...echo("p1"), text: "second" }])[0]!.text, "second");
  assert.equal(dedupe([{ ...echo("p1"), text: "second" }, { ...echo("p1"), text: "first" }])[0]!.text, "first");
});

test("a duplicate keeps its own SLOT, not its position (#100)", () => {
  const out = dedupe([echo("p1", "first"), echo("p2", "second"), echo("p1", "dup"), echo("p3", "third")]);
  assert.deepEqual(
    out.map((p) => p.text),
    ["second", "dup", "third"],
    "the last write wins and stays in its own slot (#100)",
  );
  assert.deepEqual(
    out.map((p) => p.promptId),
    ["p2", "p1", "p3"],
    "one entry per promptId (#100)",
  );
});
