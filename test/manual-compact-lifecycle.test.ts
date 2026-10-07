/**
 * #127 — "manual compact 中なのに idle に見える"
 *
 * The state lived in TWO places that disagreed:
 *
 *   state machine:  status = idle
 *   actually:       summarizer LLM call in flight
 *
 * `compactNow()` ran `maybeCompact(true)` on the run chain WITHOUT touching
 * any lifecycle state, and — worse — the ORDER inside maybeCompact was:
 *
 *     bus.emit(compaction-progress: summarizing)   ← first notification
 *     await log.append(context-compaction-started) ← async gap
 *     this.compactPhase = "summarizing"            ← state set LAST
 *
 * so the first progress event fired while the snapshot still said
 * `ctx.compacting = undefined`. A client observing REST/WS at that instant
 * saw "idle, not compacting, but a summarizing banner" — three contradictory
 * facts from three paths.
 *
 * Required (minimal contract — status enum stays as is):
 *   - at the FIRST compaction-progress event, the snapshot must ALREADY
 *     observe ctx.compacting = "summarizing" (state set before notify)
 *   - throughout the manual compact: snapshot.live = true (stop must be
 *     offered, "start" must not be)
 *   - after it resolves: ctx.compacting gone, exactly one compaction recorded
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { bus } from "../src/bus.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("manual compact is observable in the snapshot from the FIRST progress event (#127)", async () => {
  await useTempDirs(["t127a-", "t127b-"], async ([ws, sd]) => {
    let release!: () => void;
    const summarizerBlocked = new Promise<void>((r) => {
      release = r;
    });
    let chatCalls = 0;
    const a = new Agent({
      id: "c",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => {
        chatCalls++;
        if (chatCalls === 1) {
          await summarizerBlocked; // the summarizer call is mid-flight
          return { message: { role: "assistant" as const, content: "compacted summary" } };
        }
        return { message: { role: "assistant" as const, content: "unused" } };
      },
      autoContinue: false,
    } as never) as Agent;
    try {
      await a.init();
      await a.setGoal("g");
      // a compactable history: plain alternating messages so safeCut has room
      const msgs: { role: "user" | "assistant"; content: string }[] = [];
      for (let i = 0; i < 40; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: `msg ${i} — filler for the summarizer` });
      (a as unknown as { messages: unknown[] }).messages = msgs;

      let snapAtFirstProgress: ReturnType<typeof a.snapshot> | null = null;
      const onUpdate = (raw: unknown) => {
        const ev = raw as { kind?: string };
        if (ev?.kind === "compaction-progress" && !snapAtFirstProgress) {
          // the snapshot the REST/WS world would see at that exact instant
          snapAtFirstProgress = a.snapshot();
        }
      };
      bus.on("update", onUpdate);

      let done = false;
      const p = a.compactNow().then((r) => {
        done = true;
        return r;
      });
      await wait(300);
      assert.equal(done, false, "precondition: the manual compact is still running");
      assert.equal(chatCalls, 1, "precondition: the summarizer call is the one in flight");

      assert.ok(snapAtFirstProgress, "a compaction-progress event must have been emitted");
      assert.equal(
        (snapAtFirstProgress as unknown as { ctx: { compacting?: string } }).ctx.compacting,
        "summarizing",
        "the FIRST progress event must already observe ctx.compacting (#127)",
      );
      assert.equal(
        (snapAtFirstProgress as unknown as { live: boolean }).live,
        true,
        "a manually-compacting agent is live (#59 semantics: stop, not start)",
      );

      // and mid-flight (not just at the first event) the state stays consistent
      const mid = a.snapshot();
      assert.equal(mid.ctx?.compacting, "summarizing", "mid-compact snapshot shows the phase");
      assert.equal(mid.status, "idle", "the minimal contract keeps the status enum unchanged");

      release();
      const r = await Promise.race([p, wait(5000)]);
      assert.ok(r, "the manual compact resolved");
      const after = a.snapshot();
      assert.equal(after.ctx?.compacting ?? undefined, undefined, "the phase clears when done");
      assert.equal(
        (a as unknown as { stats: { compactions: number } }).stats.compactions,
        1,
        "exactly one compaction was recorded",
      );
      const events = await readEvents(a.log.filePath);
      assert.ok(
        events.some((e) => e.type === "compaction"),
        "the compaction event is on the timeline",
      );
    } finally {
      release();
      await a.dispose().catch(() => {});
    }
  });
});
