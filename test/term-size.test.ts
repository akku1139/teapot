import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import {
  TermSizeTracker,
  TERM_RESIZE_DEBOUNCE_MS,
} from "../src/server/term-size.ts";

/** a stand-in for ChildProcess — the tracker only ever uses identity */
const fakeChild = (): ChildProcess => ({}) as ChildProcess;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a resize burst collapses into a single stty (#20)", async () => {
  const t = new TermSizeTracker();
  const child = fakeChild();
  const seen: string[] = [];
  const write = (r: number, c: number) => seen.push(`${r}x${c}`);

  // simulate a drag: many resize events in quick succession
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

  // same size again → a shell would gain nothing from a second stty
  t.request(child, 30, 100, write);
  t.request(child, 30, 100, write);
  await sleep(TERM_RESIZE_DEBOUNCE_MS + 80);
  assert.deepEqual(seen, ["30x100"], "no duplicate stty for a no-op resize");
  t.disposeAll();
});

test("a resize lands even while a program is streaming output (#172)", async () => {
  // The busy-deferral existed for the OLD mechanism, which typed `stty rows R cols C`
  // into the child's stdin: during output that text landed inside vim/nano. The size
  // is now an ioctl on the pty DEVICE, so a streaming program is no reason to wait —
  // and waiting is exactly what broke resizing in nano: an editor redraws
  // continuously, so the busy window never expired and the resize NEVER applied
  // (#172: "nanoとか開いたらリサイズ効いてない").
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
  // a no-op resize on A must not disturb B
  t.request(a, 24, 80, (r, c) => seenA.push(`${r}x${c}`));
  await sleep(TERM_RESIZE_DEBOUNCE_MS + 80);
  assert.deepEqual(seenA, ["24x80"]);
  assert.deepEqual(seenB, ["60x200"]);
  t.disposeAll();
});
/*
 * ============================================================================
 * #20 follow-up: the size must be applied to the pty DEVICE, not typed into it.
 *
 * The old sink wrote `stty rows R cols C\n` into the child's stdin. That is only
 * safe while a SHELL is reading stdin: when an interactive program owns the tty
 * (vim, less, a REPL) the PROGRAM reads it, so the line arrived as keystrokes and
 * landed in the operator's document. The tracker's debounce/busy-defer existed to
 * make that text rare, not harmless.
 *
 * `resolvePtySlave` finds the device so the caller can ioctl it instead
 * (`stty -F`). MEASURED against a real pty: setting the size that way moves the
 * size (readback 55 190) and delivers a real SIGWINCH, with ZERO bytes entering
 * the terminal stream — the mechanism VS Code (node-pty) and Alacritty use.
 *
 * This is the part that can be asserted without a terminal: the resolution itself
 * is where the first attempt went wrong (it read the spawned child's fd 0, which
 * is one of OUR PIPES, not the pty `script` forked onto).
 * ============================================================================
 */
import { spawn } from "node:child_process";
import { resolvePtySlave } from "../src/server/term-size.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

// needs a POSIX shell, `script` and a real pty
markPosixOnly("spawns `script` to obtain a real pty");

test("resolvePtySlave finds the pty behind a `script`-wrapped shell (#20)", async () => {
  // `script` is spawned with PIPED stdio (the server must read its output), so its
  // own fd 0 is a pipe and fd 1/2 are pipes too — the pty is only reachable via
  // the shell it forks. Reading fd 0 of the child we spawned is exactly the wrong
  // answer, and it is what made the first attempt fall back to typing `stty`.
  const child = spawn("script", ["-qec", "sleep 5", "/dev/null"], { stdio: "pipe" });
  try {
    // the pty exists only once `script` has forked
    let slave: string | null = null;
    for (let i = 0; i < 40 && !slave; i++) {
      await sleep(50);
      slave = resolvePtySlave(child);
    }
    assert.ok(slave, "a `script`-wrapped shell must expose a pty slave");
    assert.match(slave!, /^\/dev\/pts\/\d+$/, `expected a pts device, got ${slave}`);
    // and it must NOT be one of our pipes: `pipe:[…]` is not ioctl-able, which is
    // the failure that silently degraded this back to typing into the shell
    assert.ok(!/pipe:|\/dev\/null/.test(slave!), `resolved a non-device: ${slave}`);
  } finally {
    child.kill("SIGKILL");
  }
});

test("resolvePtySlave returns null for a plain pipe — never a bogus path (#20)", () => {
  // the fallback spawn (no `script` on the host) has no pty at all, and a resize
  // must degrade to the stdin write rather than try to ioctl a pipe
  const child = spawn("/bin/sh", ["-c", "sleep 5"], { stdio: "pipe" });
  try {
    assert.equal(resolvePtySlave(child), null, "a piped child has no pty device");
  } finally {
    child.kill("SIGKILL");
  }
});
