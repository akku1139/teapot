/**
 * #105 — should a sub-agent inherit the parent's reasoning effort?
 *
 * ## What was wrong
 *
 * `spawnChildFor` (master.ts) passes the child `provider`, `model` and
 * `contextWindowTokens` from the parent's config — but omitted
 * `reasoningEffort`, while `addAgent` DOES apply it for ordinary agents ~200
 * lines earlier. So a parent's effort vanished silently on every spawn, and the
 * `spawn_agent` tool had no parameter with which to express one. The tool surface
 * was the real defect: nothing could be lost if nothing could be said.
 *
 * ## The precedence, and why
 *
 * Mirrors OpenAI Codex (`codex-rs/core/src/agent/child_config.rs`):
 *
 *     requested.or_else(configured_default).or(parent)
 *
 * Codex deliberately does NOT inherit by default, and its own test proves the
 * intent rather than my inferring it: parent at XHigh, spawn requests Low, and
 * the child runs at **Low**
 * (`codex-rs/core/tests/suite/subagent_notifications.rs`). Sub-agents are usually
 * narrow and cheap, so inheriting a parent's `high` across twenty trivial scouts
 * multiplies cost and latency for no gain.
 *
 * Claude Code is closed-source, so its behaviour is UNVERIFIED — not evidence of
 * absence either way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const master = readFileSync(new URL("../src/master.ts", import.meta.url), "utf8");
const tools = readFileSync(new URL("../src/agent/tools.ts", import.meta.url), "utf8");

/* ---------- the tool surface ---------- */

test("spawn_agent can express a reasoning effort (#105)", () => {
  assert.match(
    tools,
    /reasoning_effort:\s*\{\s*\n\s*type: "string",\s*\n\s*enum: \["minimal", "low", "medium", "high", "xhigh"\]/,
    "the spawn schema must accept an effort — its absence is why the value was silently lost (#105)",
  );
});

test("the spawn interface carries it through to master (#105)", () => {
  assert.match(
    tools,
    /spawn\(o:\s*\{[\s\S]{0,320}?reasoning_effort\?: string;/,
    "the SubAgents interface must pass it on (#105)",
  );
});

test("an invalid effort is rejected before it reaches the provider (#105)", () => {
  // a typo must not become an unrecognised API value
  assert.match(tools, /if \(effort && !isReasoningEffort\(effort\)\)/, "must be validated (#105)");
  assert.match(tools, /reasoning_effort must be minimal\|low/, "with a message naming the options (#105)");
});

/* ---------- the precedence chain ---------- */

test("effort resolves: spawn arg > config default > parent (#105)", () => {
  const at = master.indexOf("const childEffort =");
  assert.notEqual(at, -1, "the child effort must be resolved in one place (#105)");
  // the expression wraps onto a second line, so read a window rather than one line
  const line = master.slice(at, master.indexOf(";", at));
  assert.match(
    line,
    /o\.reasoning_effort\s*\|\|\s*this\.config\.defaultSubagentReasoningEffort\s*\|\|\s*pcfg\?\.reasoningEffort/,
    "the order must be spawn argument, then configured default, then parent (#105)",
  );
});

test("the child gets the resolved effort (#105)", () => {
  const at = master.indexOf("...(childEffort ? { reasoningEffort: childEffort } : {})");
  assert.notEqual(at, -1, "the resolved effort must reach addAgent (#105)");
  // and it sits among the other inherited fields, so it is persisted like them
  const block = master.slice(at - 400, at + 120);
  assert.match(block, /contextWindowTokens: pcfg\?\.contextWindowTokens/, "beside the other inherited fields (#105)");
});

test("the effort is NOT omitted the way it was (#105)", () => {
  // the original bug, pinned so it cannot come back
  const at = master.indexOf("const child = await this.addAgent(");
  assert.notEqual(at, -1, "the child config block must exist (#105)");
  const block = master.slice(at, at + 700);
  // the bug was the gap between `model` and `parent`, with nothing effort-shaped
  // in between. Pin that something effort-shaped IS there now.
  const between = block.slice(
    block.indexOf("model: pcfg?.model") + "model: pcfg?.model".length,
    block.indexOf("parent: parentId"),
  );
  assert.match(between, /reasoningEffort/, "effort must sit between model and parent (#105)");
});

/* ---------- the global backstop ---------- */

test("config carries a default subagent effort (#105)", () => {
  assert.match(
    master,
    /defaultSubagentReasoningEffort\?: ReasoningEffort;/,
    "a global backstop stops every sub-agent inheriting an expensive effort (#105)",
  );
});

/* ---------- the caveat the research raised ---------- */

test("supportedParameters still reaches the child (#105)", () => {
  // Without the catalogue's advertised capabilities, `effortForRequest()` drops
  // the field and the whole chain is a no-op — the effort would be stored and
  // never sent. `addAgent` resolves this for every agent it creates, so the child
  // gets it as long as it goes through `addAgent`.
  const at = master.indexOf("...(modelMeta?.supportedParameters");
  assert.notEqual(at, -1, "addAgent must resolve supportedParameters (#105)");
  const inAddAgent = master.lastIndexOf("async addAgent", at);
  assert.ok(inAddAgent !== -1 && at > inAddAgent, "it must be inside addAgent, so children get it too (#105)");
});
