/**
 * #126 — three corrections to the #54 write-before-notify fix.
 *
 * The fix itself was right. These are the problems it introduced or failed to
 * catch, all confirmed by measurement rather than argument.
 *
 * ## 1. The regression test could not prove what it claimed
 *
 * The original test sampled the log with ASYNC `readFile` inside the observer:
 *
 *     log.onEvent = async (e) => { const txt = await readFile(file, …); … }
 *
 * `await` yields, so the write can land *during* the yield and the OLD
 * implementation would still pass. Measured against the old code:
 *
 *     async observer : 1 of 4 tests fail   <- barely detects the bug
 *     sync observer  : 5 of 5 tests fail   <- actually detects it
 *
 * `readFileSync` samples at the instant `onEvent` runs, which is the property
 * under test. This is the same "verify the thing you changed" mistake the Windows
 * CI caught in a regex.
 *
 * ## 2. `onEvent` became async — and it carried CONTROL FLOW
 *
 * The change was not only a timing adjustment. `wait_children` wakeups ran
 * through `EventLog.onEvent`, so after the fix they waited on the WRITE:
 *
 *     child settles -> log.append(state) -> write -> onEvent -> onChildEvent
 *     -> wakeParentWaiters
 *
 * Measured with every write failing (`ENOSPC`):
 *
 *     onEvent fired: 0     => the parent never wakes
 *
 * So disk latency or failure became control flow. `setStatus` now fires
 * `onControlStatusChange` FIRST and independently — a status change is control
 * flow, not an observation of one.
 *
 * ## 3. A comment asserted a contract that no longer held
 *
 * `agent.ts` still said "log.append fires onEvent synchronously". That became
 * false with the previous commit, and it was load-bearing: the note explained why
 * the status field is updated BEFORE the append.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { readFileSync } from "node:fs";
import { Agent } from "../src/agent/agent.ts";
import { EventLog } from "../src/log/events.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

/* ---------- 1. the ordering test must be synchronous ---------- */

test("onEvent sees the event ALREADY on disk, sampled synchronously (#126)", async () => {
  const dir = mkdtempInRootSync("s126a-");
  const file = path.join(dir, "chat.jsonl");
  const log = new EventLog(file, "a");
  await log.load();
  let ordered = true;
  log.onEvent = (e) => {
    // SYNCHRONOUS: no await may sit between onEvent and the read, or the write
    // can complete during the yield and the old code would still pass
    if (!readFileSync(file, "utf8").includes(e.id)) ordered = false;
  };
  await log.append("message", "s", "br0", { role: "assistant", content: "x" });
  await new Promise((r) => setTimeout(r, 150));
  try {
    assert.equal(ordered, true, "onEvent must fire after persistence (#126)");
  } finally {
    await log.close();
  }
});

/* ---------- 2. control flow must not depend on persistence ---------- */

test("a status change fires the control plane with EVERY WRITE FAILING (#126)", async () => {
  const dir = mkdtempInRootSync("s126b-");
  const a = new Agent({
    id: "child",
    workspace: dir,
    sessionDir: dir,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  let control = 0;
  a.onControlStatusChange = () => {
    control++;
  };
  // a full disk / revoked handle: the event plane cannot deliver, and a parent's
  // wait_children must still be woken
  (a.log as unknown as { stream: unknown }).stream = {
    write(_d: unknown, _e: unknown, cb: (e: Error) => void) {
      cb(new Error("ENOSPC: no space left on device"));
    },
    on() {},
  };
  (a as unknown as { setStatus(s: string, r?: string): void }).setStatus("idle", "test");
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(
    control > 0,
    `a parent's wait_children must wake on the status change itself (#126); fired ${control}`,
  );
  await a.dispose().catch(() => {});
});

