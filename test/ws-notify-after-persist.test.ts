/**
 * #54 — the WebSocket notified the frontend BEFORE the event reached disk, so the
 * reload it triggered could not see it.
 *
 * ## The mechanism
 *
 * The design is deliberate: the frontend treats a `kind:"event"` frame as
 * "something changed, re-read `/events`" rather than as timeline data. That is a
 * sound choice — it means one code path builds the timeline.
 *
 * But `EventLog.append()` used to call `onEvent` BEFORE queueing the write:
 *
 *     lastByBranch.set(...)
 *     onEvent(evt)          <- frontend re-reads /events NOW
 *     stream.write(...)     <- the event reaches disk AFTER
 *
 * So the reload raced the write. Measured against a real EventLog, reloading on
 * every notification:
 *
 *     appends: 30   reloads that MISSED the event: 30
 *
 * The 120ms debounce hides this most of the time, which is exactly why #54 felt
 * random rather than reproducible: a slow write misses, a fast one lands. The
 * rows that vanish are the ones written slowly.
 *
 * ## The fix
 *
 * Write first, then notify. The observer is called once the write is handed to
 * the OS, so any read it triggers can see the event.
 *
 * A failed write deliberately does NOT notify: the event is not on disk, and
 * announcing it would tell the frontend to reload for something that will never
 * appear.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog } from "../src/log/events.ts";

/** open a log, reload on every notification, count the reloads that miss */
async function reloadMisses(n: number): Promise<{ seen: number; missed: number; log: EventLog; file: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "s54-"));
  const file = path.join(dir, "chat.jsonl");
  const log = new EventLog(file, "a");
  await log.load();
  let seen = 0;
  let missed = 0;
  log.onEvent = async (e) => {
    seen++;
    const txt = await readFile(file, "utf8").catch(() => "");
    if (!txt.includes(e.id)) missed++;
  };
  for (let i = 0; i < n; i++)
    await log.append("message", "s", "br0", { role: "assistant", content: `m${i}` });
  await new Promise((r) => setTimeout(r, 300));
  return { seen, missed, log, file };
}

test("a notified event is already readable (#54)", async () => {
  const { seen, missed, log } = await reloadMisses(30);
  try {
    assert.equal(seen, 30, "precondition: every append notified (#54)");
    assert.equal(
      missed,
      0,
      `every notified event must be readable by the reload it triggers (#54); ${missed}/${seen} missed`,
    );
  } finally {
    await log.close();
  }
});

test("notification happens after the write, not before (#54)", async () => {
  // the invariant, stated directly rather than only through the reload
  const dir = mkdtempSync(path.join(os.tmpdir(), "s54b-"));
  const file = path.join(dir, "chat.jsonl");
  const log = new EventLog(file, "a");
  await log.load();
  let ordered = true;
  log.onEvent = async (e) => {
    const txt = await readFile(file, "utf8").catch(() => "");
    if (!txt.includes(e.id)) ordered = false;
  };
  await log.append("message", "s", "br0", { role: "assistant", content: "x" });
  await new Promise((r) => setTimeout(r, 150));
  try {
    assert.equal(ordered, true, "onEvent must fire after the event is on disk (#54)");
  } finally {
    await log.close();
  }
});

test("a failed write does NOT notify (#54)", async () => {
  // announcing an event that is not on disk would tell the frontend to reload
  // for something that will never appear
  const dir = mkdtempSync(path.join(os.tmpdir(), "s54c-"));
  const log = new EventLog(path.join(dir, "chat.jsonl"), "a");
  await log.load();
  let notified = 0;
  log.onEvent = () => {
    notified++;
  };
  await log.close(); // stream is null: appends are dropped, not written
  await log.append("message", "s", "br0", { role: "assistant", content: "x" });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(notified, 0, "a dropped write must not notify (#54)");
});

test("the observer still cannot break the log (#54)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "s54d-"));
  const file = path.join(dir, "chat.jsonl");
  const log = new EventLog(file, "a");
  await log.load();
  log.onEvent = () => {
    throw new Error("observer exploded");
  };
  await assert.doesNotReject(
    log.append("message", "s", "br0", { role: "assistant", content: "x" }),
    "a throwing observer must not fail the append (#54)",
  );
  const txt = await readFile(file, "utf8");
  assert.ok(txt.includes("x"), "and the event must still be written (#54)");
  await log.close();
});