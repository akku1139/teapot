/**
 * Smoke-test the built web bundle inside happy-dom.
 *
 * Two layers of protection:
 * 1. module init + first render survive (catches TDZ/order crashes like the
 *    "xe before initialization" regression);
 * 2. DEEP RENDER: /api/* is stubbed so the app mounts a selected agent with
 *    full session data (events, stats, ctx gauge). Render-time crashes that
 *    only fire on populated panels — e.g. the "pct is not defined"
 *    ReferenceError in the runtime card — abort with a non-zero exit.
 *
 * Usage: node scripts/smoke-web.mjs [publicAssetsDir]
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const req = createRequire(path.join(process.cwd(), "package.json"));
const { Window } = req("happy-dom");

const pub = process.argv[2] ?? path.join("public", "assets");
const asset = fs
  .readdirSync(pub)
  .filter((f) => f.startsWith("index-") && f.endsWith(".js"))
  .sort()
  .at(-1);
if (!asset) {
  console.error("no index-*.js found in", pub);
  process.exit(1);
}

/* ---------- canned API responses (shape mirrors src/server/api.ts) ---------- */

const AGENT = {
  id: "alpha",
  status: "idle",
  statusReason: "",
  workspace: "/tmp/ws",
  session: "alpha-s1",
  branch: "br0",
  goal: { status: "active", text: "demo goal" },
  latestProgress: null,
  stats: {
    turns: 3, toolCalls: 5, compactions: 0,
    inputTokens: 150_000, outputTokens: 2_000, cachedInputTokens: 90_000,
  },
  model: "test/big-model",
  provider: "openrouter",
  pendingPrompts: 0,
  todo: "",
  parent: "",
  autoContinue: true,
  // window > 0 makes the right panel render the context-gauge branch —
  // exactly where the "pct is not defined" ReferenceError shipped once
  ctx: { usedTokens: 123_456, compactAt: 72_000, window: 200_000 },
};

const EVENTS = [
  { id: "e1", seq: 1, ts: "2026-01-01T10:00:00Z", session: "alpha-s1", branch: "br0", parent: null,
    type: "prompt", data: { source: "user", text: "hello **world**" } },
  { id: "e2", seq: 2, ts: "2026-01-01T10:00:05Z", session: "alpha-s1", branch: "br0", parent: "e1",
    type: "message", data: { content: "hi there\n\n- one\n- two", final: true } },
  { id: "e3", seq: 3, ts: "2026-01-01T10:00:09Z", session: "alpha-s1", branch: "br0", parent: "e2",
    type: "tool_call", data: { callId: "c1", name: "bash", args: { command: "ls" } } },
  { id: "e4", seq: 4, ts: "2026-01-01T10:00:10Z", session: "alpha-s1", branch: "br0", parent: "e3",
    type: "tool_result", data: { callId: "c1", name: "bash", result: "file.txt", ok: true, durationMs: 12 } },
  // #63: a CURRENT log contains no child rows — the master no longer mirrors a
  // child's activity into the parent's log. The harness prompt carrying the
  // child's REPORT is the channel the parent (and the model) actually reads.
  { id: "e4b", seq: 5, ts: "2026-01-01T10:00:11Z", session: "alpha-s1", branch: "br0", parent: "e4",
    type: "prompt", data: { source: "harness", text: "[harness] Sub-agent alpha-kid finished. Final report:\nCHILD REPORT TEXT" } },
  // #51: the completion-audit lifecycle. Two shapes that used to render wrong —
  // a card with a real reason, and a verdict with NO reason (which must not
  // produce a card at all).
  // #55: an OPEN ask_user. Its options must disable the moment one is clicked,
  // without waiting for the reply to be logged and streamed back.
  { id: "q1", seq: 5, ts: "2026-01-01T10:00:20Z", session: "alpha-s1", branch: "br0", parent: "e4",
    type: "question", data: { callId: "q-call-1", question: "which library?", options: ["libfoo", "libbar"] } },
  { id: "g1", seq: 6, ts: "2026-01-01T10:00:20Z", session: "alpha-s1", branch: "br0", parent: "q1",
    type: "goal", data: { event: "audit-started", verify: "npm test passes" } },
  { id: "g2", seq: 7, ts: "2026-01-01T10:00:30Z", session: "alpha-s1", branch: "br0", parent: "g1",
    type: "goal", data: { event: "audit", verdict: "changes-required", feedback: "the parser drops CRLF line endings" } },
  { id: "g3", seq: 8, ts: "2026-01-01T10:00:40Z", session: "alpha-s1", branch: "br0", parent: "g2",
    type: "goal", data: { event: "audit", verdict: "approved", feedback: "" } },
];

function apiResponse(url) {
  const u = url.split("?")[0];
  if (u === "/api/config")
    return {
      configPath: "/tmp/config.json",
      needsSetup: false,
      providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1" } },
      defaultProvider: "openrouter",
      agents: [{ id: AGENT.id, workspace: AGENT.workspace }],
      tasks: [],
    };
  if (u === "/api/agents")
    return { agents: [AGENT, { ...AGENT, id: "beta", workspace: "/tmp/other-project" }] };
  // #58: one agent owning SEVERAL session dirs (each incarnation mints one).
  // alpha is BOUND to alpha-s2; alpha-s1 and alpha-s9 are past sessions.
  if (u === "/api/sessions")
    return {
      sessions: [
        { id: "alpha-s9", agentId: "alpha", mtimeMs: Date.now() - 1000, sizeBytes: 900 },
        { id: "alpha-s2", agentId: "alpha", mtimeMs: Date.now() - 5000, sizeBytes: 800 },
        { id: "alpha-s1", agentId: "alpha", mtimeMs: Date.now() - 9000, sizeBytes: 700 },
        { id: "beta-s1", agentId: "beta", mtimeMs: Date.now() - 2000, sizeBytes: 600 },
      ],
    };
  if (u === `/api/agents/${AGENT.id}/load`) return { ok: true };
  if (u === `/api/agents/${AGENT.id}/events`) return { events: EVENTS, total: EVENTS.length };
  if (u === `/api/agents/${AGENT.id}/branches`) return { branches: [{ branch: "br0", events: EVENTS.length }] };
  if (u === `/api/agents/${AGENT.id}/skills`) return { skills: [] };
  if (u === `/api/agents/${AGENT.id}/tree`)
    return {
      path: "",
      workspace: AGENT.workspace,
      entries: [
        { name: "src", dir: true },
        { name: "README.md", dir: false, size: 4200 },
      ],
    };
  if (u === "/api/models")
    return { provider: "openrouter", models: [{ id: AGENT.model, contextLength: 200_000 }] };
  if (u === "/api/metrics") return { rssMb: 1, heapUsedMb: 1, loadavg1: 0, uptimeSec: 1, agents: [] };
  if (u === "/api/tasks") return { tasks: [] };
  if (u === "/api/personas") return { personas: [] };
  return { ok: true };
}

let fetchCount = 0;
/** every URL the app asked for — lets a test assert WHICH session it opened (#58) */
const requestedUrls = [];

/* ---------- happy-dom globals ---------- */

// WebSocket mock, installed BEFORE the bundle import: happy-dom's socket
// fires "open" even with no server, so the app would otherwise sit connected
// and never touch our later mocks. Captured instances let the test push bus
// events into the app exactly like the real server does.
const WS_EVENTS = []; // queued {kind, ...} messages delivered on open
class MockWS {
  static instances = [];
  url; readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null;
  constructor(url) {
    this.url = url;
    MockWS.instances.push(this);
    this.readyState = 1;
    queueMicrotask(() => {
      this.onopen?.();
      for (const m of WS_EVENTS.splice(0)) this.onmessage?.({ data: JSON.stringify(m) });
    });
  }
  close() { this.readyState = 3; }
  send(data) { /* outbound (pong etc.) — ignored */ }
}

const w = new Window({ url: "http://localhost:7788/session/test" });
// widen the viewport so the details panel is open by default (the crash site).
// configurable + writable so a scenario can RESIZE mid-run (#50: the reported
// flow is narrowing the window with the panel open, not loading narrow).
let viewportWidth = Number(process.env.SMOKE_WIDTH ?? 1440);
Object.defineProperty(w, "innerWidth", {
  configurable: true,
  get: () => viewportWidth,
  set: (v) => { viewportWidth = Number(v); },
});
w.document.body.innerHTML = `<div id="root"></div>`;

/* Attach the built stylesheet. The bundle is JS-only, so without this
 * getComputedStyle sees no rules at all and every "is this element hidden?"
 * question answers yes-to-everything. #50's wide-mode check depends on the
 * REAL `display:none` on .rightbarhead, so load it from the same assets dir. */
{
  const cssFile = fs
    .readdirSync(pub)
    .filter((f) => f.endsWith(".css"))
    .sort()
    .at(-1);
  if (cssFile) {
    const style = w.document.createElement("style");
    style.textContent = fs.readFileSync(path.join(pub, cssFile), "utf8");
    w.document.head.appendChild(style);
    console.log("smoke: loaded stylesheet", cssFile);
  } else {
    console.error(`smoke: no *.css in ${pub} — width-sensitive checks would pass vacuously`);
    process.exit(1);
  }
}
try { Object.defineProperty(w.document, "visibilityState", { value: "visible", configurable: true }); } catch {}
const setGlobal = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  } catch {
    /* pre-existing non-configurable global — leave it */
  }
};
setGlobal("window", w);
setGlobal("document", w.document);
setGlobal("localStorage", {
  store: {},
  getItem(k) { return this.store[k] ?? null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
});
setGlobal("navigator", w.navigator);
setGlobal("location", w.location);
setGlobal("history", w.history);
setGlobal("CustomEvent", w.CustomEvent);
setGlobal("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 16));
setGlobal("WebSocket", MockWS);
// the app's connectWs() runs at import time; its socket must exist for the
// pending-echo regression below to push bus events into the app
setGlobal("fetch", async (url) => {
  fetchCount++;
  requestedUrls.push(String(url));
  const u = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  return { ok: true, status: 200, json: async () => apiResponse(u) };
});

// surface async render explosions loudly instead of dying silently
const briefStack = (err) => String(err?.stack ?? "").split("\n").slice(0, 6).join("\n");
process.on("uncaughtException", (e) => {
  console.error(`UNCAUGHT ${e?.constructor?.name}: ${e?.message}\n${briefStack(e)}`);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  const err = e instanceof Error ? e : new Error(String(e));
  console.error(`UNHANDLED REJECTION: ${err.message}\n${briefStack(err)}`);
  process.exit(1);
});

let _failed = false;
try {
  await import(pathToFileURL(path.join(pub, asset)).href);
  console.log("bundle imported:", asset);
} catch (err) {
  console.error("IMPORT FAIL:", err.constructor.name, err.message);
  process.exit(1);
}

/** poll until predicate() turns true (effects settle asynchronously) */
async function waitFor(label, predicate, deadlineMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      if (predicate()) return true;
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  console.error(`DEEP RENDER TIMEOUT: ${label} never became true`);
  if (process.env.SMOKE_DEBUG)
    console.error("BODY:", JSON.stringify(bodyText().slice(0, 2500)));
  return false;
}

const bodyText = () => w.document.body.textContent ?? "";

// agent list must appear…
if (!(await waitFor("agent list", () => bodyText().includes("alpha")))) process.exit(1);
console.log("deep render ok: sidebar shows agent");

// …and the runtime panel must render its ctx gauge (the regression site):
// used 123456 / window 200000 → "61.7% of 200k" (one-decimal percentages)
if (!(await waitFor("runtime gauge", () => bodyText().includes("61.7% of 200k")))) process.exit(1);
console.log("deep render ok: context gauge shows '61.7% of 200k'");

// stats grid + cached pill + compaction line from the redesigned runtime card
for (const marker of ["turns", "in / 2.0k out", "60% cached"]) {
  if (!bodyText().includes(marker)) {
    console.error(`DEEP RENDER MISSING RUNTIME STAT: ${marker}`);
    process.exit(1);
  }
}
console.log("deep render ok: runtime stats present");

// workspace file tree renders its lazy listing
if (!(await waitFor("file tree", () => bodyText().includes("README.md")))) process.exit(1);
console.log("deep render ok: file tree present");

// feed rows rendered through the markdown/tool-embed pipeline
const feedText = await waitFor("feed rows", () =>
  ["hello", "hi there", "$ ls"].every((m) => bodyText().includes(m)),
);
if (!feedText) {
  const missing = ["hello", "hi there", "$ ls"].filter((m) => !bodyText().includes(m));
  console.error(
    `DEEP RENDER MISSING FEED ROW: ${missing.join(", ")}` +
      `\nbody snippet: ${JSON.stringify(bodyText().slice(0, 600))}`,
  );
  process.exit(1);
}
console.log("deep render ok: feed rows present");

/* ---------- #51: the audit rows must not render as one long line ----------
 * Reported: "`🔍 completion audit started` and the audit body to its right are
 * on ONE line, and the card's left edge is out of line with the others", plus
 * "`⚠ audit: changes required (no detail)` between the divider lines looks a
 * bit off".
 *
 * happy-dom does no layout, so getBoundingClientRect() returns all zeros and
 * the same-row bug cannot be measured as geometry. What CAUSED it is structural
 * though — a card nested inside a `display:flex` .divider-msg becomes a flex
 * SIBLING of the label — so the assertions below check the structure and the
 * computed display that together produce the one-line layout. On the pre-fix
 * code the audit row is a .divider-msg and the card is its direct child. */
{
  const fail = (msg) => { console.error(`#51 REGRESSION: ${msg}`); process.exit(1); };
  const css = (el, prop) => w.document.defaultView.getComputedStyle(el).getPropertyValue(prop);
  const text = (el) => el?.textContent ?? "";

  const lines = [...w.document.querySelectorAll(".goalline")];
  if (!lines.length) {
    const old = [...w.document.querySelectorAll(".divider-msg")].find((d) =>
      /completion audit|audit: /.test(text(d)),
    );
    if (old)
      fail(
        "the audit row is still a .divider-msg, whose display:flex puts the card on " +
        `the SAME line as its label (#51): ${JSON.stringify(text(old).slice(0, 60))}`,
      );
    fail("no audit rows rendered at all (#51)");
  }

  for (const line of lines) {
    const label = line.querySelector(".goalline-label");
    if (!label) fail(`an audit row has no label element (#51): ${text(line).slice(0, 60)}`);

    // THE bug: the card must be nested INSIDE a block wrapper, never a direct
    // child of the flex row
    if (css(line, "display") === "flex")
      fail(`.goalline must not be display:flex — that is the same-row bug (#51)`);
    if (line.classList.contains("divider-msg"))
      fail(`the audit row still uses the flex .divider-msg container (#51)`);
    if (css(label, "display") === "flex" || css(label, "display") === "inline-flex")
      fail(`the label must be its own block so the card drops beneath it (#51)`);

    const card = line.querySelector(".card");
    if (card) {
      // the card has to be a DESCENDANT of the stacking wrapper, and the label
      // a SIBLING of it — never both children of a flex row
      if (card.parentElement === line && label.parentElement === line) {
        const parentDisplay = css(line, "display");
        if (parentDisplay.includes("flex"))
          fail(`label and card are flex siblings of ${line.className} (#51)`);
      }
      // alignment: the card must not be shifted by an inline offset
      if (/margin-left|transform/.test(css(card, "margin-left") + css(card, "transform")))
        fail(`the audit card must not be offset from the feed's left edge (#51)`);
    }
  }

  // a verdict with NO reason must not produce a card at all — "(no detail)" is
  // the absence of a finding, and drawing it as one was the second complaint
  const approvedLine = lines.find((l) => /audit: approved/.test(text(l)));
  if (!approvedLine) fail("the approved audit row is missing (#51)");
  if (approvedLine.querySelector(".card"))
    fail(
      `a verdict with no reason must render the label ALONE, not a card (#51): ${text(approvedLine).slice(0, 60)}`,
    );
  if (/no detail/i.test(text(approvedLine)))
    fail(`the literal "no detail" placeholder must never reach the UI (#51)`);

  // and a verdict WITH a real reason must still show it
  const rejectedLine = lines.find((l) => /changes required/.test(text(l)));
  if (!rejectedLine?.querySelector(".card")) fail("a real audit finding must still render its card (#51)");
  if (!/CRLF/.test(text(rejectedLine)))
    fail(`the auditor's reason must be visible (#51): ${text(rejectedLine).slice(0, 60)}`);

  console.log("deep render ok: audit rows stack and a reasonless verdict shows no card (#51)");
}

/* ---------- #55: an answered ask_user must disable its options ------------
 * Reported: "I clicked the agent's ask_user option but it isn't disabled in the
 * UI" — and switching to another session and back DOES disable it.
 *
 * That clue is the diagnosis: the state is correct but STALE. The derived
 * "answered" set only flips once the reply is LOGGED, so between the click and
 * the bus event the buttons stayed live and a second click would send a
 * DUPLICATE prompt. This asserts the buttons disable on the click itself. */
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (msg) => { console.error(`#55 REGRESSION: ${msg}`); process.exit(1); };
  const opts = () => [...w.document.querySelectorAll(".qopt")];
  const btns = opts();
  if (btns.length < 2) fail(`the open question's options did not render (#55): ${btns.length}`);
  if (btns.some((b) => b.disabled))
    fail("an UNANSWERED question must offer live options (#55)");
  if (!w.document.querySelector(".embed.question"))
    fail("the question row is missing (#55)");

  // click one option — no reload, no session switch, no waiting for a WS event
  btns[0].click();
  await sleep(150);

  const after = opts();
  if (after.length < 2) fail("the options vanished instead of disabling (#55)");
  if (!after.every((b) => b.disabled))
    fail(
      `every option must disable once answered — ${after.filter((b) => b.disabled).length}/${after.length} disabled (#55)`,
    );
  if (!w.document.querySelector(".embed.question.answered"))
    fail("the answered question must be marked as such (#55)");
  // the free-text reply must close too, or the same duplicate-reply hole is
  // still open by the back door
  const freeInput = w.document.querySelector(".qfree input");
  if (freeInput && !freeInput.disabled)
    fail("the free-text answer must disable with the options (#55)");

  console.log("deep render ok: an answered ask_user disables its options at once (#55)");

  // #97 — an idle session must not leave "thinking…" at the bottom of the feed.
  //
  // The live bubble renders whenever `live()` is non-empty, and shows
  // "thinking…" when the buffer has reasoning but no text. So a buffer that
  // outlives its turn parks that row on screen with no cursor and no way to tell
  // it from a live stream.
  //
  // #40's dead-code sweep is what clears it: the buffer is pruned once the agent
  // is neither running nor waiting. This drives that through the REAL bundle,
  // because a pure-helper test cannot see whether the sweep is wired up — which
  // is exactly how the v0.26.1 fix shipped green while doing nothing.
  {
    const sock = MockWS.instances.at(-1);
    // #146: the bubble is gated on the DISPLAYED SESSION being live, so an idle
    // agent shows nothing — correct, and the reason this check must make the
    // agent live first. It used to pass only because that gate did not exist.
    sock.onmessage?.({
      data: JSON.stringify({
        kind: "agent-update",
        agentId: AGENT.id,
        snapshot: { ...AGENT, status: "running" },
      }),
    });
    await new Promise((r) => setTimeout(r, 150));
    // precondition: put a REASONING-ONLY buffer on the agent, which is what
    // renders the bare "thinking…" row. Without this the check would pass
    // vacuously — there would be nothing to clear.
    sock.onmessage?.({
      data: JSON.stringify({
        kind: "llm-delta",
        agentId: AGENT.id,
        // #146: sessionId is REQUIRED by the bus type and the frame must
        // carry the session the timeline resolved to. WHICH id that is depends
        // on whether /api/sessions had landed when the app selected the agent
        // (pre-index → the agent id; post-index → alpha-s1): the driver cannot
        // see internals, so it sprays the candidates — the client's gate drops
        // every frame whose session does not match the DISPLAYED timeline, so
        // exactly one lands (and a wrong spray still makes the check fail
        // vacuously, which is the point).
        sessionId: "alpha",
        text: "",
        reasoning: "weighing the options",
      }),
    });
    // the other candidates: exactly the frame whose session matches the
    // DISPLAYED timeline lands — the client's gate drops the rest
    for (const sid of ["alpha-s1", "alpha-s2"]) {
      sock.onmessage?.({
        data: JSON.stringify({
          kind: "llm-delta",
          agentId: AGENT.id,
          sessionId: sid,
          text: "",
          reasoning: "weighing the options",
        }),
      });
    }
    await new Promise((r) => setTimeout(r, 250));
    const before = w.document.body.textContent.includes("thinking");
    if (!before) {
      console.error("#97 check could not create the thinking… row — the test would pass vacuously");
      process.exit(1);
    }
    if (!sock?.onmessage) {
      console.error("#97 check: no app socket to drive");
      process.exit(1);
    }
    // #54: flip the agent to RUNNING first. `AGENT` is already idle, so pushing
    // `status:"idle"` produced a snapshot IDENTICAL to the one the app holds —
    // and `setAgents` keeps the old object when nothing changed, so the #40
    // sweep effect never re-ran and the buffer was never pruned.
    //
    // This check only ever passed because the FIRST socket open called
    // `runFeedRefresh()`, which re-read the feed and re-ran the effect
    // indirectly. With `firstConnect` fixed, the first open correctly does NOT
    // refresh — so the check has to drive a real transition instead.
    sock.onmessage({
      data: JSON.stringify({
        kind: "agent-update",
        agentId: AGENT.id,
        snapshot: { ...AGENT, status: "running" },
      }),
    });
    await new Promise((r) => setTimeout(r, 60));
    // …and now to idle, which is a genuine change and must trigger the sweep
    sock.onmessage({
      data: JSON.stringify({
        kind: "agent-update",
        agentId: AGENT.id,
        snapshot: { ...AGENT, status: "idle" },
      }),
    });
    w.document.dispatchEvent(new w.Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 250));
    const after = w.document.body.textContent.includes("thinking");
    if (after) {
      console.error("#97 REGRESSION: an idle agent still shows thinking… — the live buffer was not pruned");
      process.exit(1);
    }
    console.log(
      `idle session leaves no thinking… row (#97) — was ${before ? "present" : "absent"}, now ${after ? "PRESENT" : "gone"}`,
    );
  }
}

/* ---------- #58: a deep link must open the session it NAMES ----------------
 * `select()` resolved an agent id to its newest/bound session and ignored the
 * session in the URL, so `/session/alpha-s1` opened alpha-s2 and then REWROTE
 * the URL to match. The bookmark quietly pointed at a different conversation.
 *
 * The bundle boots at http://localhost:7788/session/test; this drives a real
 * deep link through history and asserts both the fetch and the final URL. */
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (msg) => { console.error(`#58 REGRESSION: ${msg}`); process.exit(1); };

  // the fixture gives alpha three sessions; ask for an OLD one on purpose
  const want = "alpha-s1";
  history.replaceState(null, "", `/session/${want}`);
  requestedUrls.length = 0;
  // drive it the way a Back/Forward would: change the URL, then fire popstate
  history.replaceState(null, "", `/session/${want}`);
  w.dispatchEvent(new w.PopStateEvent("popstate", { bubbles: true }));
  await sleep(400);

  const eventFetches = requestedUrls.filter((u) => /\/events/.test(u));
  if (!eventFetches.length) fail("no events request was made for the deep-linked session (#58)");
  // at least one events request must carry the REQUESTED session, not alpha-s2
  if (!eventFetches.some((u) => u.includes(`session=${want}`)))
    fail(
      `the deep link to ${want} never reached the events fetch: ${JSON.stringify(eventFetches)} (#58)`,
    );
  // and the URL must still name the session we asked for
  if (!location.pathname.includes(want))
    fail(`the URL was rewritten away from ${want} to ${location.pathname} (#58)`);
  console.log("deep render ok: a deep link opens the session it names (#58)");
}

/* ---------- #52: the timeline Copy buttons must actually copy -------------
 * Reported crash: `Cannot read properties of undefined (reading 'writeText')`
 * at the copy handler.
 *
 * The cause is that `navigator.clipboard` is only exposed in a SECURE context.
 * teapot serves the UI over plain http://127.0.0.1 by default — so the API is
 * simply ABSENT, not rejecting. `navigator.clipboard.writeText(...)` therefore
 * threw synchronously, before any promise existed, so the `.catch()` fallback
 * below it never ran: every Copy button was dead on the default setup, with the
 * execCommand path unreachable dead code.
 *
 * This block drives the real bundle in exactly that environment (happy-dom at
 * http://localhost, no clipboard) and asserts the text lands somewhere. */
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (msg) => { console.error(`#52 REGRESSION: ${msg}`); process.exit(1); };

  // Capture whichever path the button takes, WITHOUT a real clipboard.
  //
  // happy-dom ships a `clipboard.writeText` that resolves while doing nothing,
  // and no execCommand at all — the same shape as a browser where the API
  // exists but silently does nothing. That is why the "API exists" case is not
  // evidence of a working copy, and why the button has to fall through when the
  // environment cannot really copy.
  const copied = [];
  let execCommandCalls = 0;
  const realExec = w.document.execCommand;
  w.document.execCommand = (cmd) => {
    if (cmd === "copy") {
      execCommandCalls++;
      // the legacy path stages the text in a textarea before copying it —
      // capture it so the test can check the RIGHT text was copied
      const ta = w.document.querySelector("textarea[style*='fixed']");
      if (ta) copied.push(ta.value);
    }
    return true;
  };
  // THE REPORTED ENVIRONMENT: plain http, so navigator.clipboard is ABSENT.
  // happy-dom defines it on the prototype as a getter, so `delete` cannot
  // remove it — redefine it to undefined on the instance instead.
  Object.defineProperty(w.navigator, "clipboard", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  if (typeof navigator.clipboard !== "undefined") {
    console.error("#52 REGRESSION: could not simulate a non-secure context (clipboard is still present)");
    process.exit(1);
  }
  const hadClipboard = typeof navigator.clipboard;

  const btns = [...w.document.querySelectorAll(".copybtn")];
  if (!btns.length) fail("no Copy buttons rendered on the timeline (#52)");
  const btn = btns[0];
  btn.click(); // must NOT throw out of the handler
  await sleep(250);

  if (!execCommandCalls)
    fail(
      `the Copy button wrote nothing at all — clipboard=${hadClipboard}, ` +
      `writeText=${copied.length}, execCommand=${execCommandCalls} (#52)`,
    );
  if (!copied.length)
    fail(`the legacy path staged no text to copy (#52)`);
  if (typeof copied[0] !== "string" || !copied[0].length)
    fail(`copy must send the row's non-empty text, got ${JSON.stringify(copied[0])} (#52)`);

  // the operator must be able to TELL it worked — no silent button
  const glyph = () => btn.textContent.trim();
  if (!["✓", "⧉", "✗"].includes(glyph()))
    fail(`the Copy button shows unexpected state ${JSON.stringify(glyph())} (#52)`);
  const afterClick = glyph();
  if (afterClick === "✓") {
    // success feedback: confirm the button reports it, then returns to idle
    await sleep(1200);
    if (glyph() === "✓")
      fail("the copied state must revert, or the button lies about later copies (#52)");
  }

  // restore the environment for the rest of the run
  try { w.document.execCommand = realExec; } catch {}
  if (hadClipboard === "undefined") {
    try { delete w.navigator.clipboard; } catch {}
  }
  console.log("deep render ok: a Copy button actually copies (#52)");
}

/* ---------- pending-echo regression (undelivered prompt must not double-render) ----------
 * Full UI path: type into the composer and submit (agent RUNNING). The POST
 * returns promptId "upending1"; the server has ALREADY logged the prompt row
 * (e5) but no prompt-delivered note exists yet. Expected: the queued text
 * shows ONCE — the pending echo at the bottom — never as a settled row too. */
{
  const RUNNING_AGENT = { ...AGENT, status: "running", pendingPrompts: 1 };
  const PENDING_EVENTS = [
    ...EVENTS,
    { id: "e5", seq: 5, ts: "2026-01-01T10:00:20Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "prompt",
      data: { source: "user", text: "queued while running", promptId: "upending1" } },
  ];
  const origFetch = globalThis.fetch;
  setGlobal("fetch", async (url, init) => {
    fetchCount++;
    const raw = String(url).replace(/^https?:\/\/[^/]+/, "");
    const u = raw.split("?")[0];
    if (u === "/api/agents")
      return {
        ok: true,
        status: 200,
        json: async () => ({
          agents: [RUNNING_AGENT, { ...RUNNING_AGENT, id: "beta", workspace: "/tmp/other-project" }],
        }),
      };
    if (u === `/api/agents/${AGENT.id}/events`)
      return { ok: true, status: 200, json: async () => ({ events: PENDING_EVENTS, total: PENDING_EVENTS.length }) };
    if (u === `/api/agents/${AGENT.id}/prompt`)
      return { ok: true, status: 200, json: async () => ({ ok: true, promptId: "upending1" }) };
    return origFetch(url, init);
  });

  // refresh the feed so e5 (undelivered log row) is in `events()`
  const appWs = MockWS.instances.at(-1);
  if (!appWs?.onmessage) { console.error("MOCK WS missing"); process.exit(1); }
  if (!appWs.onmessage) { console.error("[dbg] appWs has NO onmessage handler!"); process.exit(1); }
  const pushEvent = (event) =>
    appWs.onmessage({
      data: JSON.stringify({
        kind: "event",
        agentId: AGENT.id,
        event: { agent: AGENT.id, ...event }, // bus events always carry .agent
      }),
    });
  pushEvent(PENDING_EVENTS.at(-1));
  // the feed defers refreshes while hidden; fire the visibility event so the
  // app drains pendingRefresh (happy-dom never flips the flag by itself)
  const flushRefreshes = () =>
    w.document.dispatchEvent(new w.Event("visibilitychange"));
  flushRefreshes();
  await waitFor("feed has e5", () => {
    // poll indirectly: the echo only appears after send; just wait for settle
    return true;
  });

  // TYPE INTO THE COMPOSER and submit — the real user path that creates the echo
  const ta = w.document.querySelector(".composer textarea");
  if (!ta) { console.error("composer textarea not found"); process.exit(1); }
  ta.value = "queued while running";
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const form = ta.closest("form");
  form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor("echo appears once", () => bodyText().split("queued while running").length - 1 === 1);
  await new Promise((r) => setTimeout(r, 150)); // let any duplicate render late

  const occurrences = bodyText().split("queued while running").length - 1;
  if (occurrences !== 1) {
    console.error(`PENDING ECHO DUPLICATED: appears ${occurrences}x (expected 1x)`);
    process.exit(1);
  }
  const pendingRow = w.document.querySelector(".msg.pending");
  if (!pendingRow || !pendingRow.textContent.includes("queued while running")) {
    console.error(
      "PENDING ECHO MISSING pending STYLE — undelivered log row leaked through as settled" +
        `\nrows: ${[...w.document.querySelectorAll(".msg")].map((r) => JSON.stringify(r.className.slice(0, 80))).join(", ")}`,
    );
    process.exit(1);
  }
  console.log("deep render ok: undelivered prompt shows once, as pending");

  // DELIVERY: prompt-delivered note arrives -> echo removed, settled row takes over
  pushEvent({ id: "e6", seq: 6, ts: "2026-01-01T10:00:25Z", session: "alpha-s1",
    branch: "br0", parent: null, type: "system_note",
    data: { event: "prompt-delivered", promptId: "upending1", preview: "queued whi…" } });
  flushRefreshes();
  const deliveredOk = await waitFor("echo removal after delivery", () => {
    flushRefreshes();
    const n = bodyText().split("queued while running").length - 1;
    if (n !== 1) return false;
    const settled = [...w.document.querySelectorAll(".msg:not(.pending)")]
      .some((r) => r.textContent.includes("queued while running"));
    return settled;
  }, 8000);
  if (!deliveredOk) {
    console.error(
      "PENDING ECHO STUCK after delivery (or settled row missing)" +
        `\noccurrences=${bodyText().split("queued while running").length - 1}` +
        `\nrows: ${[...w.document.querySelectorAll(".msg")].map((r) => JSON.stringify((r.className + "|" + r.textContent.slice(0, 40)).slice(0, 90))).join(", ")}`,
    );
    process.exit(1);
  }
  console.log("deep render ok: delivered prompt flips to its settled row");

  // CONTEXT ORDER: the delivered prompt's log row was written at ENQUEUE
  // time (seq 5), but the model consumed it at the delivery point (note e6).
  // The settled row must render AFTER everything the agent produced between
  // those two moments — simulated here by a later assistant message (e7).
  PENDING_EVENTS.push({ id: "e7", seq: 7, ts: "2026-01-01T10:00:30Z", session: "alpha-s1",
    branch: "br0", parent: null, type: "message",
    data: { content: "answering the queued question", final: true } });
  pushEvent(PENDING_EVENTS[PENDING_EVENTS.length - 1]);
  flushRefreshes();
  const orderOk = await waitFor("context-order rows", () => {
    flushRefreshes();
    return bodyText().includes("answering the queued question");
  });
  if (!orderOk) {
    console.error(
      "CONTEXT ORDER: reply row never rendered" +
        `\nrows: ${[...w.document.querySelectorAll(".msg")].map((r) => r.textContent.slice(0, 30)).join(" | ")}`,
    );
    process.exit(1);
  }
  {
    const feed = [...w.document.querySelectorAll(".msg")];
    const idxOf = (needle) => feed.findIndex((r) => r.textContent.includes(needle));
    const userRow = idxOf("queued while running");
    const replyRow = idxOf("answering the queued question");
    // user row must NOT sit above a reply that came after the delivery note;
    // it belongs right below the pre-delivery output (bash) and above the reply
    if (userRow === -1 || replyRow === -1) {
      console.error(`CONTEXT ORDER: rows missing (user=${userRow}, reply=${replyRow})`);
      process.exit(1);
    }
    if (userRow > replyRow) {
      console.error("CONTEXT ORDER: delivered prompt renders BELOW the agent's post-delivery reply");
      process.exit(1);
    }
    console.log("deep render ok: delivered prompt sits in true context order");
  }
}

/* ---------- #30: an in-progress todo edit must survive a panel re-render ----------
 * The operator types into the tasks editor while the right panel re-renders for
 * unrelated reasons (a poll returning a fresh agent snapshot). The typed text
 * must NOT be committed/overwritten out from under them. */
{
  const editor = w.document.getElementById("todo-input");
  if (!editor) {
    // the editor only exists in markdown-edit view; click the toggle first
    const toggle = [...w.document.querySelectorAll(".iconbtn")].find((b) =>
      /edit markdown|rendered checklist/.test(b.getAttribute("title") ?? ""),
    );
    if (!toggle) {
      console.error("#30: no tasks editor and no view toggle found");
      process.exit(1);
    }
    toggle.click();
    await new Promise((r) => setTimeout(r, 80));
  }
  let box = w.document.getElementById("todo-input");
  if (!box) {
    console.error("#30: tasks editor (todo-input) never rendered");
    process.exit(1);
  }

  // The exact reported flow: the operator SAVES, then keeps typing (or types
  // again immediately) while the agent's own set_todo lands — a re-render in
  // that window must not commit/overwrite the draft.
  const box0 = w.document.getElementById("todo-input");
  box0.value = "- first pass";
  box0.dispatchEvent(new w.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  // click "save tasks"
  const saveBtn = [...w.document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("save tasks"),
  );
  if (!saveBtn) { console.error("#30: no 'save tasks' button"); process.exit(1); }
  saveBtn.click();
  await new Promise((r) => setTimeout(r, 120));

  // #88: saving now switches to the RENDERED CHECKLIST, so #todo-input is gone by
  // design at this point. This check is about the editor NODE surviving an
  // agent-update, so it has to be looking at an editor — click the toggle back.
  // (Before #88 the branches were inverted and the save left the editor showing,
  // which is why this never had to.)
  if (!w.document.getElementById("todo-input")) {
    const toggle = [...w.document.querySelectorAll("button")].find((b) =>
      (b.getAttribute("title") ?? "") === "edit markdown",
    );
    if (!toggle) {
      console.error("#30: no toggle to return to the editor after saving (#88)");
      process.exit(1);
    }
    toggle.click();
    await new Promise((r) => setTimeout(r, 60));
  }
  const boxAfterSave = w.document.getElementById("todo-input");
  if (!boxAfterSave) {
    console.error("#30: the editor did not come back after toggling from the preview (#88)");
    process.exit(1);
  }
  box = boxAfterSave;

  const TYPED = "- half-typed task that must survive";
  box.focus();
  box.value = TYPED;
  box.dispatchEvent(new w.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));

  // Force exactly what the issue describes: the right panel re-renders because
  // the agent list is polled again and a new snapshot object arrives.
  const origFetch = globalThis.fetch;
  setGlobal("fetch", async (url, init) => {
    fetchCount++;
    const u = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (u === "/api/agents")
      return {
        ok: true,
        status: 200,
        json: async () => ({ agents: [{ ...AGENT, turns: AGENT.stats.turns + 1 }] }),
      };
    return origFetch(url, init);
  });
  // this is the shape the server really sends: a fresh snapshot. Any field that
  // differs replaces the agent object, which is what re-renders the panel.
  await new Promise((r) => setTimeout(r, 150));
  const appWs2 = MockWS.instances.at(-1);
  appWs2.onmessage?.({
    data: JSON.stringify({
      kind: "agent-update",
      agentId: AGENT.id,
      snapshot: { ...AGENT, turns: 4 },
    }),
  });
  await new Promise((r) => setTimeout(r, 250));

  const after = w.document.getElementById("todo-input");
  if (!after) {
    console.error("#30: the tasks editor vanished during a panel re-render");
    process.exit(1);
  }
  // A re-render that REPLACES the node drops the operator's focus, caret and
  // any keystroke in flight — the visible symptom of "the panel re-renders".
  // THE #30 ASSERTION: the editor node itself must survive. A re-render that
  // replaces it silently drops the operator's focus, caret position and any
  // keystroke in flight — the reported "editing gets force-committed" symptom.
  // isolate: was the VIEW MODE toggled by the re-render? that swaps the branch
  // walk up to find the first replaced ancestor
  // #30: the editor NODE must survive an agent-update snapshot. It used to be
  // re-created (focus + caret lost) because the right panel was gated on the
  // agent OBJECT, whose identity changes on every snapshot.
  if (after !== box || w.document.activeElement?.id !== "todo-input") {
    console.error(
      "#30 REGRESSION: the tasks editor was recreated by an agent-update\n" +
        `  sameNode=${after === box} focus=${JSON.stringify(w.document.activeElement?.id ?? null)}`,
    );
    process.exit(1);
  }
  if (after.value !== TYPED) {
    console.error(
      `#30 REGRESSION: in-progress todo was clobbered by a panel re-render\n` +
        `  expected: ${JSON.stringify(TYPED)}\n  actual:   ${JSON.stringify(after.value)}`,
    );
    process.exit(1);
  }
  console.log("deep render ok: in-progress todo survives a panel re-render (#30)");
}

/* ---------- #18: the sidebar marks which workspace each chat belongs to ------ */
{
  const headers = [...w.document.querySelectorAll(".wsheader")].map((h) => h.textContent.trim());
  const items = w.document.querySelectorAll(".agent-item").length;
  // the fixture has two agents in two different workspaces, so there must be a
  // header per workspace and an item per agent
  if (headers.length !== 2) {
    console.error(`#18 REGRESSION: expected one workspace header per project, got ${JSON.stringify(headers)}`);
    process.exit(1);
  }
  if (items !== 2) {
    console.error(`#18 REGRESSION: expected both agents in the sidebar, got ${items}`);
    process.exit(1);
  }
  if (!headers.some((h) => /ws|alpha/.test(h)) || !headers.some((h) => /other-project|beta/.test(h))) {
    console.error(`#18 REGRESSION: headers do not name the projects: ${JSON.stringify(headers)}`);
    process.exit(1);
  }
  console.log("deep render ok: sidebar groups chats by workspace (#18)");
}

/* ---------- #18: clicking a workspace header must ACTUALLY collapse it ------
 * The unit test mirrors sidebarRows(); this drives the real bundle. The bug:
 * the header's click wrote to wsCollapsed and flipped the caret, but the memo
 * never READ the set, so every chat stayed on screen — a header that looked
 * collapsible and did nothing. Only the DOM can catch that: the caret glyph
 * changed while the row list did not. */
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (msg) => { console.error(`#18 REGRESSION: ${msg}`); process.exit(1); };
  const headers = () => [...w.document.querySelectorAll(".wsheader")];
  const itemIds = () =>
    [...w.document.querySelectorAll(".agent-item")]
      .map((el) => el.textContent.match(/\b(alpha|beta)\b/)?.[1])
      .filter(Boolean);

  const before = itemIds();
  if (before.length !== 2) fail(`fixture should start with 2 chats, got ${before.length}`);
  // match on the header's title (the workspace PATH), never its textContent:
  // that includes the caret glyph, which is exactly what the click flips.
  // `startsWith`, not `===`: a collapsed header's title gains a suffix
  // ("— collapsed (N chats hidden)"), and an exact match silently stops
  // finding it — which reads as "the reopen click does nothing".
  const headerFor = (ws) => headers().find((h) => h.getAttribute("title")?.startsWith(ws));
  const target = headerFor(AGENT.workspace);
  if (!target) fail(`no header for ${AGENT.workspace}: ${headers().map((h) => h.getAttribute("title"))}`);
  const wasCollapsed = /▸/.test(target.querySelector(".wscaret")?.textContent ?? "");

  target.click();
  await sleep(120);
  const after = itemIds();
  const caret = headerFor(AGENT.workspace)?.querySelector(".wscaret")?.textContent ?? "";

  // clicking must FLIP the caret: ▸ (collapsed) ↔ ▾ (open). Comparing against
  // the expected new value is what hides the bug — assert it actually changed
  if (caret === (wasCollapsed ? "▸" : "▾"))
    fail(
      `the caret did not flip — still "${caret}" after clicking a ${wasCollapsed ? "collapsed" : "open"} group`,
    );
  if (after.length === before.length)
    fail(
      `clicking a workspace header must hide its chats — still ${after.length} rows (${JSON.stringify(after)})`,
    );
  // alpha's workspace collapses; beta's chat must survive
  if (after.includes("alpha")) fail(`alpha stayed visible after collapsing its group: ${JSON.stringify(after)}`);
  if (!after.includes("beta")) fail(`beta belongs to another group and must stay: ${JSON.stringify(after)}`);
  // exactly one header survives per visible group — the collapsed one stays
  // clickable, otherwise the operator can never reopen it
  if (headers().length !== 2)
    fail(`a collapsed group must keep its header so it can be reopened, got ${headers().length}`);

  // …and clicking again restores it. Re-query the header: Solid may have
  // replaced the node (the collapsed header renders different content), and a
  // click on a DETACHED element is a silent no-op that looks like a bug.
  headerFor(AGENT.workspace)?.click();
  await sleep(120);
  const restored = itemIds();
  if (restored.length !== 2)
    fail(`reopening must restore every chat, got ${JSON.stringify(restored)}`);
  console.log("deep render ok: a workspace group really collapses and reopens (#18)");
}

/* ---------- #18: separate chats sharing ONE working directory --------------
 * "Some top-level chat dirs exist in the same working directory but are
 * separate." Grouping by workspace path alone gave every chat in a directory
 * ONE identity — one header, one collapse toggle, one row to hide. A count
 * badge said "there are 2" without making them separate things.
 *
 * Each top-level chat is now its own group, nested under the workspace header
 * it shares. The base fixture has one chat per directory, so this block swaps in
 * a third agent pointing at alpha's SAME workspace and asserts the two render as
 * two independently collapsible groups. */
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (msg) => { console.error(`#18 REGRESSION: ${msg}`); process.exit(1); };
  const origFetch = globalThis.fetch;
  const THIRD = { ...AGENT, id: "gamma", workspace: AGENT.workspace }; // same dir!
  // #106: GAMMA has a sub-agent, alpha and beta do not. The collapse round-trip
  // below must hide something REAL, so it targets gamma — and that also makes the
  // #106 distinction checkable in the same fixture: alpha (childless, expanded)
  // must have no caret, gamma (has children) must have one.
  const GAMMA_SUB = { ...AGENT, id: "gamma-sub", parent: "gamma", workspace: AGENT.workspace };
  // #106: DELTA is a CHILDLESS chat that is COLLAPSED — the strand state, and the
  // only situation where `chatCollapsedGroup` is the sole reason a caret renders.
  // Two ordinary paths reach it: an upgrade (every chat was collapsed under the
  // old header), and a chat that had sub-agents, was collapsed, then lost them.
  // The fixture had no such case, so removing the `chatCollapsedGroup` clause
  // from the gate still passed — it was guarding nothing.
  // #113: DELTA's workspace. #106 shows the caret when a chat is COLLAPSED, so
  // `delta-sub`'s row is suppressed while `delta` is collapsed — and `delta`'s row
  // is not a child of anything, so it shows. That is correct: a collapsed chat
  // keeps its row so it can be reopened, and its sub-agents hide.
  const DELTA = { ...AGENT, id: "delta", workspace: "/tmp/ws" };
  // delta starts WITH a sub-agent, so its caret is real and can be clicked. The
  // sub-agent is then removed over the bus, which is the second ordinary path
  // into the strand state: a chat that was collapsed while it had children, and
  // has since lost them. (The bundle already loaded, so a stale localStorage key
  // planted now would never be read — reaching the state through the UI is both
  // possible and closer to what an operator does.)
  const DELTA_SUB = { ...AGENT, id: "delta-sub", parent: "delta", workspace: "/tmp/other-project" };
  setGlobal("fetch", async (url, init) => {
    const raw = String(url).replace(/^https?:\/\/[^/]+/, "");
    const u = raw.split("?")[0];
    if (u === "/api/agents")
      return {
        ok: true,
        status: 200,
        json: async () => ({
          agents: [
            AGENT,
            { ...AGENT, id: "beta", workspace: "/tmp/other-project" },
            THIRD,
            GAMMA_SUB,
            DELTA,
            DELTA_SUB,
          ],
        }),
      };
    return origFetch(url, init);
  });
  // Push the NEW agent over the bus: the agent-update handler appends an agent
  // it has not seen before (an existing id is replaced in place), which is the
  // real server's path for "a session appeared". The /api/agents stub above is
  // the belt-and-braces for the polling refresh.
  const sock = MockWS.instances.at(-1);
  sock?.onmessage?.({
    data: JSON.stringify({ kind: "agent-update", agentId: THIRD.id, snapshot: THIRD }),
  });
  // #106: push gamma's and delta's sub-agents, so both have something to collapse
  sock?.onmessage?.({
    data: JSON.stringify({ kind: "agent-update", agentId: GAMMA_SUB.id, snapshot: GAMMA_SUB }),
  });
  sock?.onmessage?.({
    data: JSON.stringify({ kind: "agent-update", agentId: DELTA.id, snapshot: DELTA }),
  });
  sock?.onmessage?.({
    data: JSON.stringify({ kind: "agent-update", agentId: DELTA_SUB.id, snapshot: DELTA_SUB }),
  });
  await sleep(300);

  const headerFor = (ws) =>
    [...w.document.querySelectorAll(".wsheader")].find((h) => h.getAttribute("title")?.startsWith(ws));
  const sharedHeader = headerFor(AGENT.workspace);
  if (!sharedHeader) fail("the shared workspace lost its header entirely (#18)");

  // ONE workspace header per CONTIGUOUS run of that directory in tree order.
  // alpha and gamma share /tmp/ws but beta sits between them, so the directory
  // legitimately appears as two runs — each needs its own header to keep the
  // chats under it visually contiguous.
  const wsTitles = [...w.document.querySelectorAll(".wsheader")].map((h) => h.getAttribute("title") ?? "");
  const sharedRuns = wsTitles.filter((t) => t.startsWith(AGENT.workspace)).length;
  if (sharedRuns < 1) fail(`the shared directory lost its header entirely: ${JSON.stringify(wsTitles)}`);
  // headers alternate: every workspace header should be distinct from its
  // neighbour, i.e. a header is never emitted twice in a row for one directory
  for (let i = 1; i < wsTitles.length; i++) {
    if (wsTitles[i] === wsTitles[i - 1])
      fail(`consecutive identical workspace headers: ${JSON.stringify(wsTitles)}`);
  }

  // …and alpha and gamma are SEPARATE chats sharing that one directory. There
  // is no chat header any more (it only restated each chat's own name, so a
  // six-chat directory rendered thirteen rows): the chat ROW carries the caret,
  // which is what makes the chat its own collapsible group.
  // The row text is e.g. "▾gamma" — the caret glyph ABUTS the name, so a
  // whitespace-anchored match never fires. Strip the glyphs and badges first,
  // then require the id as a whole token.
  //
  // `\\bdelta\\b` alone is wrong: it also matches inside "delta-sub", so a
  // hyphenated sub-agent id hijacked the parent's row lookup (#106).
  const rowText = (el) =>
    el.textContent.replace(/[▾▸🔔🧩✓]/g, "").replace(/\d+/g, "").trim();
  const rowFor = (id) =>
    [...w.document.querySelectorAll(".agent-item")].find((el) => {
      const parts = rowText(el).split(/\s+/);
      return parts.includes(id) || rowText(el) === id;
    });
  const caretIn = (el) => el?.querySelector(".caret");
  // #106: a caret that collapses nothing is noise. alpha and beta are CHILDLESS
  // and not collapsed, so they must NOT offer one; gamma HAS a sub-agent, so its
  // caret is real and must be there.
  //
  // The #18 requirement this narrows was that a chat must stay REACHABLE, and it
  // still holds: `sidebarRowsOf` renders a collapsed chat's row marked
  // `chatCollapsedGroup`, and the gate below keeps the caret for exactly that
  // state — so a chat collapsed by a stale key, or by having had sub-agents, can
  // always be reopened.
  for (const id of ["alpha", "beta"]) {
    if (caretIn(rowFor(id)))
      fail(`${id} has no sub-agents, so it must not offer a collapse caret (#106)`);
  }
  if (!caretIn(rowFor("gamma")))
    fail("gamma HAS a sub-agent, so its collapse caret must be present (#106)");

  const chats2 = [...w.document.querySelectorAll(".agent-item")]
    .map((el) => el.textContent.match(/\b(alpha|beta|gamma)\b/)?.[1])
    .filter(Boolean);
  if (!chats2.includes("alpha") || !chats2.includes("gamma"))
    fail(`both chats of the shared directory must be listed separately, got ${JSON.stringify(chats2)}`);

  // THE ASSERTION THE BUG WAS ABOUT: collapsing ONE chat must leave its
  // sibling in the SAME directory visible. Sharing one group (the old
  // behaviour) made this impossible — they collapsed together.
  caretIn(rowFor("gamma"))?.click();
  await sleep(200);
  const afterOne = [...w.document.querySelectorAll(".agent-item")]
    .map((el) => el.textContent.match(/\b(alpha|beta|gamma)\b/)?.[1])
    .filter(Boolean);
  // The collapsed chat stays as a ROW rather than vanishing: with the chat header
  // gone, that row is the only control that can reopen it, so hiding it would
  // strand the chat. What must be true is that it is marked collapsed and that
  // its own sub-agents are gone.
  //
  // #106: this collapses GAMMA, which has a sub-agent. Collapsing `alpha` used
  // to be the check, but #106 removed the caret from a childless chat — so the
  // test was clicking a control that correctly no longer exists.
  const alphaAfter = rowFor("gamma");
  if (!alphaAfter)
    fail(`a collapsed chat must keep its row so it can be reopened (#18)`);
  if (!alphaAfter.className.includes("collapsed"))
    fail(`a collapsed chat must be marked collapsed, got ${JSON.stringify(alphaAfter.className)}`);
  if (caretIn(alphaAfter)?.textContent.trim() !== "▸")
    fail(`a collapsed chat's caret must point closed, got ${JSON.stringify(caretIn(alphaAfter)?.textContent)}`);
  if (!afterOne.includes("alpha"))
    fail(`alpha shares a DIRECTORY but is a separate chat — it must stay visible, got ${JSON.stringify(afterOne)}`);
  // #106: collapsing gamma must hide its own sub-agent
  if (afterOne.includes("gamma-sub"))
    fail(`a collapsed chat must hide its sub-agents (#106), got ${JSON.stringify(afterOne)}`);
  if (!afterOne.includes("beta"))
    fail(`beta is in another project entirely and must stay visible, got ${JSON.stringify(afterOne)}`);

  // …and the collapse survives, so the chat can be brought back. This is the
  // strand-a-chat guard: with the header gone the row caret is the only control,
  // so it has to work in BOTH directions.
  //
  // Both steps were defects in this check, found by mutating the gate away and
  // watching it still pass:
  //   - `caretIn(...)?.click()` silently no-ops when the caret is MISSING, which
  //     is exactly the strand state. It must be a hard failure.
  //   - it then asserted on `alpha`, which is never collapsed — so it was
  //     checking nothing. It is GAMMA that gets collapsed here.
  const reopenCaret = caretIn(alphaAfter);
  if (!reopenCaret)
    fail("a collapsed chat MUST keep its caret — it is the only control that can reopen it (#106)");
  reopenCaret.click();
  await sleep(200);
  const reopened = [...w.document.querySelectorAll(".agent-item")]
    .map((el) => el.textContent.match(/\b(alpha|beta|gamma)\b/)?.[1])
    .filter(Boolean);
  if (!reopened.includes("gamma")) fail(`reopening must restore gamma, got ${JSON.stringify(reopened)}`);
  if (rowFor("gamma")?.className.includes("collapsed"))
    fail(`reopened gamma must no longer read as collapsed (#18)`);
  // and the sub-agent it was hiding must come back with it
  if (caretIn(rowFor("gamma"))?.textContent.trim() !== "▾")
    fail(`reopened gamma must point its caret open (#18/#106)`);

  // #106 THE STRAND STATE IS NOT CHECKED HERE, AND THAT IS A DELIBERATE CHOICE.
  //
  // Reaching it needs a chat that is childless AND collapsed, which requires the
  // sub-agent to be gone from `agents()` — not merely hidden. `treeRowsOf` hides a
  // collapsed chat's children while they remain in the list, so removing the
  // rendered row proves nothing: the has-children branch still fires and the
  // caret renders either way. Driving it through the poller took ~11s of
  // timing-dependent DOM work, and deleting the strand clause from the gate STILL
  // passed. A check that cannot fail is worse than no check.
  //
  // The gate is a pure function of three booleans, so it is tested directly in
  // test/sidebar-caret-gate.test.ts across all four states. That is deterministic
  // and the mutation fails it. This bundle check covers only what IS reachable
  // here: a childless expanded chat has no caret, and a chat with sub-agents does.

  // a chat with NO sub-agents is still collapsible — the header existed for
  // exactly this case, so dropping it must not drop the capability
  if (!caretIn(rowFor("gamma")))
    fail("a childless top-level chat must still offer a collapse caret (#18)");

  // and collapsing the WORKSPACE still hides every chat under it
  headerFor(AGENT.workspace)?.click();
  await sleep(200);
  const afterWs = [...w.document.querySelectorAll(".agent-item")]
    .map((el) => el.textContent.match(/\b(alpha|beta|gamma)\b/)?.[1])
    .filter(Boolean);
  if (afterWs.includes("alpha") || afterWs.includes("gamma"))
    fail(`collapsing the directory must hide both of its chats, got ${JSON.stringify(afterWs)}`);
  headerFor(AGENT.workspace)?.click();
  await sleep(200);

  setGlobal("fetch", origFetch);
  console.log("deep render ok: chats sharing one directory are SEPARATE groups (#18)");
}

/* ---------- #18: a COLLAPSED group must still say how much it hides --------
 * The count badge is the only thing telling the operator what a collapsed
 * header took off screen. Hiding it along with the chats left a ▸ next to a
 * bare project name — no way to know a conversation was in there at all. */
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (msg) => { console.error(`#18 REGRESSION: ${msg}`); process.exit(1); };
  const headers = () => [...w.document.querySelectorAll(".wsheader")];
  const headerFor = (ws) => headers().find((h) => h.getAttribute("title")?.startsWith(ws));

  // /tmp/other-project holds exactly ONE chat (beta): its header must show no
  // count badge while open — a "1" badge is noise.
  const soloHeader = headerFor("/tmp/other-project");
  if (!soloHeader) fail("the single-chat project lost its header (#18)");
  if (soloHeader.querySelector(".wscount"))
    fail(`a single-chat project must not show a count badge: ${soloHeader.textContent}`);

  soloHeader.click(); // collapse it
  await sleep(150);
  const collapsedHeader = headerFor("/tmp/other-project");
  if (!collapsedHeader) fail("collapsing removed the header — no way to reopen (#18)");
  const badge = collapsedHeader.querySelector(".wscount");
  if (!badge) fail(`a collapsed group must still show how many chats it hides (#18): ${collapsedHeader.textContent}`);
  if (badge.textContent.trim() !== "1")
    fail(`a collapsed single-chat group should read 1, got ${JSON.stringify(badge.textContent)}`);
  if (!/collapsed/i.test(collapsedHeader.getAttribute("title") ?? ""))
    fail("a collapsed header's tooltip should say so (#18)");
  // singular grammar: the common single-chat case must not read "1 chats hidden"
  if (/1 chats/.test(collapsedHeader.getAttribute("title") ?? ""))
    fail(`a one-chat group must read "1 chat hidden", got ${JSON.stringify(collapsedHeader.getAttribute("title"))}`);
  if ([...w.document.querySelectorAll(".agent-item")].some((el) => /beta/.test(el.textContent)))
    fail("beta's chat should be hidden while its group is collapsed (#18)");

  collapsedHeader.click(); // restore
  await sleep(150);
  if (![...w.document.querySelectorAll(".agent-item")].some((el) => /beta/.test(el.textContent)))
    fail("reopening must bring beta's chat back (#18)");
  // the OTHER groups are untouched by collapsing this one
  if (![...w.document.querySelectorAll(".agent-item")].some((el) => /alpha|gamma/.test(el.textContent)))
    fail("collapsing one project must not disturb the others (#18)");
  console.log("deep render ok: a collapsed group still reports what it hides (#18)");
}

/* ---------- #50: WIDE mode must be untouched by the drawer work ----------
 * The narrow fixes added a backdrop and a ✕ row. Both are drawer-only, and a
 * mistake in either (rendering them unconditionally) would be catastrophic on a
 * wide screen: a full-screen click-catcher swallows every click in the app, and
 * a ✕ row is a dead control sitting above the session card.
 *
 * This runs on the DEFAULT 1440 path, so it covers the common case, and it
 * toggles the panel — including the open state, in which a wrongly-unconditional
 * backdrop would be mounted. */
{
  const sleepW = (ms) => new Promise((r) => setTimeout(r, ms));
  const failW = (msg) => { console.error(`#50 WIDE REGRESSION: ${msg}`); process.exit(1); };
  if (Number(process.env.SMOKE_WIDTH ?? 1440) > 1100) {
    const bar = () => w.document.querySelector(".rightbar");
    const toggle = [...w.document.querySelectorAll(".iconbtn")].find(
      (b) => /toggle details panel/.test(b.getAttribute("title") ?? ""),
    );
    if (!toggle) failW("no ▤ details-panel toggle found");
    if (!bar()?.classList.contains("open")) toggle.click(); // wide starts open; close first
    await sleepW(80);
    if (!bar()?.classList.contains("open")) failW("could not open the panel on a wide screen");
    if (w.document.querySelector(".rightbarbackdrop"))
      failW("a full-screen backdrop is mounted on a wide screen — it would swallow every click in the app");
    const head = w.document.querySelector(".rightbarhead");
    if (head && w.document.defaultView.getComputedStyle(head).display !== "none")
      failW("the drawer-only ✕ row is visible on a wide screen");
    toggle.click(); // …and it still toggles inline
    await sleepW(80);
    if (bar()?.classList.contains("open")) failW("the ▤ toggle no longer closes the panel");
    if (w.document.querySelector(".rightbarbackdrop"))
      failW("backdrop mounted after closing on a wide screen");
    console.log("deep render ok: wide panel is an inline toggle, no drawer chrome (#50)");
  }
}

/* ---------- #50: the narrow-screen drawer must be closable ----------------
 * Below 1100px .rightbar becomes a fixed drawer OVER the content, so the ▤
 * button that opened it is covered. Driving the real UI at 900px proves the
 * operator can actually get back out — via the ✕, via a click outside, and
 * via Escape — and that Escape does not stop a running agent on the way. */
if (Number(process.env.SMOKE_WIDTH ?? 1440) <= 1100) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const drawer = () => w.document.querySelector(".rightbar");
  const drawerOpen = () => drawer()?.classList.contains("open") ?? false;
  const fail = (msg) => { console.error(`#50 REGRESSION: ${msg}`); process.exit(1); };

  // open it the way a user does: the ▤ toggle in the channel header
  const toggle = [...w.document.querySelectorAll(".iconbtn")].find(
    (b) => /toggle details panel/.test(b.getAttribute("title") ?? ""),
  );
  if (!toggle) fail("no ▤ details-panel toggle found");
  if (!drawerOpen()) toggle.click();
  await sleep(80);
  if (!drawerOpen()) fail("the ▤ toggle did not open the drawer at narrow width");

  // 1. the ✕ row must exist, live INSIDE .rightbar, and close the drawer.
  //    `.rightbarhead .iconbtn` is a descendant selector, so finding it at all
  //    proves containment; the explicit `contains` check names the requirement so
  //    a future refactor that re-parents the row fails loudly.
  const closeBtn = [...w.document.querySelectorAll(".rightbarhead .iconbtn")].find(
    (b) => /close details panel/.test(b.getAttribute("title") ?? ""),
  );
  if (!closeBtn) fail("no ✕ close button inside the drawer — the drawer covers its own opener");
  if (!drawer().contains(closeBtn))
    fail("the ✕ is not a descendant of .rightbar — it must travel with the panel (#50)");

  // …and it must actually be VISIBLE. This is the check that matters: the row
  // existed, sat inside the panel and was sticky while still computing to
  // display:none, because the minifier hoists media-query rules above the base
  // rule and equal specificity then loses the cascade. happy-dom applies media
  // queries at parse time, so this scenario — which loads NARROW — is the only
  // place that bug is observable.
  {
    const row = w.document.querySelector(".rightbarhead");
    const cs = w.document.defaultView.getComputedStyle(row);
    if (cs.display === "none" || cs.display === "hidden")
      fail(`the ✕ row is ${cs.display} at narrow width — the drawer has no visible way out (#50)`);
    if (cs.position !== "sticky")
      fail(`the ✕ row must be sticky (got position:${cs.position}) (#50)`);
  }

  // Make the panel genuinely scrollable first: assigning scrollTop to an
  // element with no overflow is a silent no-op, so every assertion below
  // would pass vacuously. Injected filler stands in for the real long body.
  {
    const filler = w.document.createElement("div");
    filler.style.height = "4000px";
    drawer().appendChild(filler);
    await sleep(30);
    const el = drawer();
    el.scrollTop = el.scrollHeight; // all the way to the bottom
    w.dispatchEvent(new w.Event("scroll", { bubbles: true }));
    await sleep(60);
    const head = w.document.querySelector(".rightbarhead");
    if (!head || !drawer().contains(head)) fail("the ✕ row left the panel after a scroll (#50)");
    const cs = w.document.defaultView.getComputedStyle(head);
    if (cs.position !== "sticky")
      fail(`the ✕ row must be sticky so scrolling cannot hide it (got position:${cs.position}) (#50)`);
    // the control itself must still be pressable at the bottom of the panel
    const btn = head.querySelector(".iconbtn");
    if (!btn) fail("the ✕ button vanished from the row after scrolling (#50)");
    btn.click();
    await sleep(80);
    if (drawerOpen()) fail("the ✕ did not close the drawer after scrolling to the bottom");
    filler.remove();
    await sleep(20);
  }

  // 2. a click outside must dismiss it too
  toggle.click();
  await sleep(80);
  if (!drawerOpen()) fail("re-opening the drawer failed");
  const backdrop = w.document.querySelector(".rightbarbackdrop");
  if (!backdrop) fail("no click-outside backdrop while the drawer is open");
  backdrop.click();
  await sleep(80);
  if (drawerOpen()) fail("clicking outside did not dismiss the drawer");
  // and it must not linger as a blocker once closed
  if (w.document.querySelector(".rightbarbackdrop"))
    fail("backdrop still mounted after close — it would swallow every click in the app");

  // 3. Escape closes it WITHOUT stopping a running agent. The old handler
  //    reached the /stop branch first, so Esc interrupted the agent and left
  //    the panel open — the exact "can't close it" symptom.
  //
  //    The agent MUST be running for this to mean anything: with an idle agent
  //    the /stop branch is never reached, so a regression that moved the drawer
  //    close back behind it would still pass. Earlier blocks in this script
  //    leave /api/agents stubbed to their own fixtures, so pin the status here
  //    rather than inheriting whatever they happened to leave behind — and
  //    wait for the UI to show it, so we are not racing the poll.
  const stopCalls = [];
  const realFetch = globalThis.fetch;
  const RUNNING_FOR_ESC = { ...AGENT, status: "running" };
  setGlobal("fetch", async (url, init) => {
    const raw = String(url).replace(/^https?:\/\/[^/]+/, "");
    const u = raw.split("?")[0];
    if (u.endsWith("/stop")) {
      stopCalls.push(u);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (u === "/api/agents")
      return { ok: true, status: 200, json: async () => ({ agents: [RUNNING_FOR_ESC] }) };
    return realFetch(url, init);
  });
  // nudge the app to re-poll, then wait for the running badge to actually render
  MockWS.instances.at(-1)?.onmessage?.({
    data: JSON.stringify({ kind: "agent-update", agentId: AGENT.id, snapshot: RUNNING_FOR_ESC }),
  });
  const agentIsRunning = await waitFor("agent shows as running", () =>
    [...w.document.querySelectorAll(".badge")].some((b) => b.textContent.trim() === "running"),
  );
  if (!agentIsRunning)
    fail("agent never reported as running — the Escape assertion below would prove nothing");

  toggle.click();
  await sleep(80);
  if (!drawerOpen()) fail("could not re-open the drawer for the Escape check");
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(120);
  if (drawerOpen()) fail("Escape did not close the drawer (agent running)");
  if (stopCalls.length)
    fail(`Escape stopped the agent instead of closing the drawer (${stopCalls.length} /stop call/s)`);
  console.log("deep render ok: narrow drawer closes via ✕, click-outside and Escape (#50)");

  // a closed drawer must leave the UI interactive
  if (w.document.querySelector(".rightbarbackdrop")) fail("backdrop left mounted");

  // 4. with the drawer closed, Escape still reaches the interrupt — the panel
  //    must not permanently shadow it. This is the other half of the reordering.
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(120);
  if (!stopCalls.length)
    fail("Escape no longer stops the running agent once the drawer is closed — the panel shadowed it forever");
  console.log("deep render ok: Escape still interrupts a running agent when no drawer is open (#50)");

  /* ---------- #53: a CLOSED drawer must leave nothing painted -------------
   * Reported: "on a narrow screen the right panel leaves a shadow behind even
   * after it is closed — it gets in the way".
   *
   * The drawer is slid off-screen with `transform: translateX(100%)` rather
   * than hidden, so its own `box-shadow: -8px 0 24px` still paints at the
   * screen edge. The element is "off-screen", not "gone", and a shadow is the
   * one thing about it that still lands inside the viewport.
   *
   * This checks COMPUTED style, which is the only way to see it: querying for
   * the element proves nothing, because the drawer is always in the DOM. */
  {
    const cs = (sel, prop) => {
      const el = w.document.querySelector(sel);
      return el ? w.document.defaultView.getComputedStyle(el).getPropertyValue(prop) : null;
    };
    const isNone = (v) => !v || v === "none" || v === "0px" || v === "";

    // closed: no shadow, no visible box
    const shadowClosed = cs(".rightbar", "box-shadow");
    if (!isNone(shadowClosed))
      fail(`a CLOSED drawer must not paint a box-shadow, got ${JSON.stringify(shadowClosed)} (#53)`);
    if (cs(".rightbar", "visibility") === "visible" && !isNone(cs(".rightbar", "opacity")))
      fail(`a closed drawer must not be painted, opacity=${cs(".rightbar", "opacity")} (#53)`);

    // and the backdrop must be gone entirely, not merely transparent
    const bd = w.document.querySelector(".rightbarbackdrop");
    if (bd) {
      const disp = w.document.defaultView.getComputedStyle(bd).display;
      const op = w.document.defaultView.getComputedStyle(bd).opacity;
      if (disp !== "none" && op !== "0" && Number(op) !== 0)
        fail(`a closed drawer must not leave a click-catching backdrop (display=${disp}, opacity=${op}) (#53)`);
    }

    // open: the shadow IS wanted — it lifts the drawer off the content
    toggle.click();
    await sleep(120);
    if (!drawerOpen()) fail("could not re-open the drawer for the shadow check (#53)");
    const shadowOpen = cs(".rightbar", "box-shadow");
    if (isNone(shadowOpen))
      fail(`an OPEN drawer must cast its shadow, got ${JSON.stringify(shadowOpen)} (#53)`);
    toggle.click();
    await sleep(120);
    if (cs(".rightbar", "box-shadow") !== shadowClosed)
      fail(`closing must restore the no-shadow state (#53)`);
    console.log("deep render ok: a closed drawer leaves nothing painted (#53)");
  }

  setGlobal("fetch", realFetch);
}

/* ---------- #50: narrowing an already-loaded window ----------------------
 * The REPORTED flow is not "open the app on a narrow screen" but "make the
 * window narrower while it is running". That is the case the drawer scenario
 * above cannot reach: happy-dom evaluates media queries once at parse time, so
 * a scenario that loads narrow proves nothing about a mid-session resize.
 *
 * What does break here is the JS half. `<Show when={isNarrow() && …}>` reads
 * window.innerWidth during render and never again — it is not a signal, so no
 * resize re-ran the branch. After narrowing, the drawer opened with NO
 * click-outside backdrop at all: the exact state the fix was meant to cure.
 *
 * The media query itself is not re-evaluated either; what is asserted here is
 * the reactive JS (the backdrop), which is ours to own. */
if (Number(process.env.SMOKE_WIDTH ?? 1440) > 1100) {
  const sleepR = (ms) => new Promise((r) => setTimeout(r, ms));
  const failR = (msg) => { console.error(`#50 RESIZE REGRESSION: ${msg}`); process.exit(1); };
  const barOpen = () => w.document.querySelector(".rightbar")?.classList.contains("open") ?? false;
  const detailToggle = () =>
    [...w.document.querySelectorAll(".iconbtn")].find(
      (b) => /toggle details panel/.test(b.getAttribute("title") ?? ""),
    );

  // wide load → panel is a column, open by default, no drawer chrome.
  // (The wide-mode block above finishes by CLOSING it, so open it here rather
  // than inherit whatever it left behind.)
  if (!barOpen()) detailToggle().click();
  await sleepR(80);
  if (!barOpen()) failR("panel not open at wide load");
  if (w.document.querySelector(".rightbarbackdrop")) failR("backdrop present on a wide screen");

  // NARROW the window, exactly as dragging the splitter would
  viewportWidth = 900;
  w.dispatchEvent(new w.Event("resize"));
  await sleepR(120);
  if (!barOpen()) failR("narrowing the window closed the panel outright");

  const closeBtn = [...w.document.querySelectorAll(".rightbarhead .iconbtn")].find(
    (b) => /close details panel/.test(b.getAttribute("title") ?? ""),
  );
  if (!closeBtn) failR("no ✕ after narrowing — the drawer covers its own opener");

  // the backdrop must APPEAR on the resize, not just on a fresh narrow load
  if (!w.document.querySelector(".rightbarbackdrop"))
    failR("narrowing the window mounted no click-outside backdrop (isNarrow is not reactive)");
  console.log("deep render ok: narrowing the window arms the drawer's close paths (#50)");

  // …and all three close paths still work after the resize
  closeBtn.click(); await sleepR(80);
  if (barOpen()) failR("✕ did not close the drawer after a resize");
  detailToggle().click(); await sleepR(80);
  if (!barOpen()) failR("could not re-open after a resize");
  w.document.querySelector(".rightbarbackdrop").click(); await sleepR(80);
  if (barOpen()) failR("click-outside did not dismiss after a resize");

  // WIDENING BACK must disarm the drawer again. The backdrop is gated on the
  // `narrow` signal, so a resize back to a wide viewport has to REMOVE it — a
  // full-screen click-catcher left over at 1400px would swallow every click in
  // the app while the panel is an ordinary column. This is the mirror of the
  // narrow case, and it was the direction nothing covered.
  detailToggle().click(); await sleepR(80);
  if (!barOpen()) failR("could not re-open the panel before widening");
  viewportWidth = 1400;
  w.dispatchEvent(new w.Event("resize"));
  await sleepR(120);
  if (w.document.querySelector(".rightbarbackdrop"))
    failR("backdrop still mounted after widening — it would swallow every click in the app (#50)");
  const wideHead = w.document.querySelector(".rightbarhead");
  if (wideHead && w.document.defaultView.getComputedStyle(wideHead).display !== "none")
    failR("the ✕ row is still visible after widening back to a wide screen (#50)");
  if (!barOpen()) failR("widening closed the panel — on a wide screen it is a column (#50)");
  detailToggle().click(); await sleepR(80);
  if (barOpen()) failR("the ▤ toggle stopped working on a wide screen after a resize (#50)");
  // ---------- #63: a child's activity must NOT appear in the parent's feed ----------
  // The master used to mirror every child prompt/message/tool_call into the
  // parent's log. Those rows were invisible for as long as "sub" was missing
  // from FEED_TYPES; once they became visible the parent's timeline was
  // flooded, which is the opposite of what a chat's timeline is for. They are
  // display-only either way — `rebuildMessagesFrom` never read them, so the
  // model never saw them either.
  {
    const feedText63 = w.document.querySelector(".feed")?.textContent ?? "";
    // the child's tool output must NOT be in the parent's feed
    if (feedText63.includes("child.txt"))
      failR(`a child's tool output must not appear in the parent's feed (#63)`);
    // …but its REPORT arrives as a harness prompt, which is the real channel
    if (!feedText63.includes("CHILD REPORT TEXT"))
      failR(`the child's report must still reach the parent (#63), got: ${JSON.stringify(feedText63.slice(0, 300))}`);
    if (!/harness/i.test(feedText63))
      failR(`the report must be attributed to the harness, not the child (#63)`);
    // and no row is attributed to a child actor any more
    const chips63 = [...w.document.querySelectorAll(".actor")].map((el) => el.textContent.trim());
    if (chips63.some((t) => t.includes("alpha-kid")))
      failR(`the parent must carry no child attribution (#63), got ${JSON.stringify(chips63)}`);
  }
  console.log("deep render ok: the parent's feed shows only its own work (#63)");

  console.log("deep render ok: widening back disarms the drawer without breaking the column (#50)");
}

// give deferred Solid effects a final tick before declaring victory
await new Promise((r) => setTimeout(r, 120));
console.log(`first render survived (${fetchCount} api calls served)`);
process.exit(0);
