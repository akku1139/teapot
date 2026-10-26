import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

import path from "node:path";
import { EventLog } from "../src/log/events.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

async function reloadMisses(n: number): Promise<{ seen: number; missed: number; log: EventLog; file: string }> {
  const dir = mkdtempInRootSync("s54-");
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
  const dir = mkdtempInRootSync("s54b-");
  const file = path.join(dir, "chat.jsonl");
  const log = new EventLog(file, "a");
  await log.load();
  let ordered = true;
  log.onEvent = (e) => {
    const txt = readFileSync(file, "utf8");
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
  const dir = mkdtempInRootSync("s54c-");
  const log = new EventLog(path.join(dir, "chat.jsonl"), "a");
  await log.load();
  let notified = 0;
  log.onEvent = () => {
    notified++;
  };
  await log.close(); 
  await log.append("message", "s", "br0", { role: "assistant", content: "x" });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(notified, 0, "a dropped write must not notify (#54)");
});

test("the observer still cannot break the log (#54)", async () => {
  const dir = mkdtempInRootSync("s54d-");
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