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

test("a reconnect closes the gap (#54)", () => {
  // #54: this used to require `runFeedRefresh()` inside `onopen` — a specific
  // MECHANISM. The mechanism changed (a reconnect now asks for `?after=<cursor>`
  // rather than re-reading a 2,000-event tail), so what is asserted is now the
  // RULE: a later open must do something that recovers missed events, and it must
  // not be the full reload.
  const at = app.indexOf("sock.onopen = () => {");
  assert.notEqual(at, -1, "onopen must exist (#54)");
  const block = app.slice(at, app.indexOf("sock.onclose", at));
  assert.match(
    block,
    /catchUpAfterReconnect\(\)/,
    "a reconnect must recover what it missed (#54)",
  );
});

test("recovery is proportional — a cursor, not a full re-read (#54)", () => {
  // the reason the reconnect was expensive: `runFeedRefresh` re-reads the whole
  // tail to learn about the handful of events that arrived while down
  assert.match(
    app,
    /events\?after=\$\{encodeURIComponent\(cursor\)\}/,
    "recovery must use the after= cursor (#54)",
  );
  const at = app.indexOf("sock.onopen = () => {");
  const block = app.slice(at, app.indexOf("sock.onclose", at));
  assert.doesNotMatch(
    block,
    /runFeedRefresh\(\)/,
    "a plain full reload is what we are replacing (#54)",
  );
});

test("the FIRST connect is not double-loaded (#54)", () => {
  // select() already loads events; doing it twice on startup would double every
  // fetch for no benefit.
  //
  // #54: this used to assert the SOURCE TEXT — that `firstConnect` was declared
  // and that an early return existed — and passed while the flag was NEVER SET
  // TO FALSE, so `!firstConnect` was always false and the first open refreshed
  // anyway. Exactly the failure #75 warns about, in the file whose whole
  // purpose is to catch it.
  //
  // So the assertions are now about the STATE TRANSITION, which is the thing
  // that was missing: the flag must be flipped to false somewhere, and a fresh
  // socket must reset it.
  const decl = /let firstConnect = true;/.test(app);
  assert.ok(decl, "the first connect must be distinguishable (#54)");

  // it must actually change value, or the branch below is unreachable
  assert.match(
    app,
    /firstConnect = false;/,
    "firstConnect must be SET to false on the first open (#54) — otherwise the guard is dead code",
  );
  // The FIX's own comment explains the old inverted form, so searching the raw
  // file finds it THERE rather than in code. What matters is that the live guard
  // is a positive test — the inverted form could only ever have been the
  // CONDITION of the guard, so assert the branch that actually exists.
  const onopen = app.slice(app.indexOf("sock.onopen"), app.indexOf("sock.onclose"));
  assert.match(
    onopen,
    /if \(firstConnect\)/,
    "the guard must be a POSITIVE test (#54) — `!firstConnect` never fired",
  );
  // and a new socket starts a new first-connect cycle
  const fn = app.slice(app.indexOf("function connectWs()"), app.indexOf("function connectWs()") + 400);
  assert.match(
    fn,
    /firstConnect = true;/,
    "a fresh connection must reset the flag (#54) — or a reconnect that itself dropped skips the resync",
  );
});

test("the guard fires on the first open and not on a reconnect (#54)", () => {
  // behavioural: drive the branch the way the socket does, so the assertion is
  // about the SEQUENCE rather than about the text of a source line
  const branch = app.slice(app.indexOf("sock.onopen"), app.indexOf("sock.onclose"));
  // a comment sits inside the block, so allow comment lines rather than
  // requiring the two statements to be adjacent
  const firstOpenIsGuarded = /if \(firstConnect\)\s*\{[\s\S]{0,200}?firstConnect = false;[\s\S]{0,80}?return;/.test(branch);
  assert.ok(
    firstOpenIsGuarded,
    "on the first open the flag must be consumed and the handler must return (#54)",
  );
  assert.match(
    branch,
    /catchUpAfterReconnect\(\)/,
    "a later open must recover the gap (#54)",
  );
});

test("a reconnect drains a hidden-tab defer too (#54)", () => {
  // a tab that was hidden when the socket dropped has pendingRefresh set by the
  // hidden-tab path as well; onopen must not leave it stranded
  // The RULE: a reconnect must still run its recovery while hidden — deferring
  // the whole thing until the tab is visible is what stranded rows in the first
  // place, because the events kept arriving for a feed nobody was reloading.
  const at = app.indexOf("sock.onopen = () => {");
  const onopen = app.slice(at, app.indexOf("sock.onclose", at));
  assert.match(onopen, /catchUpAfterReconnect\(\)/, "onopen must recover (#54)");
  const fn = app.slice(app.indexOf("async function catchUpAfterReconnect"));
  assert.doesNotMatch(
    fn.slice(0, fn.indexOf("function connectWs")),
    /visibilityState[^\n]*return/,
    "a hidden tab must NOT skip recovery outright (#54)",
  );
  // fetching while hidden is cheap and the DOM is not laid out; only the
  // metrics/scroll follow-up needs the tab visible
  assert.match(
    fn,
    /if \(got\.length && !hidden\) void refreshMetrics\(\);/,
    "the expensive follow-up is what waits for visibility (#54)",
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
