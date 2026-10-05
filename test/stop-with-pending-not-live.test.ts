/**
 * #133 — "when there is a pending message, pressing stop from the controls leaves
 * the agent stopped but the controls keep showing the stop button (it should be
 * start). Reloading the page does not help either."
 *
 * ## Cause
 *
 * `isLive()` counted queued prompts, and `stop()` — correctly, per #9 — does not
 * discard them. So after a stop with anything queued the two combined to leave
 * `live` true indefinitely:
 *
 *     after stop : status = stopped   live = true   pendingPrompts = 1
 *
 * `status` was right, so nothing looked wrong server-side, and `live` is the one
 * field the single toggle button reads:
 *
 *     onclick={isSelLive() ? act("/stop") : act("/start")}   (the composer control)
 *
 * so the button stayed "■ stop". Pressing it again was a no-op — the agent was
 * already stopped — and a reload could not help, because the state was real, not
 * a stale render.
 *
 * ## The conflict with #59
 *
 * #59 asserted a stopped agent with queued prompts reads LIVE, reasoning that the
 * user must be able to "stop/clear" it. But `live` drives that one toggle, and a
 * stopped agent pressing stop is a no-op — so that reasoning made the control
 * unusable. #59's real requirement, WITHDRAWABILITY, is met independently by the
 * ✕ on the row, which posts to /prompt/cancel and never reads `isSelLive`.
 *
 * So the queued prompts are still held (#9) and still withdrawable (#59); only the
 * toggle is corrected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/agent.ts";
import { mkdtempSync } from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readSource(path.join(here, "..", "frontend", "App.tsx"));

/** an agent parked mid-LLM-call with a second prompt queued behind it */
async function stopWithPending() {
  const ws = mkdtempSync(path.join(os.tmpdir(), "t133w-"));
  const sd = mkdtempSync(path.join(os.tmpdir(), "t133s-"));
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let n = 0;
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => {
      n++;
      if (n <= 1) await gate;
      return { message: { role: "assistant" as const, content: "ok" } };
    },
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  await a.setGoal("g");
  a.enqueuePrompt("first", "user");
  a.start("t");
  await new Promise((r) => setTimeout(r, 150));
  a.enqueuePrompt("queued behind", "user"); // stays pending
  const before = a.snapshot();
  a.stop("user pressed stop");
  release();
  await new Promise((r) => setTimeout(r, 600));
  return { a, before, after: a.snapshot() };
}

test("a stop with prompts queued is NOT live (#133)", async () => {
  const { before, after } = await stopWithPending();
  assert.equal(before.live, true, "precondition: live while working (#133)");
  assert.equal(after.status, "stopped", "precondition: the stop took (#133)");
  assert.equal(
    after.live,
    false,
    `a stopped agent must not read live (#133); live=${after.live} pending=${after.pendingPrompts}`,
  );
});

test("the queued prompts are KEPT, not discarded (#9, #133)", async () => {
  // #9 settled that a stop must neither deliver nor silently discard them. The
  // fix corrects the toggle, not the queue.
  const { after } = await stopWithPending();
  assert.equal(after.pendingPrompts, 1, "the queued prompt survives the stop (#9)");
});

test("a start consumes the queued prompt and goes live again (#133)", async () => {
  // #126: sampling 150ms after start() was a probe error, not a product one — the
  // turn completes in single-digit milliseconds here, so `live` was already false
  // again and the test read as a failure. What matters is that the queued prompt is
  // CONSUMED and the agent runs a turn: assert that, not a momentary flag.
  const ws = mkdtempSync(path.join(os.tmpdir(), "t133x-"));
  const sd = mkdtempSync(path.join(os.tmpdir(), "t133y-"));
  let calls = 0;
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => {
      calls++;
      return { message: { role: "assistant" as const, content: "ok" } };
    },
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  await a.setGoal("g");
  a.enqueuePrompt("first", "user");
  a.start("t");
  await a.settled();
  assert.equal(calls, 1, "precondition: one turn ran (#133)");
  a.enqueuePrompt("queued while stopped", "user");
  a.stop("stop");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(a.snapshot().live, false, "precondition: stopped and not live (#133)");
  assert.equal(a.snapshot().pendingPrompts, 1, "precondition: it is still queued (#133)");
  try {
    a.start("user pressed start");
    await a.settled();
    assert.equal(calls, 2, "start must run the queued prompt (#133)");
    assert.equal(a.snapshot().pendingPrompts, 0, "and drain the queue (#133)");
  } finally {
    a.stop("done");
    await a.settled().catch(() => {});
  }
});

test("withdrawal does not depend on isLive (#59, #133)", async () => {
  // #59's real requirement is that a held prompt be withdrawable. That is the ✕ on
  // the row, gated on source/pending/promptId — NOT on `isSelLive`, so correcting
  // the toggle cannot have broken it.
  const at = app.indexOf("onCancel={");
  assert.notEqual(at, -1, "the withdraw affordance must exist (#59)");
  // #126: a 400-char window contained neither string, and bounding by `onResize`
  // made it WORSE — `onResize` appears BEFORE `onCancel`, so the window was
  // negative. Take a fixed 1200 forward from the handler.
  const block = app.slice(at, at + 1200);
  assert.doesNotMatch(
    block,
    /isSelLive\(\)/,
    "the ✕ must not consult isLive — it withdrew while the agent was stopped (#59/#133)",
  );
  assert.match(block, /prompt\/cancel/, "it uses its own endpoint (#59/#133)");
});

test("the toggle reads isSelLive, which is the one field at issue (#133)", async () => {
  // pins WHY isLive mattered: one button, two meanings
  assert.match(
    app,
    /onclick=\{isSelLive\(\) \? act\("\/stop"\) : act\("\/start"\)\}/,
    "the control button is driven solely by isSelLive (#133)",
  );
});
