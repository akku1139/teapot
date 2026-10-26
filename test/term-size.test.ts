import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import {
  applyPtySize,
  TermSizeTracker,
  TERM_RESIZE_DEBOUNCE_MS,
} from "../src/server/term-size.ts";

const fakeChild = (): ChildProcess => ({}) as ChildProcess;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a resize burst collapses into a single stty (#20)", async () => {
  const t = new TermSizeTracker();
  const child = fakeChild();
  const seen: string[] = [];
  const write = (r: number, c: number) => seen.push(`${r}x${c}`);

  for (let i = 0; i < 10; i++) {
    t.request(child, 20 + i, 80 + i, write);
    await sleep(5);
  }
  assert.deepEqual(seen, [], "nothing may be written while the burst is in flight");

  await sleep(TERM_RESIZE_DEBOUNCE_MS + 80);
  assert.deepEqual(seen, ["29x89"], "exactly one stty, for the final size");
  t.disposeAll();
});

test("resizing to the size already applied writes nothing (#20)", async () => {
  const t = new TermSizeTracker();
  const child = fakeChild();
  const seen: string[] = [];
  const write = (r: number, c: number) => seen.push(`${r}x${c}`);

  t.request(child, 30, 100, write);
  await sleep(TERM_RESIZE_DEBOUNCE_MS + 80);
  assert.deepEqual(seen, ["30x100"]);

  t.request(child, 30, 100, write);
  t.request(child, 30, 100, write);
  await sleep(TERM_RESIZE_DEBOUNCE_MS + 80);
  assert.deepEqual(seen, ["30x100"], "no duplicate stty for a no-op resize");
  t.disposeAll();
});

test("a resize lands even while a program is streaming output (#172)", async () => {
  const t = new TermSizeTracker();
  const child = fakeChild();
  const seen: string[] = [];
  t.request(child, 40, 120, (r, c) => seen.push(`${r}x${c}`));
  await sleep(TERM_RESIZE_DEBOUNCE_MS + 80);
  assert.deepEqual(seen, ["40x120"], "a size change must apply without waiting for quiet");
  t.disposeAll();
});

test("two terminals of one agent keep independent sizes (#20)", async () => {
  const t = new TermSizeTracker();
  const a = fakeChild();
  const b = fakeChild();
  const seenA: string[] = [];
  const seenB: string[] = [];

  t.request(a, 24, 80, (r, c) => seenA.push(`${r}x${c}`));
  t.request(b, 60, 200, (r, c) => seenB.push(`${r}x${c}`));
  await sleep(TERM_RESIZE_DEBOUNCE_MS + 80);

  assert.deepEqual(seenA, ["24x80"]);
  assert.deepEqual(seenB, ["60x200"]);
  t.request(a, 24, 80, (r, c) => seenA.push(`${r}x${c}`));
  await sleep(TERM_RESIZE_DEBOUNCE_MS + 80);
  assert.deepEqual(seenA, ["24x80"]);
  assert.deepEqual(seenB, ["60x200"]);
  t.disposeAll();
});
import { spawn } from "node:child_process";
import { resolvePtySlave } from "../src/server/term-size.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("spawns `script` to obtain a real pty");

test("resolvePtySlave finds the pty behind a `script`-wrapped shell (#20)", async () => {
  const child = spawn("script", ["-qec", "sleep 5", "/dev/null"], { stdio: "pipe" });
  try {
    let slave: string | null = null;
    for (let i = 0; i < 40 && !slave; i++) {
      await sleep(50);
      slave = resolvePtySlave(child);
    }
    assert.ok(slave, "a `script`-wrapped shell must expose a pty slave");
    assert.match(slave!, /^\/dev\/pts\/\d+$/, `expected a pts device, got ${slave}`);
    assert.ok(!/pipe:|\/dev\/null/.test(slave!), `resolved a non-device: ${slave}`);
  } finally {
    child.kill("SIGKILL");
  }
});

test("resolvePtySlave returns null for a plain pipe — never a bogus path (#20)", () => {
  const child = spawn("/bin/sh", ["-c", "sleep 5"], { stdio: "pipe" });
  try {
    assert.equal(resolvePtySlave(child), null, "a piped child has no pty device");
  } finally {
    child.kill("SIGKILL");
  }
});

test("applying a size never writes to stdin — it is stty -F on the pty device", async () => {
  const executed: { cmd: string; args: string[] }[] = [];
  const fakeSpawn = ((cmd: string, args: string[]) => {
    executed.push({ cmd, args });
    return { on: () => {}, kill: () => {} };
  }) as unknown as typeof import("node:child_process").spawn;

  const child = spawn("script", ["-qec", "sleep 5", "/dev/null"], { stdio: "pipe" });
  try {
    let slave: string | null = null;
    for (let i = 0; i < 40 && !slave; i++) {
      await sleep(50);
      slave = resolvePtySlave(child);
    }
    assert.ok(slave, "precondition: the pty must resolve, or this proves nothing");

    const applied = applyPtySize(child, 40, 120, fakeSpawn);
    assert.equal(applied, true, "a resolvable pty must be resized");
    assert.equal(executed.length, 1);
    assert.equal(executed[0]!.cmd, "stty");
    assert.deepEqual(executed[0]!.args.slice(0, 2), ["-F", slave]);
  } finally {
    child.kill("SIGKILL");
  }
});

test("an unresolvable pty does NOTHING rather than typing into the terminal", async () => {
  const executed: string[] = [];
  const fakeSpawn = ((cmd: string) => {
    executed.push(cmd);
    return { on: () => {}, kill: () => {} };
  }) as unknown as typeof import("node:child_process").spawn;
  const child = { pid: 0, stdin: { writable: true } } as unknown as import("node:child_process").ChildProcess;
  const applied = applyPtySize(child, 40, 120, fakeSpawn);
  assert.equal(applied, false, "nothing to apply to");
  assert.deepEqual(executed, [], "nothing may be spawned — and nothing typed");
});
