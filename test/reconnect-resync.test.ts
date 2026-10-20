/**
 * #54 — "during streaming, a bash row sometimes never gets marked complete."
 *
 * Two independent causes, both found by debugging with subagents and both
 * verified by execution rather than by reading.
 *
 * ## 1. A reconnect stranded the result (the WS/HTTP asymmetry)
 *
 * The server pushes events only to live sockets and replays nothing on
 * reconnect. The feed refresh was therefore 100% dependent on an unbroken
 * stream: a `tool_result` logged while the socket was down never arrived, and
 * nothing else fetched it. `GET /api/agents/:id/events` reads the file, so the
 * plain HTTP path *did* mark it complete — which is exactly the asymmetry
 * reported.
 *
 * Reachable, not theoretical: the #79 reaper closes a client that misses two
 * pings, and the cap refuses extras. Both close the socket; `onclose` retries
 * after 1.5s; and `sock.onopen` scheduled nothing at all.
 *
 * ## 2. Three server paths stranded a call with no result, permanently
 *
 * `answerUnansweredToolCalls` is the backstop, but it sits at the BOTTOM of the
 * tool loop — so every path that leaves that loop by `return` or `throw` skipped
 * it, leaving the call logged with no result anywhere:
 *
 *   - `if (this.stopRequested) return finished`
 *   - `ask_user` parking the loop by throwing
 *   - `ensureWorkspace()` awaited BETWEEN the two appends, with no catch
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

// #110: POSIX-only — runs POSIX commands through the bash tool.
// The Windows CI job skips this file; see test/helpers/posix-only.ts for why
// opting out is explicit rather than by filename.
markPosixOnly("runs POSIX commands through the bash tool");

/*
 * The client-reconnect half that used to live here ("a reconnect closes the gap",
 * "recovery is proportional", "the FIRST connect is not double-loaded", "nothing
 * else polls the feed") all read App.tsx as TEXT and matched the socket wiring.
 * A source-shape test cannot fail for a real reason — #54's own `firstConnect`
 * assertion passed while the flag was never set to false — so they were deleted.
 * The reconnect gap is asserted behaviourally, against a live server and a real
 * WebSocket, in test/ws-live-delivery.test.ts.
 */

/* ---------- 2: no server path strands a call ---------- */

test("ask_user parks only after answering the batch (#54)", async () => {
  // ask_user PARKS the loop by THROWING, and the throw leaves the whole tool loop — so an
  // EARLIER call in the same assistant message that was already logged but not yet run
  // would keep no tool_result, and its row would read "waiting for output…" for the rest of
  // the session. That is the #54 shape.
  //
  // The earlier version of this test `assert.match`ed a source slice. That cannot fail for
  // a real reason — it pins the SPELLING — and it went red when the handler moved into the
  // meta-tool dispatch table with the behaviour intact. Converting it to behaviour exposed
  // that the obvious version is VACUOUS (verified: it passed with the backstop deleted),
  // because a first `bash` call finishes before ask_user is even reached.
  //
  // So the first call is a TOOL THAT IS NEVER RUN: `ask_user` is first, and a second call
  // follows it in the same batch. The loop throws on the first call, before touching the
  // second — and the second MUST still be answered by the backstop.
  const { mkdtempInRootSync } = await import("./helpers/tmp-root.ts");
  const { Agent } = await import("../src/agent/agent.ts");
  const { readEvents } = await import("../src/log/events.ts");
  const ws = mkdtempInRootSync("h54p-");
  const sd = mkdtempInRootSync("h54q-");
  let n = 0;
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => {
      if (n++ === 0) {
        return {
          message: {
            role: "assistant" as const,
            content: "",
            tool_calls: [
              // FIRST: parks the loop by throwing
              { id: "p1", type: "function" as const, function: { name: "ask_user", arguments: JSON.stringify({ question: "which?" }) } },
              // SECOND: never reached, so only the backstop can answer it
              { id: "p2", type: "function" as const, function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } },
            ],
          },
        };
      }
      return { message: { role: "assistant" as const, content: "done" } };
    },
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  try {
    a.enqueuePrompt("go", "user");
    a.start("t");
    await a.settled().catch(() => {});
    const events = await readEvents(a.log.filePath);
    const calls = events.filter((e) => e.type === "tool_call").map((e) => String((e.data as { callId?: string }).callId));
    const results = new Set(events.filter((e) => e.type === "tool_result").map((e) => String((e.data as { callId?: string }).callId)));
    // The interrupted call is logged; the one after it never is (the throw precedes it), so
    // the LOG has no orphan to check. The hazard is in the MESSAGE HISTORY, which is what
    // the provider validates: a `tool_calls: [p1, p2]` assistant message followed by only
    // ONE tool reply is a 400 on the next request (#76/#50), not a rendering glitch.
    //
    // PRECONDITION: that assistant message really did carry both calls, else this is vacuous.
    const assistant = a.conversationForTest.find((m) => (m.tool_calls?.length ?? 0) > 0);
    assert.equal(
      assistant?.tool_calls?.length,
      2,
      `the batch must have carried both calls for this check to mean anything; got ${JSON.stringify(assistant?.tool_calls?.map((c) => c.id))}`,
    );
    const answered = new Set(
      a.conversationForTest.filter((m) => m.role === "tool").map((m) => String(m.tool_call_id)),
    );
    const stranded = (assistant!.tool_calls ?? []).map((c) => c.id).filter((id) => !answered.has(id));
    assert.deepEqual(
      stranded,
      [],
      "every call in the batch must be answered before the loop parks, or the next provider request is rejected (#54)",
    );
    // and the log must be complete for the call that DID run
    assert.ok(calls.includes("p1"), `the ask_user call must be logged; got ${JSON.stringify(calls)}`);
  } finally {
    await a.dispose().catch(() => {});
  }
});

/* ---------- behavioural ---------- */

test("stopping mid-batch leaves no unanswered tool_call (#54)", async () => {
  await useTempDirs(["h54a-", "h54b-"], async ([ws, sd]) => {
    let release: () => void = () => {};
    const _gate = new Promise<void>((r) => {
      release = r;
    });
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      // two calls in ONE assistant message; the first blocks
      chatFn: async () => ({
        message: {
          role: "assistant" as const,
          content: "",
          tool_calls: [
            { id: "c1", type: "function" as const, function: { name: "bash", arguments: JSON.stringify({ command: "sleep 30" }) } },
            { id: "c2", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path: "x.txt" }) } },
          ],
        },
      }),
      autoContinue: false,
    } as any);
    await a.init();
    a.enqueuePrompt("go", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 40));
    a.stop("stopped mid-batch");
    release();
    await a.settled();
    await new Promise((r) => setTimeout(r, 60));

    // every logged tool_call must have a tool_result — synthesized or real
    const { readEvents } = await import("../src/log/events.ts");
    const events = await readEvents(a.log.filePath);
    const calls = events.filter((e) => e.type === "tool_call").map((e) => String((e.data as any).callId));
    const results = new Set(events.filter((e) => e.type === "tool_result").map((e) => String((e.data as any).callId)));
    const orphans = calls.filter((id) => !results.has(id));
    assert.deepEqual(orphans, [], `every tool_call must be answered, or its row never completes (#54)`);
    await a.dispose();
  });
});
