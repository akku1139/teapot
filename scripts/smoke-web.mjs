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
  const box = w.document.getElementById("todo-input");
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
  // that includes the caret glyph, which is exactly what the click flips
  const headerFor = (ws) => headers().find((h) => h.getAttribute("title") === ws);
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

  // …and clicking again restores it
  headerFor(AGENT.workspace)?.click();
  await sleep(120);
  const restored = itemIds();
  if (restored.length !== 2)
    fail(`reopening must restore every chat, got ${JSON.stringify(restored)}`);
  console.log("deep render ok: a workspace group really collapses and reopens (#18)");
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
  console.log("deep render ok: widening back disarms the drawer without breaking the column (#50)");
}

// give deferred Solid effects a final tick before declaring victory
await new Promise((r) => setTimeout(r, 120));
console.log(`first render survived (${fetchCount} api calls served)`);
process.exit(0);
