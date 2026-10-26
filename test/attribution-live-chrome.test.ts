import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwnLiveWork } from "../frontend/lib/live-buffer.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("runs POSIX commands through the bash tool");

function expand(rows: { type: string; data?: any }[]): { type: string; data?: any }[] {
  const out: { type: string; data?: any }[] = [];
  for (const e of rows) {
    if (e.type === "sub") {
      const d = e.data as { sub?: string; type?: string; data?: any };
      const kind = String(d?.type ?? "message");
      if (kind === "state") continue; 
      out.push({ ...e, type: kind, data: { ...d?.data, actor: d?.sub } });
    } else out.push(e);
  }
  return out;
}

function mixedLog() {
  return [
    { id: "e1", type: "prompt", data: { source: "user", text: "go" } },
    { id: "e2", type: "message", data: { role: "assistant", content: "PARENT TEXT" } },
    { id: "e3", type: "sub", data: { sub: "kid", type: "message", data: { role: "assistant", content: "CHILD TEXT" } } },
    { id: "e4", type: "sub", data: { sub: "kid", type: "tool_call", data: { name: "bash", args: { command: "ls" } } } },
  ];
}

test("a legacy `sub` row is not the selected agent's own live work (#40, #63)", () => {
  const rows = expand(mixedLog()); 
  const own = rows.map(isOwnLiveWork);
  assert.deepEqual(
    own,
    [true, true, false, false],
    `the parent's own rows stay live; a child's do not (#40): ${JSON.stringify(own)}`,
  );
});

test("the gate is no longer a no-op on a REAL feed (#40)", () => {
  const rows = expand(mixedLog());
  const own = rows.map(isOwnLiveWork);
  assert.ok(
    own.some((v) => v === true) && own.some((v) => v === false),
    `the gate must answer BOTH ways on this fixture, or it decides nothing (#40/#141); got ${JSON.stringify(own)}`,
  );
  assert.equal(isOwnLiveWork({ data: { actor: "kid" } }), false, "an actor means NOT own work (#40)");
  assert.equal(isOwnLiveWork({ data: {} }), true, "no actor means own work (#40)");
  assert.equal(isOwnLiveWork({ data: { actor: "" } }), true, "an empty actor is not an attribution (#40)");
  assert.equal(isOwnLiveWork(null), false, "a null row is not own work (#40)");
});

test("the child state churn is still filtered out (#40)", () => {
  const rows = expand([
    { type: "sub", data: { sub: "kid", type: "state", data: { from: "running", to: "idle" } } },
    { type: "sub", data: { sub: "kid", type: "message", data: { content: "kept" } } },
  ]);
  assert.deepEqual(rows.map((r) => r.type), ["message"], "child state must not render (#40)");
});

test("a mirrored row with no type defaults to a message (#40)", () => {
  const rows = expand([{ type: "sub", data: { sub: "kid" } }]);
  assert.equal(rows[0]!.type, "message", "the master always sets a type, but be safe (#40)");
  assert.equal(rows[0]!.data.actor, "kid");
});

