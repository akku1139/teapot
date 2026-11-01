import assert from "node:assert/strict";
import test from "node:test";
import { MEMORY_DUMP_LIMIT } from "../src/agent/agent.ts";

test("a no-query read_memory dumps a bounded slice, not tens of KB", () => {
  /**
   * "memoryのレスポンスとか" — `read_memory()` with no query returned the entire file, and memory.md is
   * allowed to reach 32_000 chars, so one call could put ~32KB of notes into the transcript. The system
   * prompt already carries a digest, so the unfiltered dump buys nothing that a query cannot.
   *
   * The cap must still be useful: large enough to hold a few real notes, and never larger than the file
   * limit the writer enforces.
   */
  assert.ok(MEMORY_DUMP_LIMIT > 0, "a cap of 0 would make read_memory() useless");
  assert.ok(MEMORY_DUMP_LIMIT >= 4_000, `too small to hold a few notes: ${MEMORY_DUMP_LIMIT}`);
  assert.ok(MEMORY_DUMP_LIMIT <= 32_000, "32_000 is what the writer keeps, so a larger cap can never trigger");
});
