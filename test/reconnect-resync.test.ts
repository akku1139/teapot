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
import { readFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

// #110: POSIX-only — runs POSIX commands through the bash tool.
// The Windows CI job skips this file; see test/helpers/posix-only.ts for why
// opting out is explicit rather than by filename.
markPosixOnly("runs POSIX commands through the bash tool");

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
const agent = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");

/* ---------- 1: the client resyncs on reconnect ---------- */

test("a reconnect resyncs the feed (#54)", () => {
  assert.match(
    app,
    /sock\.onopen = \(\) => \{[\s\S]{0,400}?runFeedRefresh\(\)/,
    "onopen must resync — nothing else fetches events after a gap (#54)",
  );
});

test("the FIRST connect is not double-loaded (#54)", () => {
  // select() already loads events; doing it twice on startup would double every
  // fetch for no benefit
  assert.match(app, /let firstConnect = true;/, "the first connect must be distinguishable (#54)");
  assert.match(
    app,
    /if \(!firstConnect\) \{\s*firstConnect = true;\s*return;/,
    "and the first open must return before scheduling (#54)",
  );
});

test("a reconnect drains a hidden-tab defer too (#54)", () => {
  // a tab that was hidden when the socket dropped has pendingRefresh set by the
  // hidden-tab path as well; onopen must not leave it stranded
  const onopen = app.slice(app.indexOf("sock.onopen = () => {"), app.indexOf("sock.onopen = () => {") + 600);
  assert.match(onopen, /pendingRefresh = true;/, "onopen must mark a pending refresh (#54)");
  assert.match(
    onopen,
    /document\.visibilityState === "visible"\) void runFeedRefresh\(\)/,
    "and run it when the tab is visible (#54)",
  );
});

test("nothing else polls the feed, so onopen is the only resync (#54)", () => {
  // the sole setInterval refreshes metrics and tasks, never events — which is
  // why the gap was permanent rather than merely slow
  const timers = [...app.matchAll(/setInterval\([^;]{0,400}?\);/g)].map((m) => m[0]);
  const refreshesEvents = timers.some((t) => t.includes("loadEvents"));
  assert.equal(
    refreshesEvents,
    false,
    "if the poller did fetch events, this fix would be redundant — worth knowing either way (#54)",
  );
});

/* ---------- 2: no server path strands a call ---------- */

test("the stop exit still runs the backstop (#54)", () => {
  // anchor on the one INSIDE the tool-call loop — an earlier `stopRequested`
  // check exists at 1662 and matching that one made this test vacuous
  const loopAt = agent.indexOf("for (const call of m.tool_calls) {");
  const stopExit = agent.slice(loopAt, agent.indexOf("for (const call of m.tool_calls) {") + 700);
  assert.match(
    stopExit,
    /answerUnansweredToolCalls\(m\)/,
    "stopping mid-batch must answer the outstanding calls (#54)",
  );
});

test("ask_user parks only after answering the batch (#54)", () => {
  // look BACK from the throw, but only within this turn's tool loop
  const throwAt = agent.indexOf('throw Object.assign(new Error("waiting for user")');
  const park = agent.slice(agent.indexOf("for (const call of m.tool_calls) {"), throwAt);
  assert.match(
    park,
    /answerUnansweredToolCalls\(m\)/,
    "parking the loop must not strand earlier calls in the same batch (#54)",
  );
});

test("a throw between the two appends still produces a result (#54)", () => {
  // ensureWorkspace() sits BETWEEN the tool_call and tool_result appends and
  // fs.mkdir has no catch, so a failure left the call logged with no result
  const i = agent.indexOf("await this.ensureWorkspace();");
  const around = agent.slice(i - 200, i + 700);
  assert.match(
    around,
    /catch \(err\) \{[\s\S]{0,200}?result = \{ ok: false/,
    "a failed ensureWorkspace must yield a tool_result, not propagate (#54)",
  );
});

/* ---------- behavioural ---------- */

test("stopping mid-batch leaves no unanswered tool_call (#54)", async () => {
  await useTempDirs(["h54a-", "h54b-"], async ([ws, sd]) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
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
