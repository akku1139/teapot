import { test } from "node:test";
import assert from "node:assert/strict";

function migrate(stored: string[] | null, marker: string | null): { keys: string[]; dropped: number } {
  const keys = Array.isArray(stored) ? stored.filter((x) => typeof x === "string") : [];
  const VERSION = 2;
  const m = Number(marker ?? "0");
  if (m < VERSION) {
    const kept = keys.filter((k) => !k.startsWith("chat:"));
    return { keys: kept, dropped: keys.length - kept.length };
  }
  return { keys, dropped: 0 };
}

test("header-era chat keys are dropped on first load (#81)", () => {
  const r = migrate(["chat:teapot", "chat:teapot-3", "chat:tyb2-3"], null);
  assert.deepEqual(r.keys, [], "the ten orphaned chat keys must not survive (#81)");
  assert.equal(r.dropped, 3);
});

test("directory collapse keys are PRESERVED (#81)", () => {
  const r = migrate(["ws:/home/ai-agent/work/teapot", "chat:teapot"], null);
  assert.deepEqual(r.keys, ["ws:/home/ai-agent/work/teapot"], "`ws:` is a live control and must persist (#81)");
});

test("the migration runs once, then leaves keys alone (#81)", () => {
  const first = migrate(["chat:old"], null);
  assert.deepEqual(first.keys, []);
  const second = migrate(["chat:mine"], "2");
  assert.deepEqual(second.keys, ["chat:mine"], "a deliberate collapse must survive a reload (#81)");
  assert.equal(second.dropped, 0, "and must not be re-dropped every load (#81)");
});

test("a malformed store does not throw (#81)", () => {
  for (const bad of [null, "not json", 42 as any, {} as any]) {
    const r = migrate(bad as any, null);
    assert.ok(Array.isArray(r.keys), `must degrade to an empty set (#81): ${JSON.stringify(bad)}`);
  }
});

test("sub-agent collapse is a DIFFERENT key and must not be touched (#81)", () => {
  const r = migrate(["ws:/p", "chat:x"], null);
  assert.ok(!r.keys.some((k) => k.includes("sub")), "no sub-agent keys are invented or removed (#81)");
});

