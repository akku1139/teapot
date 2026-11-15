/**
 * After a compaction the usage figure is an ESTIMATE, and the line says so (#249).
 *
 * The provider's count describes the history that was just rewritten, so it has to go — but what replaces it is our estimate,
 * and the model reads that number as fact. MEASURED behaviour from the report: a model that had just been compacted still
 * reasoned "context is at 75%, near auto-compaction" and announced it in prose, because the number in front of it did not
 * match the impression it had formed before the pass ("compact後にサボる原因これじゃね?" / "まだ勘違いされてそう").
 */
import test from "node:test";
import assert from "node:assert/strict";
import { usageLine } from "../src/agent/context-claim.ts";
import { readFileSync } from "node:fs";

test("the usage line names every number once (the contract the model reads)", () => {
  const line = usageLine(15_000, 750_000, 1_000_000);
  assert.match(line, /15k\/1000k tokens/, "used against the real window");
  assert.match(line, /auto-compacts at 750k/, "the threshold, named");
  assert.match(line, /735k until auto-compaction/, "and the room left before it");
});

test("the session notice marks a post-compaction figure as an estimate (#249)", () => {
  const src = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
  // the flag exists, is set where the provider count is dropped, and is printed with the line
  assert.match(src, /usageIsEstimated = true/, "a compaction must mark the figure as estimated");
  assert.match(src, /estimated, not the provider's count/, "and the line must say so");
  assert.match(src, /usageIsEstimated = false/, "a real provider count clears the flag");
});
