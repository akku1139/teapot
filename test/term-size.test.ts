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

test("a resize during foreground output is deferred, never typed into the program (#20)", async () => {
  const t = new TermSizeTracker();
  const child = fakeChild();
  const seen: string[] = [];
  const write = (r: number, c: number) => seen.push(`${r}x${c}`);

  // an interactive program (vim/REPL) is producing output right now
  t.markBusy(child, 400);
  t.request(child, 40, 120, write);
  await sleep(TERM_RESIZE_DEBOUNCE_MS + 80);
  assert.deepEqual(seen, [], "must not type stty into a program that is running");

  // once it falls quiet the resize is applied
  await sleep(400);
  assert.deepEqual(seen, ["40x120"]);
  t.disposeAll();
});

test("forget() cancels a pending resize so it can't hit a dead child (#20)", async () => {
  const t = new TermSizeTracker();
  const child = fakeChild();
  const seen: string[] = [];
  t.request(child, 50, 200, (r, c) => seen.push(`${r}x${c}`));
  t.forget(child); // terminal closed mid-debounce
  await sleep(TERM_RESIZE_DEBOUNCE_MS + 80);
  assert.deepEqual(seen, [], "a closed terminal must not receive a late stty");
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