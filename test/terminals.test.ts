import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("spawns a real shell and a pty");
import {
  _resetTerminalsForTest,
  attachTerminal,
  closeTerminal,
  closeTerminalsFor,
  createTerminal,
  detachTerminal,
  forgetTerminalSize,
  listTerminals,
  reapIdleTerminals,
  resizeTerminal,
  setTerminalResize,
  writeTerminal,
} from "../src/server/terminals.ts";
import { resolvePtySlave } from "../src/server/term-size.ts";

function spyResize() {
  const calls: { rows: number; cols: number }[] = [];
  setTerminalResize(
    (_child, rows, cols) => calls.push({ rows, cols }),
    () => "/dev/pts/999", 
  );
  return calls;
}

test("a created terminal is listed and can be attached to", async () => {
  _resetTerminalsForTest();
  spyResize();
  const dir = mkdtempInRootSync("term-list");
  const r = createTerminal("a1", dir);
  assert.ok(r.ok);

  const listed = listTerminals();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, r.terminal.id);
  assert.equal(listed[0]!.agentId, "a1");
  assert.equal(listed[0]!.clients, 0);

  const sink = () => {};
  const at = attachTerminal(r.terminal.id, sink);
  assert.ok(at.ok);
  assert.equal(at.terminal.clients, 1);
  closeTerminal(r.terminal.id);
});

test("detaching leaves the shell ALIVE — that is what a reload does", async () => {
  _resetTerminalsForTest();
  spyResize();
  const dir = mkdtempInRootSync("term-detach");
  const r = createTerminal("a1", dir);
  assert.ok(r.ok);
  const sink = () => {};

  attachTerminal(r.terminal.id, sink);
  detachTerminal(r.terminal.id, sink);

  const after = listTerminals();
  assert.equal(after.length, 1, "detach must not remove the terminal");
  assert.equal(after[0]!.clients, 0);
  const re = attachTerminal(r.terminal.id, sink);
  assert.ok(re.ok, "re-attach after detach must work");
  closeTerminal(r.terminal.id);
});

test("replay returns the output a client missed while detached", async () => {
  _resetTerminalsForTest();
  spyResize();
  const dir = mkdtempInRootSync("term-replay");
  const r = createTerminal("a1", dir);
  assert.ok(r.ok);

  await waitFor(() => {
    const at = attachTerminal(r.terminal.id, () => {});
    return at.ok && at.replay.length > 0;
  });
  const at = attachTerminal(r.terminal.id, () => {});
  assert.ok(at.ok && at.replay.length > 0, "the replay buffer must hold the shell's output");
  closeTerminal(r.terminal.id);
});

test("the pty gets the SMALLEST size across attached clients", async () => {
  _resetTerminalsForTest();
  const calls = spyResize();
  const dir = mkdtempInRootSync("term-size");
  const r = createTerminal("a1", dir);
  assert.ok(r.ok);

  const big = () => {};
  const small = () => {};
  resizeTerminal(r.terminal.id, big, 60, 200);
  resizeTerminal(r.terminal.id, small, 24, 80);

  const last = calls.at(-1);
  assert.deepEqual(last, { rows: 24, cols: 80 }, "the narrowest client must win");

  forgetTerminalSize(r.terminal.id, big);
  const afterLeave = calls.at(-1);
  assert.deepEqual(afterLeave, { rows: 24, cols: 80 });

  detachTerminal(r.terminal.id, small);
  forgetTerminalSize(r.terminal.id, small);
  assert.deepEqual(calls.at(-1), { rows: 24, cols: 80 });
  closeTerminal(r.terminal.id);
});

test("input reaches the shell, so a keystroke runs a command", async () => {
  _resetTerminalsForTest();
  spyResize();
  const dir = mkdtempInRootSync("term-input");
  const r = createTerminal("a1", dir);
  assert.ok(r.ok);

  let seen = "";
  attachTerminal(r.terminal.id, (m) => {
    if (m.kind === "data") seen += m.data;
  });
  assert.equal(writeTerminal(r.terminal.id, "echo teapot-$((6*7))\n"), true);

  await waitFor(() => seen.includes("teapot-42"));
  closeTerminal(r.terminal.id);
});

test("closing is per agent and reports the count", async () => {
  _resetTerminalsForTest();
  spyResize();
  const dir = mkdtempInRootSync("term-close");
  createTerminal("a1", dir);
  createTerminal("a1", dir);
  createTerminal("a2", dir);
  assert.equal(listTerminals().length, 3);

  assert.equal(closeTerminalsFor("a1"), 2);
  const rest = listTerminals();
  assert.equal(rest.length, 1);
  assert.equal(rest[0]!.agentId, "a2");
  closeTerminal(rest[0]!.id);
});

test("the per-agent cap refuses the eleventh shell", async () => {
  _resetTerminalsForTest();
  spyResize();
  const dir = mkdtempInRootSync("term-cap");
  for (let i = 0; i < 10; i++) {
    assert.equal(createTerminal("a1", dir).ok, true, `shell ${i + 1} should be allowed`);
  }
  const over = createTerminal("a1", dir);
  assert.equal(over.ok, false);
  assert.equal(createTerminal("a2", dir).ok, true);
  closeTerminalsFor("a1");
  closeTerminalsFor("a2");
});

test("an idle terminal is reaped, a held one is not", async () => {
  _resetTerminalsForTest();
  spyResize();
  const dir = mkdtempInRootSync("term-reap");
  const idle = createTerminal("a1", dir);
  const held = createTerminal("a2", dir);
  assert.ok(idle.ok && held.ok);

  attachTerminal(held.terminal.id, () => {});
  const later = Date.now() + 7 * 60 * 60 * 1000;
  reapIdleTerminals(later);

  const left = listTerminals();
  assert.equal(left.length, 1, "only the unattended terminal should be reaped");
  assert.equal(left[0]!.id, held.terminal.id);
  closeTerminal(held.terminal.id);
});

test("a real pty reports the size it was given, without stty text in the stream", { skip: !hasProc() }, async () => {
  _resetTerminalsForTest();
  setTerminalResize(
    (child, rows, cols) => {
      const slave = resolvePtySlave(child);
      if (!slave) return;
      spawnSyncStty(slave, rows, cols);
    },
    resolvePtySlave,
  );
  const dir = mkdtempInRootSync("term-real");
  const r = createTerminal("a1", dir);
  assert.ok(r.ok);

  let seen = "";
  attachTerminal(r.terminal.id, (m) => {
    if (m.kind === "data") seen += m.data;
  });

  writeTerminal(r.terminal.id, "stty size\n");
  await waitFor(() => /\d+\s+\d+/.test(seen.replace(/\r/g, "")));

  resizeTerminal(r.terminal.id, () => {}, 55, 190);
  seen = "";
  writeTerminal(r.terminal.id, "stty size\n");
  await waitFor(() => seen.includes("55 190"));

  assert.ok(seen.includes("55 190"), `shell should report the new size, got: ${seen}`);
  assert.ok(
    !/stty rows \d+ cols \d+/.test(seen),
    "the size must be an ioctl, never text typed into the shell",
  );
  closeTerminal(r.terminal.id);
});

function spawnSyncStty(slave: string, rows: number, cols: number): void {
  spawnSync("stty", ["-F", slave, "rows", String(rows), "cols", String(cols)], {
    stdio: "ignore",
  });
}

function hasProc(): boolean {
  try {
    const tid = readdirSync("/proc/self/task")[0];
    return !!tid && existsSync(`/proc/self/task/${tid}/children`);
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.fail("condition not met within the deadline");
}

test("a client size that arrives BEFORE the seed wins — the seed must stand down (#172)", async () => {
  _resetTerminalsForTest();
  const calls: { rows: number; cols: number }[] = [];
  setTerminalResize(
    (_child, rows, cols) => calls.push({ rows, cols }),
    () => "/dev/pts/999",
  );
  const dir = mkdtempInRootSync("term-seedrace");
  const r = createTerminal("a1", dir);
  assert.ok(r.ok);

  const sink = () => {};
  attachTerminal(r.terminal.id, sink);
  resizeTerminal(r.terminal.id, sink, 55, 190);

  await new Promise((res) => setTimeout(res, 150));

  assert.ok(calls.length >= 1, "the seed must have run, or this proves nothing");
  const last = calls.at(-1)!;
  assert.deepEqual(
    last,
    { rows: 55, cols: 190 },
    "the client's size must be the FINAL one — a seed that lands after it leaves a running " +
      "program (nano) at the wrong geometry until the tab is reopened",
  );
  closeTerminal(r.terminal.id);
});
