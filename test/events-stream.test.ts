import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { readEvents } from "../src/log/events.ts";


test("a large log is parsed without holding the file text and its lines (#burst)", async () => {
  /**
   * MEASURED on the operator's server: `master rss 1034.4MB · heap 599.1MB` during a burst, `heap 248.2MB` a moment
   * later — a transient allocation GC could reclaim. `readEvents` used to read the ENTIRE file into one string and
   * `.split("\n")` it, so a 90k-event session paid for the file bytes, one string per line, and the parsed objects at
   * the same time. The values are asserted, not the mechanism: streaming must produce the same events.
   */
  const dir = mkdtempInRootSync("ev-stream");
  const file = path.join(dir, "chat.jsonl");
  const lines: string[] = [];
  for (let i = 1; i <= 5000; i++) {
    lines.push(JSON.stringify({ id: `e${i}`, seq: i, ts: "2026-01-01T00:00:00Z", branch: "br0", type: "message", data: { content: `line ${i} ` + "x".repeat(200) } }));
  }
  lines.push("{ this line is not json");
  writeFileSync(file, `${lines.join("\n")}\n`);

  const events = await readEvents(file);
  assert.equal(events.length, 5000, "every valid line is parsed and the broken one is skipped");
  assert.equal(events[0]?.id, "e1");
  assert.equal(events.at(-1)?.id, "e5000");
  assert.equal(events[1234]?.seq, 1235, "order is preserved");
});
