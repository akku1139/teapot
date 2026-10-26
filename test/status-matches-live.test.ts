/**
 * The badge must never contradict the button.
 *
 * Reported: "バックグラウンドbash待ちで finish_reason: stop でAIが止まると表示は idle なのにコントロールは
 * stop ボタンが表示されてて微妙 / wait_children も同じようになってるはず".
 *
 * `live` was already correct for both cases — a parked tool and a running background shell are
 * work in flight, and `stop()` really does end them — so the client offered ■ stop. But the
 * DISPLAYED status still said "idle", because `parkForTool()` wrote it and the background-shell
 * path never wrote anything at all. Two sources of truth for one question, disagreeing in the
 * one place the operator looks first.
 *
 * The invariant, now enforced in `snapshot()`: if `live` is true, the status is never "idle".
 * "waiting" is the honest word for "alive, and it will continue on its own".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

const mk = (ws: string, sd: string) =>
  new Agent({
    id: "w",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => ({ message: { role: "assistant", content: "done" } }) as never,
    autoContinue: false,
  } as never);

test("a PARKED agent reports waiting, not idle (#status)", async () => {
  await useTempDirs(["smw-", "sms-"], async ([ws, sd]) => {
    const a = mk(ws!, sd!);
    await a.init();
    try {
      // put it in the only state parkForTool accepts: running, with nothing queued
      const inner = a as unknown as {
        status: string;
        statusReason: string;
        parkForTool(reason: string): boolean;
      };
      inner.status = "running";
      inner.statusReason = "prompt";

      const parked = inner.parkForTool("waiting on background shell bg1");
      assert.equal(parked, true, "precondition: the park was accepted");

      const snap = a.snapshot() as unknown as { status: string; live: boolean; statusReason: string };
      assert.equal(snap.live, true, "a parked loop is work in flight — stop must be offered");
      assert.equal(
        snap.status,
        "waiting",
        "the badge must not read idle while the header offers ■ stop",
      );
      assert.match(snap.statusReason, /background shell bg1/, "and must say what it waits on");
      assert.match(snap.statusReason, /take over/, "…and that a message takes over");
    } finally {
      await a.dispose().catch(() => {});
    }
  });
});

test("the invariant holds for EVERY live state, not just a park (#status)", async () => {
  await useTempDirs(["smw2-", "sms2-"], async ([ws, sd]) => {
    const a = mk(ws!, sd!);
    await a.init();
    try {
      const inner = a as unknown as {
        status: string;
        pendingPrompts: unknown[];
        retrySleeping: boolean;
        compactPhase: string;
      };
      // the four ways an agent can be live with a non-running status
      const cases: { name: string; set: () => void }[] = [
        { name: "queued prompts", set: () => { inner.status = "idle"; inner.pendingPrompts = [{}]; } },
        { name: "retry backoff", set: () => { inner.status = "error"; inner.retrySleeping = true; } },
        { name: "compacting", set: () => { inner.status = "idle"; inner.compactPhase = "summarizing"; } },
        { name: "truly idle", set: () => { inner.status = "idle"; inner.pendingPrompts = []; inner.retrySleeping = false; inner.compactPhase = ""; } },
      ];
      for (const c of cases) {
        c.set();
        const snap = a.snapshot() as unknown as { status: string; live: boolean };
        if (snap.live) {
          assert.notEqual(
            snap.status,
            "idle",
            `${c.name}: live=true but the badge says idle — the operator sees a stop button beside "idle"`,
          );
        } else {
          assert.equal(snap.status, "idle", `${c.name}: not live, so idle is the honest word`);
        }
      }
    } finally {
      await a.dispose().catch(() => {});
    }
  });
});

test("waiting and needs_operator are DISTINCT states (#ui)", async () => {
  /**
   * Reported: "wait_children と ask_user で非パネルのアイコン色が同じなのが微妙 / わかりにくいし、
   * 点滅してるせいで圧迫感もある".
   *
   * They were one `waiting` status plus a `waitingFor` field — the same fact stored twice, so any
   * consumer that forgot to read the second field treated "needs you" as "leave it alone". They
   * are sibling states now, which makes the distinction impossible to miss at a branch.
   */
  await useTempDirs(["smw3-", "sms3-"], async ([ws, sd]) => {
    const a = mk(ws!, sd!);
    await a.init();
    try {
      const inner = a as unknown as { status: string; statusReason: string; parkedByTool: boolean };

      // a parked tool: ALIVE, and it resumes on its own
      inner.status = "waiting";
      inner.parkedByTool = true;
      const selfWait = a.snapshot() as unknown as { status: string; live: boolean };
      assert.equal(selfWait.status, "waiting");
      assert.equal(selfWait.live, true, "a self-wait is still work in flight — stop must be offered");

      // ask_user: ALIVE, and it will not move until a human answers
      inner.status = "needs_operator";
      inner.parkedByTool = false;
      const forYou = a.snapshot() as unknown as { status: string; live: boolean };
      assert.equal(forYou.status, "needs_operator");
      assert.equal(forYou.live, true);

      // the two must never collapse into one value, which is what made them indistinguishable
      assert.notEqual(selfWait.status, forYou.status);
    } finally {
      await a.dispose().catch(() => {});
    }
  });
});
