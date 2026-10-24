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
  /**
   * The REAL value an idle agent carries.
   *
   * `setStatus` writes a reason on every transition, and the loop ends with "round complete" —
   * so an idle agent in production always has one. The fixture said "" and that made the
   * bare-ℹ check below pass VACUOUSLY: the glyph only rendered when the reason was set, so it
   * could never have caught the thing it was written for.
   */
  statusReason: "round complete",
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
    // a LONG command: `bash` only renders the command block when it differs from the one-line
    // summary label, so a short "ls" exercises neither shiki nor the parameter styling
    type: "tool_call", data: { callId: "c1", name: "bash", args: { // longer than the 96-char summary label, or `cmd === label.slice(2)` and the block is skipped
      command: "echo SHIKI_MARKER --flag=value --another-flag=value2 --third-flag=value3 --fourth-flag=value4 --fifth-flag=value5 --sixth" } } },
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
      // the stub has a provider, so this is NOT a first run; the first-run flow gets its own
      // check below by overriding this endpoint
      needsSetup: false,
      providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1" } },
      defaultProvider: "openrouter",
      mcpServers: [{ name: "files", url: "https://mcp.example/mcp", transport: "http", enabled: true }],
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
  // one real skill, so the settings list has something to show: an empty stub cannot tell
  // "the list works" from "the list is empty by design"
  if (u === `/api/agents/${AGENT.id}/skills`)
    return {
      skills: [
        {
          name: "headless-firefox-debug",
          description: "Debug layout and scroll bugs in a real engine over Marionette",
          source: "global",
        },
      ],
    };
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
  // archive: one entry with a real session count, so the panel's warning can name
  // a number. Empty-restore is covered by the server test.
  // #67: one server in the "connected" state, so the panel's status pill has
  // something real to render
  if (u === "/api/mcp")
    return {
      servers: [{ name: "files", url: "https://mcp.example/mcp", transport: "http", enabled: true }],
      states: [{ name: "files", status: "connected", tools: 4 }],
    };
  // A server that answers a 401 Bearer challenge in production. The status endpoint
  // reports it as required-but-not-authorized, which is what draws the "authorize"
  // button — the whole point of automatic detection.
  if (u === "/api/mcp/oauth/status")
    return {
      required: true,
      authorized: false,
      hasRefreshToken: false,
      scopes: ["mcp.read"],
      flow: { phase: "idle" },
    };
  if (u === "/api/plugins") return { pluginsDir: null, plugins: [] };
  if (u === "/api/archived")
    return {
      agents: [
        { id: "shelved", workspace: "/tmp/shelved-project", archivedAt: Date.now() - 86_400_000, sessions: 3 },
      ],
    };
  if (u === "/api/personas") return { personas: [] };
  return { ok: true };
}

let fetchCount = 0;
/** every URL the app asked for — lets a test assert WHICH session it opened (#58) */
const requestedUrls: string[] = [];

/* ---------- happy-dom globals ---------- */

// WebSocket mock, installed BEFORE the bundle import: happy-dom's socket
// fires "open" even with no server, so the app would otherwise sit connected
// and never touch our later mocks. Captured instances let the test push bus
// events into the app exactly like the real server does.
const WS_EVENTS = []; // queued {kind, ...} messages delivered on open
class MockWS {
  // typed explicitly: `static instances = []` infers `never[]`, so every read out of it
  // (`MockWS.instances.at(-1)`) was `never` and every field access on it an error. The
  // check helpers below drive the socket through these, so the shape has to be declared.
  static instances: MockWS[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(_data: string) {
    /* outbound (pong etc.) — ignored */
  }
  close(): void {
    this.readyState = 3;
  }
  constructor(url: string) {
    this.url = url;
    MockWS.instances.push(this);
    this.readyState = 1;
    queueMicrotask(() => {
      this.onopen?.();
      for (const m of WS_EVENTS.splice(0)) this.onmessage?.({ data: JSON.stringify(m) });
    });
  }
}

/**
 * Boot at a REAL past session, not a placeholder.
 *
 * The fixture gives alpha three sessions (alpha-s9 newest, alpha-s2 bound, alpha-s1 oldest), so
 * booting at `alpha-s1` exercises the deep link through the FIRST `select()` — the path a browser
 * reload takes. A placeholder like `/session/test` never did: it is not in the index, so the code
 * fell back to `localStorage`/first-agent and the boot deep link was silently untested. Reported as
 * "`/session/teapot-10-16854917` を開いても `/session/teapot-10` に移動する".
 */
const BOOT_SESSION = "alpha-s1";
const w = new Window({ url: `http://localhost:7788/session/${BOOT_SESSION}` });
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
// `duplicatePreset` and the theme helpers call the BARE global `getComputedStyle`, so the
// harness must provide it or every theme write throws "getComputedStyle is not defined" and
// silently does nothing. It resolves against the window's document, like a browser's.
setGlobal("getComputedStyle", (el: Element, pseudo?: string) => w.getComputedStyle(el, pseudo));
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
// happy-dom has no ResizeObserver, and the bundle uses one (the terminal always has, and
// the tasks pane uses it to remember a dragged height). Without a stub the whole bundle
// throws on import. Instances register here so a check can PUMP them — a one-shot fire at
// mount is not enough, because a drag (or a test) changes the height later, which is the
// event an observer exists to report.
const resizeObservers: { check: () => void }[] = [];
const pumpResize = () => {
  for (const ro of resizeObservers) ro.check();
};
setGlobal(
  "ResizeObserver",
  class {
    // the app's callback destructures ENTRIES, so the stub must pass them — calling it with
    // no arguments throws "e is not iterable"
    cb: (entries: unknown[]) => void;
    targets: { el: any; last: number }[] = [];
    // explicit field, NOT a parameter property: Node's type-stripping loader refuses
    // `constructor(private cb)` (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX)
    constructor(cb: (entries: unknown[]) => void) {
      this.cb = cb;
      resizeObservers.push(this);
    }
    observe(el: any) {
      this.targets.push({ el, last: -1 });
      this.check();
    }
    /**
     * Report a size when it CHANGES.
     *
     * A one-shot fire is not enough: the component arms the observer at mount, and a test
     * (or a real drag) changes the height AFTERWARDS — which is exactly the event an
     * observer exists to report. Polling keeps the stub honest without pretending
     * happy-dom can dispatch layout.
     */
    check() {
      let fired = false;
      for (const t of this.targets) {
        const set = Number(String(t.el.style?.height ?? "").replace("px", ""));
        const h = Number.isFinite(set) && set > 0 ? set : (t.el.offsetHeight ?? 0);
        if (h > 0 && h !== t.last) {
          t.last = h;
          Object.defineProperty(t.el, "offsetHeight", { value: h, configurable: true });
          fired = true;
        }
      }
      if (fired) {
        // pass ENTRIES: the app's callback destructures them (`for (const e of entries)`),
        // so calling it with no arguments throws "e is not iterable"
        const entries = this.targets
          .filter((t) => t.last > 0)
          .map((t) => ({ target: t.el, contentRect: { width: 0, height: t.last } }));
        setTimeout(() => this.cb(entries), 0);
      }
    }
    unobserve() {}
    disconnect() {
      this.targets = [];
    }
  },
);
setGlobal("WebSocket", MockWS);

// the app's connectWs() runs at import time; its socket must exist for the
// pending-echo regression below to push bus events into the app
// every request, with its method and parsed body — a check that needs to prove WHAT
// was saved cannot do it from the url alone
/** every fetch the bundle made, with the method and parsed body a check can assert on */
const requests: { url: string; method: string; body: any }[] = [];
/** the BASE fetch stub, so a check that overrides it can put it back */
let baseFetch: typeof fetch | undefined;
setGlobal("fetch", async (url, init) => {
  fetchCount++;
  const u0 = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  let body = null;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  requests.push({ url: u0, method: (init?.method ?? "GET").toUpperCase(), body });
  requestedUrls.push(String(url));
  return { ok: true, status: 200, json: async () => apiResponse(u0) };
});
baseFetch = globalThis.fetch;

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
  const e = err as Error;
  console.error("IMPORT FAIL:", e.constructor.name, e.message);
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

/**
 * The runtime numbers must be VISIBLE, not folded.
 *
 * They used to live inside `<details class="rtmore">` — "usage & cost" — which meant every
 * glance at the cost or turn count required a click, and a closed `<details>` HIDES its content
 * from the panel just as surely as not rendering it. Asserting the text alone would pass while
 * the numbers were still behind a summary, so this checks that no ancestor `<details>` in the
 * right panel is closed around them.
 */
for (const marker of ["turns", "tokens", "compacted"]) {
  if (!bodyText().includes(marker)) {
    console.error(`DEEP RENDER MISSING RUNTIME STAT: ${marker}`);
    process.exit(1);
  }
}
{
  const panel = [...document.querySelectorAll(".rightbar")].at(-1);
  if (!panel) {
    console.error("DEEP RENDER: the right panel is missing");
    process.exit(1);
  }
  // precondition: the grid exists at all, or the check below passes vacuously
  const cells = panel.querySelectorAll(".rtgrid .rtcell");
  if (cells.length < 3) {
    console.error(`DEEP RENDER: expected a runtime stat grid, found ${cells.length} cells`);
    process.exit(1);
  }
  for (const d of panel.querySelectorAll("details")) {
    if (!d.open) {
      console.error(`DEEP RENDER: a panel section is folded shut: ${d.querySelector("summary")?.textContent}`);
      process.exit(1);
    }
  }
}
console.log("deep render ok: runtime stats visible, nothing folded");

// workspace file tree renders its lazy listing
if (!(await waitFor("file tree", () => bodyText().includes("README.md")))) process.exit(1);
console.log("deep render ok: file tree present");

// feed rows rendered through the markdown/tool-embed pipeline
const feedText = await waitFor("feed rows", () =>
  ["hello", "hi there", "SHIKI_MARKER"].every((m) => bodyText().includes(m)),
);
if (!feedText) {
  const missing = ["hello", "hi there", "SHIKI_MARKER"].filter((m) => !bodyText().includes(m));
  console.error(
    `DEEP RENDER MISSING FEED ROW: ${missing.join(", ")}` +
      `\nbody snippet: ${JSON.stringify(bodyText().slice(0, 600))}`,
  );
  process.exit(1);
}
console.log("deep render ok: feed rows present");

/**
 * A TOOL CARD'S INPUT AND OUTPUT ARE SHIKI-HIGHLIGHTED.
 *
 * Reported: "ツールカードのshiki効いてない". The highlighting did not apply because the wrapper
 * carried `shiki-host` while every stylesheet rule keyed on `.toolbody.shiki` — the classes
 * disagreed, so the dual-theme colour variables were never picked up and the block rendered as
 * plain text on shiki's own OPAQUE background (which also swallowed the translucent surface).
 *
 * Asserted on the MARKUP: shiki emits `<pre class="shiki">` with per-token `<span style="--shiki-…">`.
 * A plain fallback has neither. Both preconditions are checked, because a fixture without a tool
 * row would otherwise pass vacuously.
 */
{
  /**
   * POLL: highlighting is lazy (the shiki core is a dynamic import, grammars load per language), so
   * the markup appears a tick after the row does. Checking synchronously would fail on a working
   * build — the same fixed-wait mistake the suites were told to stop making.
   */
  let marked: Element[] = [];
  let tokens: NodeListOf<Element> = w.document.querySelectorAll("none");
  for (let i = 0; i < 120; i++) {
    marked = [...w.document.querySelectorAll(".feed .toolbody.shiki")];
    tokens = w.document.querySelectorAll(".feed .toolbody.shiki span[style*='--shiki']");
    if (marked.length && tokens.length) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!marked.length) {
    const all = [...w.document.querySelectorAll(".feed .toolbody")].map((e) => e.className);
    const rows = [...w.document.querySelectorAll(".feed .embed")].length;
    console.error("#shiki: tool embeds=" + rows + " argerr=" + w.document.querySelectorAll(".feed .toolbody").length);
    console.error(
      "#shiki: no `.toolbody.shiki`. toolbody classes present: " + JSON.stringify(all.slice(0, 5)),
    );
    console.error(
      "#shiki REGRESSION: no tool body carries the `shiki` class — the stylesheet keys on " +
        "`.toolbody.shiki`, so highlighting cannot show",
    );
    process.exit(1);
  }
  if (!tokens.length) {
    console.error(
      "#shiki REGRESSION: no token spans — the block rendered as PLAIN text despite a grammar",
    );
    process.exit(1);
  }
  // and the inner pre must not paint its own surface (double inset / opaque panel)
  const inner = w.document.querySelector(".feed .toolbody.shiki pre.shiki") as HTMLElement | null;
  if (inner && (inner.style.backgroundColor || inner.getAttribute("style")?.includes("background-color"))) {
    console.error("#shiki REGRESSION: shiki's own background is on the inner pre — it must be layout only");
    process.exit(1);
  }
  console.log(`deep render ok: tool cards are shiki-highlighted (${tokens.length} token spans) (#shiki)`);
}

/**
 * A HIGHLIGHTED TOOL BLOCK MUST STILL WRAP.
 *
 * Reported: "ツールカードの引数欄が <pre> は適切な横幅になってるのに、内側の <code> がもっと長い横幅に
 * なっててちゃんと折り返されてないこともある".
 *
 * MEASURED in headless Firefox before the fix: the wrapper was 635px and the inner `code` 1943px,
 * because shiki ships `white-space: pre` on its own `<pre>`/`<code>` and that overrode the
 * wrapper's `pre-wrap`. happy-dom does no layout, so this asserts the CSS CONTRACT on the real
 * built stylesheet rather than a width.
 */
{
  const css = w.document.querySelector("style, link[rel=stylesheet]");
  void css;
  const sheet = [...(w.document.styleSheets ?? [])]
    .flatMap((s) => {
      try {
        return [...(s.cssRules as unknown as Iterable<CSSRule>)];
      } catch {
        return [];
      }
    })
    .map((r) => (r as CSSStyleRule).cssText ?? "")
    .join("\n");
  for (const sel of [".toolbody.shiki pre.shiki", ".toolbody.shiki pre.shiki code"]) {
    const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{]*\\{[^}]*white-space:\\s*pre-wrap`);
    if (!re.test(sheet)) {
      console.error(
        `#shiki REGRESSION: ${sel} must set white-space: pre-wrap — shiki's own pre/code default ` +
          `to 'pre', so the wrapper's wrapping stops at the div and a long command scrolls ` +
          `sideways inside a block meant to wrap`,
      );
      process.exit(1);
    }
  }
  console.log("deep render ok: highlighted tool blocks wrap like the plain fallback (#shiki)");
}

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
    if (!sock) {
      console.error("smoke: no app socket — the bundle never opened one");
      process.exit(1);
    }
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
      console.error(
        "#97 check could not create the thinking… row — the test would pass vacuously (url=" +
          w.location.pathname +
          ")",
      );
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

/* ---------- reasoning followed by a tool call must not leave the 💭 block ------
 * Reported: "reasoningだけしてtool発行したらreasoningのliveがタイムラインに残留する".
 *
 * Two things this check has to get right, or it passes vacuously:
 *
 *   1. the agent must STAY `running`. The status sweep retires the whole buffer when an agent goes
 *      idle, so a stub that reports `idle` clears the row for a reason that has nothing to do with
 *      this bug — measured: the pre-fix code passed until the stub was pinned to `running`;
 *   2. the `tool_start` must be in the event feed the app READS, because the rule compares its
 *      timestamp against the last delta. A socket frame alone is not enough: the next refresh
 *      re-reads `/events` and the synthetic row disappears.
 *
 * The rule itself lives in `reconcileLiveBuffer`, and the failure mode this repository keeps
 * hitting is a correct helper with dead wiring — so this drives the REAL bundle.
 */
{
  const LIVE_AGENT = { ...AGENT, status: "running", pendingPrompts: 1 };
  const TOOL_TS = new Date(Date.now() + 5000).toISOString();
  const LIVE_EVENTS = [
    ...EVENTS,
    {
      id: "live-tool-1",
      seq: 9001,
      ts: TOOL_TS,
      agent: AGENT.id,
      session: "alpha-s1",
      branch: "br0",
      parent: null,
      type: "tool_start",
      data: { callId: "c-live", name: "bash", args: { command: "ls" } },
    },
  ];
  let liveToolVisible = false;
  setGlobal("fetch", async (url) => {
    const raw = String(url).replace(/^https?:\/\/[^/]+/, "");
    const u = raw.split("?")[0];
    if (u === "/api/agents")
      return {
        ok: true,
        status: 200,
        json: async () => ({ agents: [LIVE_AGENT, { ...LIVE_AGENT, id: "beta", workspace: "/tmp/other-project" }] }),
      };
    if (u === `/api/agents/${AGENT.id}/events`)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          events: liveToolVisible ? LIVE_EVENTS : EVENTS,
          total: (liveToolVisible ? LIVE_EVENTS : EVENTS).length,
        }),
      };
    return apiResponse(url);
  });
  const sock = MockWS.instances.at(-1);
  if (!sock) {
    console.error("reasoning→tool check: no app socket — the bundle never opened one");
    process.exit(1);
  }
  // 1) a reasoning-only buffer → the 💭 row is on screen
  for (const sid of ["alpha", "alpha-s1", "alpha-s2"]) {
    sock.onmessage?.({
      data: JSON.stringify({
        kind: "agent-update",
        agentId: AGENT.id,
        snapshot: { ...LIVE_AGENT, status: "running" },
      }),
    });
    sock.onmessage?.({
      data: JSON.stringify({
        kind: "llm-delta",
        agentId: AGENT.id,
        sessionId: sid,
        text: "",
        reasoning: "weighing which file to open",
      }),
    });
  }
  await waitFor("the reasoning bubble to render", () =>
    w.document.body.textContent.includes("weighing which file to open"),
  );
  // 2) a tool call starts — the thinking stretch is over, the turn is still running
  liveToolVisible = true;
  for (const sid of ["alpha", "alpha-s1", "alpha-s2"]) {
    sock.onmessage?.({
      data: JSON.stringify({
        kind: "agent-update",
        agentId: AGENT.id,
        snapshot: { ...LIVE_AGENT, status: "running" },
      }),
    });
    sock.onmessage?.({
      data: JSON.stringify({
        kind: "event",
        agentId: AGENT.id,
        sessionId: sid,
        event: LIVE_EVENTS.at(-1),
      }),
    });
  }
  // PRECONDITION: the agent is STILL running. If the stub or a sweep made it idle, the row would
  // disappear for an unrelated reason and this check would prove nothing.
  await new Promise((r) => setTimeout(r, 500));
  const statusText = w.document.querySelector(".chan-head")?.textContent ?? "";
  if (!statusText.includes("running") && w.document.body.textContent.includes("▶ start")) {
    console.error(
      "reasoning→tool check: the agent is IDLE, so the status sweep — not this rule — would " +
        "clear the row. The check would pass vacuously.",
    );
    process.exit(1);
  }
  if (w.document.body.textContent.includes("weighing which file to open")) {
    console.error(
      "reasoning→tool REGRESSION: the 💭 block is still on the timeline after a tool call started " +
        "while the turn is still running — stale reasoning must be retired",
    );
    process.exit(1);
  }
  console.log("reasoning followed by a tool call leaves no stale 💭 block");
  // hand the base stub back: leaving it installed made a LATER check see this check's agent list
  if (baseFetch) setGlobal("fetch", baseFetch);
}

/* ---------- a whitespace-only reasoning delta must not draw an empty block ----
 * A provider streams reasoning as DELTAS; a chunk can be pure whitespace ("\n\n"),
 * and `Show when={str}` is truthy for that, so an empty 💭 block rendered for a
 * frame. Reported as "agent が一瞬空のreasoning を表示する".
 *
 * Driven through the real socket, because the guard lives in the render path that
 * only runs when a delta actually arrives. */
{
  const fail = (msg) => { console.error(`#reasoning REGRESSION: ${msg}`); process.exit(1); };
  const sock = MockWS.instances.at(-1);
  // a `fail()` call does not NARROW the type for the compiler, so the guard has to throw
  if (!sock?.onmessage) {
    fail("no app socket to drive");
    throw new Error("unreachable");
  }
  // a live, RUNNING agent is required — an idle one drops the buffer on the sweep
  sock.onmessage({
    data: JSON.stringify({
      kind: "agent-update",
      agentId: AGENT.id,
      snapshot: { ...AGENT, status: "running" },
    }),
  });
  for (const sid of ["alpha", "alpha-s1", "alpha-s2"]) {
    sock.onmessage({
      data: JSON.stringify({
        kind: "llm-delta",
        agentId: AGENT.id,
        sessionId: sid,
        text: "",
        // whitespace ONLY: nothing a reader could see, so nothing may be drawn
        reasoning: "\n  \n",
      }),
    });
  }
  await new Promise((r) => setTimeout(r, 260));

  // PRECONDITION: a live bubble must exist, or "no thinking block" proves nothing
  const bubble = w.document.querySelector(".msg.live");
  if (!bubble) fail("no live bubble — the check would pass vacuously");
  const details = bubble.querySelector("details.reasoning");
  if (details) {
    fail("a whitespace-only reasoning delta drew an empty 💭 block");
  }
  // and a REAL delta must still draw it, so the guard is not just "never show"
  for (const sid of ["alpha", "alpha-s1", "alpha-s2"]) {
    sock.onmessage({
      data: JSON.stringify({
        kind: "llm-delta",
        agentId: AGENT.id,
        sessionId: sid,
        text: "",
        reasoning: "actually thinking",
      }),
    });
  }
  await new Promise((r) => setTimeout(r, 260));
  const real = w.document.querySelector(".msg.live details.reasoning");
  if (!real) fail("a real reasoning delta must still draw the 💭 block");
  console.log("deep render ok: whitespace reasoning draws nothing, real reasoning draws (#reasoning)");
}

/**
 * Booting AT a deep link must keep it.
 *
 * The #58 check below drives a deep link through `popstate` after boot; a browser RELOAD is a
 * different path — the first `select()` carries the id. Reported as "`/session/teapot-10-16854917`
 * を開いても `/session/teapot-10` に移動する": the deep link was rewritten to the AGENT id, which
 * every tab then resolves to that agent's LATEST session, so two tabs collapsed onto one.
 */
{
  if (!w.location.pathname.includes(BOOT_SESSION)) {
    console.error(
      `#boot-deeplink REGRESSION: booted at /session/${BOOT_SESSION} but the URL is ` +
        `${w.location.pathname} — an agent id here makes every tab open the SAME session`,
    );
    process.exit(1);
  }
  console.log("deep render ok: a browser reload keeps the deep-linked session (#boot-deeplink)");
}

/* ---------- #58: a deep link must open the session it NAMES ----------------
 * `select()` resolved an agent id to its newest/bound session and ignored the
 * session in the URL, so `/session/alpha-s1` opened alpha-s2 and then REWROTE
 * the URL to match. The bookmark quietly pointed at a different conversation.
 *
 * The bundle boots at a real deep link (see BOOT_SESSION); this drives another one
 * deep link through history and asserts both the fetch and the final URL. */
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (msg) => { console.error(`#58 REGRESSION: ${msg}`); process.exit(1); };

  /**
   * Ask for a DIFFERENT session than the one we booted at.
   *
   * The window now boots at BOOT_SESSION (alpha-s1), so navigating to the same id is a no-op by
   * design — `select()` ignores a repeat of what is already showing. This check needs a real move,
   * so it asks for alpha-s9, the NEWEST, which is neither the bound session nor the boot one.
   */
  const want = "alpha-s9";
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
  /**
   * RETURN to the boot session. This check moved the timeline to `want`, and every later check that
   * drives socket frames for alpha-s1 would silently target a session that is no longer displayed —
   * a precondition failure three checks downstream with no visible connection to this one.
   */
  history.replaceState(null, "", `/session/${BOOT_SESSION}`);
  w.dispatchEvent(new w.PopStateEvent("popstate", { bubbles: true }));
  await sleep(400);
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
  const copied: string[] = [];
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
  // typed explicitly: an inferred element union from a dozen different literals makes
  // every later `.push()` a type error that says nothing about the check being written
  const PENDING_EVENTS: {
    id: string;
    seq: number;
    ts: string;
    session: string;
    branch: string;
    parent: string | null;
    type: string;
    data: any;
  }[] = [
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
  if (!appWs.onmessage) {
    console.error("[dbg] appWs has NO onmessage handler!");
    process.exit(1);
  }
  // `process.exit` does not narrow for the compiler; bind the handler to a const
  const appOnMessage = appWs.onmessage.bind(appWs);
  // typed loosely on purpose: the fixture events are JSON the server would write, and
  // `data` is genuinely open — pinning it to one literal shape made every variant a
  // type error in the CALLER instead of the assertion that matters
  const pushEvent = (event: {
    id: string;
    seq: number;
    ts: string;
    session: string;
    branch: string;
    parent: string | null;
    type: string;
    data: any;
  }) =>
    appOnMessage({
      data: JSON.stringify({
        kind: "event",
        agentId: AGENT.id,
        event: { agent: AGENT.id, ...event }, // bus events always carry .agent
      }),
    });
  const last = PENDING_EVENTS.at(-1);
  if (!last) throw new Error("PENDING_EVENTS must not be empty");
  pushEvent(last);
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

  /**
   * SENDING MUST NOT MOVE A READER WHO IS READING HISTORY.
   *
   * Reported: "メッセージを送信した直後にスクロールが変な位置になる". The old code fired
   * `scrollBottom(true)` two frames after the send — `force = true`, so it ignored where the
   * reader was. Removing it was necessary but the feed's ResizeObserver also has to behave:
   * a send changes `.feed`'s box (the draft clearing shrinks the composer), and for a reader
   * who is NOT following the observer re-anchors by `scrollTop += delta`. That is correct
   * only if the delta is the reflow's, not a second application on top of a settled layout.
   */
  {
    const feed = w.document.querySelector(".feed") as HTMLElement | null;
    if (!feed) {
      console.error("#send-scroll check: .feed missing");
      process.exit(1);
    }
    let CONTENT = 5000; // `let`: the follower case below grows it to model the echo arriving
    let viewport = 700;
    let top = 0;
    Object.defineProperty(feed, "scrollHeight", { configurable: true, get: () => CONTENT });
    Object.defineProperty(feed, "clientHeight", { configurable: true, get: () => viewport });
    Object.defineProperty(feed, "offsetHeight", { configurable: true, get: () => viewport });
    Object.defineProperty(feed, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(v, Math.max(0, CONTENT - viewport)));
      },
    });
    // the reader is reading HISTORY, far from the tail
    top = 1200;
    feed.dispatchEvent(new w.Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const before = top;

    // send the way the operator does
    ta.value = "another";
    ta.dispatchEvent(new w.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    // the send shrinks the composer, which grows the feed's box
    viewport += 20;
    pumpResize();
    await new Promise((r) => setTimeout(r, 250));

    if (Math.abs(top - before) > 32) {
      console.error(
        `#send-scroll REGRESSION: sending moved a reader who was reading history ` +
          `(scrollTop ${before} -> ${top}). A send must not scroll the feed when the reader ` +
          `is not following.`,
      );
      process.exit(1);
    }
    console.log("deep render ok: sending does not move a reader who is reading history (#send-scroll)");

    /**
     * …and the OTHER half, which is the reported bug: a reader who WAS following must STILL be
     * following after a send, immediately.
     *
     * Reported as "追従が維持されることを期待するけど、追従されてなさそう / ちょっと遅れて追従してる?"
     * — the tail caught up a moment later, which means something asynchronous was doing it
     * rather than the send itself. The send must leave the view at the tail in the same turn.
     */
    top = CONTENT - viewport; // at the tail
    feed.dispatchEvent(new w.Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));

    ta.value = "following";
    ta.dispatchEvent(new w.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    // the composer shrinks, so the feed grows
    viewport += 20;
    pumpResize();
    // the optimistic echo arrives as content growth, still in the same user action
    CONTENT += 120;
    await new Promise((r) => setTimeout(r, 60));
    pumpResize();
    await new Promise((r) => setTimeout(r, 120));

    const gapAfterSend = CONTENT - top - viewport;
    if (gapAfterSend > 8) {
      console.error(
        `#send-scroll REGRESSION: a follower was left ${gapAfterSend}px above the tail after ` +
          `sending (scrollTop ${top}, content ${CONTENT}, viewport ${viewport}) — following must ` +
          `survive a send immediately, not catch up a frame later`,
      );
      process.exit(1);
    }
    console.log("deep render ok: sending keeps a follower AT the tail, immediately (#send-scroll)");

    /**
     * AND A WHEEL MUST STILL WORK.
     *
     * Reported: "追従がされたあとは次のメッセージが来るとかじゃないとマウスホイールでタイムラインの
     * スクロールができない". The unskip compensation fired on ANY large height change while parked,
     * and a wheel step changes BOTH `scrollTop` and (via forced layout on the rows it passes) the
     * content height — so the correction undid the wheel and the feed felt frozen until something
     * else changed the box.
     *
     * The guard is the correction budget: it is spent by layout-driven corrections and refilled
     * only by a delivery the READER caused. So several wheel steps in a row must each MOVE the
     * view, never be pulled back.
     */
    /**
     * A WHEEL MUST STILL SCROLL — the observable half only.
     *
     * Reported: "追従がされたあとは次のメッセージが来るとかじゃないとマウスホイールでタイムラインの
     * スクロールができない". A wheel step changes `scrollTop` AND (via the forced layout that
     * finding a visible row causes) the content height, so an unskip compensation that fired on
     * any height change would undo it.
     *
     * HONEST LIMIT: happy-dom does no layout, so every row measures 0×0 and the compensation's
     * own `Math.abs(delta) < 1` guard skips it — the correction cannot be exercised here
     * (measured: removing the `cause === "layout"` gate leaves this check green, while a debug
     * print confirms the code path IS entered). What this check does prove is the invariant that
     * matters to the operator: successive wheel steps keep moving the view and are never pulled
     * back. The guard itself is pinned by `test/scroll-policy.test.ts`.
     */
    top = CONTENT - viewport;
    feed.dispatchEvent(new w.Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    // park mid-history, then wheel UP repeatedly, growing content each time as forced layout on
    // unskipped rows would
    top = CONTENT - viewport - 400;
    feed.dispatchEvent(new w.Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    for (let step = 0; step < 3; step++) {
      const beforeWheel = top;
      top = Math.max(0, top - 200);
      CONTENT += 150; // unskipped rows report their real height
      feed.dispatchEvent(new w.Event("scroll", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      if (top >= beforeWheel) {
        console.error(
          `#wheel-scroll REGRESSION: a wheel step did not move the view (scrollTop stayed ` +
            `${top}) — the unskip compensation pulled the reader back, which is the reported ` +
            `"マウスホイールでスクロールできない"`,
        );
        process.exit(1);
      }
    }
    console.log("deep render ok: a wheel still scrolls after following (#wheel-scroll)");
  }

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

    // ----
    // NOTE: an ✎ edit gating check was attempted here and REMOVED. The bundle only offers
    // Edit on a settled user prompt when the agent is not live, and this fixture's timeline
    // is a live session, so no row ever renders the button — the check could only ever be
    // vacuous or wrongly red. `test/regression-fixes.test.ts` used to pin the gate as a
    // source regex; that assertion was deleted rather than moved, because a regex on the
    // spelling of the condition protects nothing (AGENTS.md). The gate itself is unchanged.
    // ----
  }

  /* ---------- #40: a persisted reply must not also render as a live bubble ---
   * "tool call を発行するタイミングで一瞬2重になります" — the reply renders TWICE for
   * a moment: once as the settled log row (merged synchronously from the socket
   * frame) and once as the live bubble still showing the same text with its
   * writing cursor. The buffer was revalidated only inside the debounced
   * `runFeedRefresh` (60 ms + a fetch), so the duplicate lived in that window.
   *
   * This drives the REAL bundle: the duplicate is a WIRING defect between the
   * socket branch and the render, and a helper test passes against the old code
   * because the helper was always right — #40's lesson.
   */
  {
    const sock = MockWS.instances.at(-1);
    if (!sock) {
      console.error("smoke: no app socket — the bundle never opened one");
      process.exit(1);
    }
    if (!sock?.onmessage) {
      console.error("#40 check: no app socket to drive");
      process.exit(1);
    }
    // make the agent live and put the FULL reply text on the live buffer with the
    // agent still running — the in-flight state the report describes (status does
    // not change between tool calls inside one round)
    sock.onmessage({ data: JSON.stringify({
      kind: "agent-update", agentId: AGENT.id,
      snapshot: { ...RUNNING_AGENT, session: "alpha-s1" },
    }) });
    for (const sid of ["alpha", "alpha-s1", "alpha-s2"]) {
      sock.onmessage({ data: JSON.stringify({
        kind: "llm-delta", agentId: AGENT.id, sessionId: sid,
        text: "tool-call reply body", reasoning: "",
      }) });
    }
    await new Promise((r) => setTimeout(r, 200));
    if (!bodyText().includes("tool-call reply body")) {
      console.error("#40 check could not put the text in the live bubble — the test would pass vacuously");
      process.exit(1);
    }
    // the reply is PERSISTED and arrives over the socket while the agent is still
    // running: exactly the tool-call moment
    pushEvent({
      id: "e40", seq: 40, ts: "2026-01-01T10:01:00Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "message",
      data: { role: "assistant", content: "tool-call reply body" },
    });
    // do NOT wait for the debounced refresh: the duplicate must be gone the
    // instant the frame is merged, not 60ms later
    await new Promise((r) => setTimeout(r, 0));
    const n40 = bodyText().split("tool-call reply body").length - 1;
    if (n40 !== 1) {
      console.error(
        `#40 REGRESSION: the persisted reply renders ${n40}x (expected 1x) — the live bubble outlived the log row`,
      );
      process.exit(1);
    }
    console.log("deep render ok: a persisted reply does not double as a live bubble (#40)");
  }

  /* ---------- #75 (again): a run of tool rows from ONE actor groups ------------
   * Reported: "タイムラインで bash が2つ並んだときに両方に アイコン+名前 がついてる
   * (本来、同じアクターからの出力の連続なので1つ目だけにアイコンとかがつくべき)" — and,
   * importantly, it looked inconsistent ("グループ化されるときとされないときがある").
   *
   * The inconsistency is real but was NOT the bug: two bash calls issued in the SAME
   * assistant turn do group, while two separated by an assistant message do not —
   * that is the rule working, because the message is a different actor. Checked
   * against this session's own log: the "grouped" pair had only a `tool_result`
   * between them, the "not grouped" pair had EIGHT assistant messages. No time term
   * exists in the rule at all.
   *
   * The actual defect was the #75 shape once more: `groupedWith()` returned true,
   * but `ToolRow` never RECEIVED `prev`, so the rule could not run for tool rows and
   * every consecutive bash row rendered its own "⚙ + label". Verified by dumping the
   * built bundle (the helper test was green throughout).
   */
  {
    pushEvent({ id: "eg1", seq: 301, ts: "2026-01-01T13:00:01Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_call", data: { callId: "cg1", name: "bash", args: { command: "echo GROUPED_ONE" } } });
    pushEvent({ id: "eg2", seq: 302, ts: "2026-01-01T13:00:02Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_result", data: { callId: "cg1", name: "bash", result: "GROUPED_ONE", ok: true, durationMs: 4 } });
    pushEvent({ id: "eg3", seq: 303, ts: "2026-01-01T13:00:03Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_call", data: { callId: "cg2", name: "bash", args: { command: "echo GROUPED_TWO" } } });
    pushEvent({ id: "eg4", seq: 304, ts: "2026-01-01T13:00:04Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_result", data: { callId: "cg2", name: "bash", result: "GROUPED_TWO", ok: true, durationMs: 4 } });
    flushRefreshes();
    await new Promise((r) => setTimeout(r, 400));

    const headFor = (needle) => {
      for (const d of w.document.querySelectorAll(".embed")) {
        if (!d.textContent.includes(needle)) continue;
        const sum = d.querySelector("summary");
        return { cls: d.className, head: sum ? sum.textContent.trim() : "" };
      }
      return null;
    };
    const one = headFor("GROUPED_ONE");
    const two = headFor("GROUPED_TWO");
    if (!one || !two) {
      console.error(`#75 check could not find both rows (one=${!!one}, two=${!!two}) — vacuous`);
      process.exit(1);
    }
    // NEITHER row may carry a tool glyph. `⚙` was the default for every tool and no
    // tool ever overrode it, so it identified nothing — the tool NAME is already in the
    // row's author slot. It also differed between a run's head (present) and its
    // continuations (absent), which is the inconsistency that got reported.
    const rows: [string, { cls: string; head: string }][] = [
      ["first", one],
      ["second", two],
    ];
    for (const [name, row] of rows) {
      if (row.head.includes("\u2699")) {
        console.error(
          `#75 REGRESSION: the ${name} row carries a meaningless \u2699 glyph — the tool name ` +
            `already says what ran. head=${JSON.stringify(row.head)}`,
        );
        process.exit(1);
      }
    }
    if (!/\bgrouped\b/.test(two.cls)) {
      console.error(`#75 REGRESSION: the continuing row is not marked grouped — cls=${JSON.stringify(two.cls)}`);
      process.exit(1);
    }
    // and it must still say WHAT ran — dropping the command would be the opposite bug
    if (!two.head.includes("GROUPED_TWO")) {
      console.error(`#75: a grouped row must keep its command, got ${JSON.stringify(two.head)}`);
      process.exit(1);
    }
    console.log("deep render ok: consecutive tool rows group under one head (#75)");

    // ---- a grouped run must JOIN: square corners, no dead space between rows ----
    //
    // Reported: "グループ化されたツールログは角丸になってなくて、しかも下に数px 謎の空間がある".
    // The first half was wrong in the other direction — only the LEFT radii were zeroed,
    // so a run looked like separate boxes with a flattened edge — and the space was
    // `.msg`'s own `padding: 3px` on every row inside the run.
    //
    // Measured as a CSS contract (happy-dom does no layout), which is how this file
    // asserts geometry everywhere.
    {
      const cssOf = (el) => w.document.defaultView.getComputedStyle(el);
      const groupedRows = [...w.document.querySelectorAll(".msg.grouped")];
      const feedRows = [...w.document.querySelectorAll(".msg")];
      if (groupedRows.length === 0) {
        console.error("#grouped REGRESSION: no grouped rows to measure — the check is vacuous");
        process.exit(1);
      }
      for (const [i, row] of groupedRows.entries()) {
        const embed = row.querySelector(".embed");
        if (!embed) {
          console.error(`#grouped REGRESSION: grouped row ${i} has no embed`);
          process.exit(1);
        }
        const r = cssOf(embed);
        // ALL FOUR corners stay rounded. Grouping is carried by the missing icon and the
        // shared head; squaring the corners to signal "continuation" read as a flattened
        // box and was reported as "角丸になってなくて".
        // ALL FOUR CORNERS stay rounded, and AGREE with each other. The old assertion
      // pinned the literal "4px", which was the radius at the time — so raising the
      // design token (4px -> 6px, part of the Misskey-derived radius scale) failed a
      // test whose subject was "corners are rounded", not "corners are 4px". Pin the
      // INVARIANT: nonzero, and identical on every corner.
      const cornerValues = [
        "borderTopLeftRadius",
        "borderTopRightRadius",
        "borderBottomLeftRadius",
        "borderBottomRightRadius",
      ].map((c) => r[c]);
      const first = cornerValues[0];
      for (const [i, corner] of [
        "borderTopLeftRadius",
        "borderTopRightRadius",
        "borderBottomLeftRadius",
        "borderBottomRightRadius",
      ].entries()) {
        const v = cornerValues[i];
        if (!v || parseFloat(v) <= 0) {
          console.error(
            `#grouped REGRESSION: a grouped row's ${corner} is ${JSON.stringify(v)} — every ` +
              "corner must stay rounded (a squared corner made a run read as a stack of boxes)",
          );
          process.exit(1);
        }
        if (v !== first) {
          console.error(
            `#grouped REGRESSION: a grouped row's corners disagree (${cornerValues.join(", ")}) — ` +
              "a run must be one surface, not mismatched edges",
          );
          process.exit(1);
        }
      }
      }

      // THE GAP MODEL. What "there is no space below the first tool result" was: the
      // run's HEAD kept `.msg`'s 3px bottom padding while the continuation contributed
      // nothing, so a run looked detached from the row that introduced it.
      //
      // This fixture has ONE run of two rows, so the boundary to measure is
      // head → first continuation (which must be FLUSH), not continuation →
      // continuation. Written against the class contract rather than row indices so it
      // keeps meaning something if the fixture grows.
      const gaps: { label: string; px: number }[] = [];
      for (let i = 0; i < feedRows.length - 1; i++) {
        const a = feedRows[i];
        const b = feedRows[i + 1];
        const ae = a.querySelector(".embed");
        const be = b.querySelector(".embed");
        if (!ae || !be) continue;
        // a row that CONTINUES the previous one is the boundary "inside a run"
        if (!b.classList.contains("grouped")) continue;
        gaps.push({
          label: `${a.className.slice(0, 20)} -> ${b.className.slice(0, 20)}`,
          px:
            parseFloat(cssOf(a).paddingBottom) +
            parseFloat(cssOf(b).paddingTop) +
            parseFloat(cssOf(be).marginTop),
        });
      }
      if (gaps.length === 0) {
        console.error(
          "#grouped REGRESSION: no run boundary to measure — the grouping check is vacuous",
        );
        process.exit(1);
      }
      // Every boundary INTO a grouped row must have a SMALL, deliberate gap.
      //
      // It used to assert 0px ("flush"), which was wrong twice over: a continuation's
      // `avatar avghost ghosted` inherited `.avatar`'s 38px + 2px, so what looked flush had
      // 40px of INVISIBLE height above the embed — and once that phantom box is removed the
      // rows really are flush, which makes consecutive commands hard to read. The operator
      // asked for a few px, so the assertion is "a small gap", not zero.
      const GAP_MIN = 2;
      const GAP_MAX = 8;
      for (const g of gaps) {
        if (g.px < GAP_MIN || g.px > GAP_MAX) {
          console.error(
            `#grouped REGRESSION: a grouped row is ${g.px}px from the row above it (${g.label}) — ` +
              `expected ${GAP_MIN}-${GAP_MAX}px: flush rows are hard to read, and a wide gap means ` +
              "something invisible is adding height (the empty avatar box was doing exactly that)",
          );
          process.exit(1);
        }
      }
      // THE PHANTOM BOX: a continuation's avatar must contribute NO height. It is an empty
      // div whose only job is to keep the column, and `.avatar`'s 38px was making every
      // grouped row taller than its content.
      for (const [i, row] of groupedRows.entries()) {
        const av = row.querySelector(".avatar");
        if (!av) continue;
        const h = cssOf(av).height;
        if (parseFloat(h) > 0) {
          console.error(
            `#grouped REGRESSION: a grouped row's empty avatar is ${h} tall (row ${i}) — that is ` +
              "invisible height above every continuation, which is what made runs look sparse",
          );
          process.exit(1);
        }
      }
      // …and an ORDINARY row still shows its icon at full size (the rule is scoped to runs)
      const ordinary = feedRows.find((r) => !r.classList.contains("grouped"));
      const ordAv = ordinary?.querySelector(".avatar");
      if (!ordAv || parseFloat(cssOf(ordAv).height) <= 0) {
        console.error(
          "#grouped REGRESSION: an ordinary row's avatar collapsed — a 0px avatar belongs only " +
            "to continuations, which carry no icon",
        );
        process.exit(1);
      }
      // The HEAD of a run (the row immediately above a continuation) must be marked
      // `next-grouped` and carry no bottom padding — that pair replaces the old
      // `:has(+ .msg.grouped)` selector, which made every row pay for a sibling match on
      // every style recalc (#178). Asserted here rather than as a source regex.
      const head = groupedRows[0]?.previousElementSibling;
      if (head && head.classList.contains("msg")) {
        if (!head.classList.contains("next-grouped")) {
          console.error(
            "#grouped REGRESSION: the row above a continuation is not marked next-grouped, so the " +
              "run's first gap is double (the head keeps its bottom padding and the continuation " +
              "adds its own)",
          );
          process.exit(1);
        }
        if (parseFloat(cssOf(head).paddingBottom) > 0) {
          console.error(
            "#grouped REGRESSION: the head of a run carries bottom padding — the first gap of the " +
              "run is double",
          );
          process.exit(1);
        }
        // …and a row that is NOT followed by a continuation must keep its own bottom space,
        // otherwise blocks run together. `next-grouped` is what makes that distinction.
        const lastGrouped = groupedRows[groupedRows.length - 1];
        if (lastGrouped && !lastGrouped.classList.contains("next-grouped")) {
          if (parseFloat(cssOf(lastGrouped).paddingBottom) <= 0) {
            console.error(
              "#grouped REGRESSION: a run's last row gives no space below it — blocks run together",
            );
            process.exit(1);
          }
        }
      }
    }
    console.log("deep render ok: a grouped run has rounded corners, a small gap, and no phantom avatar (#grouped)");
  }

  /* ---------- #75: an INVISIBLE row must not split a tool run ------------------
   * Reported (v0.29.21): "bashが連続なのに両方にアイコンがついてる", and — the clue that
   * found it — some pairs grouped while others did not in the SAME session.
   *
   * `state` is in FEED_TYPES but neither MessageRow nor SwitchContent has a branch
   * for it, so it draws NOTHING. It nevertheless became the grouping `prev` of the
   * next row, and `groupedWith()` keys on the row TYPE, so a run was cut in half:
   *
   *     e15100 tool_call (bash)   <- rendered WITH its icon
   *     e15102 state              <- draws nothing, but is `prev`
   *     e15105 tool_call (bash)   <- its prev is `state` -> no grouping -> icon too
   *
   * MEASURED on this session: 304 of the last 1500 events are `state`. Replaying the
   * real log through App.tsx's own filter reproduced exactly that shape.
   *
   * Rows that draw nothing are now dropped from the feed array, so a run continues
   * across them. The check below is the reported shape with a real boundary in front.
   */
  {
    const _sockB = MockWS.instances.at(-1);
    // a VISIBLE boundary, so the first bash genuinely starts a new run
    pushEvent({ id: "gb0", seq: 601, ts: "2026-01-01T16:00:00Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "message", data: { role: "assistant", content: "boundary before the run" } });
    pushEvent({ id: "gb1", seq: 602, ts: "2026-01-01T16:00:01Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_call", data: { callId: "cb1", name: "bash", args: { command: "INVIS_ONE" } } });
    pushEvent({ id: "gb2", seq: 603, ts: "2026-01-01T16:00:02Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_result", data: { callId: "cb1", name: "bash", result: "o", ok: true, durationMs: 3 } });
    // the invisible rows that used to split the run: a turn boundary and a
    // carrier turn (empty content — the ToolRow already tells that story)
    pushEvent({ id: "gb3", seq: 604, ts: "2026-01-01T16:00:03Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "state", data: { from: "running", to: "running", detail: "llm turn start", turn: 91 } });
    pushEvent({ id: "gb4", seq: 605, ts: "2026-01-01T16:00:04Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "message", data: { role: "assistant", content: "", toolCalls: [{ id: "x", name: "bash" }] } });
    pushEvent({ id: "gb5", seq: 606, ts: "2026-01-01T16:00:05Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_call", data: { callId: "cb2", name: "bash", args: { command: "INVIS_TWO" } } });
    // and a log-only note, which has the same effect and must be dropped too
    pushEvent({ id: "gb6", seq: 607, ts: "2026-01-01T16:00:06Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "system_note", data: { event: "session-restored", branch: "br0" } });
    pushEvent({ id: "gb7", seq: 608, ts: "2026-01-01T16:00:07Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_call", data: { callId: "cb3", name: "bash", args: { command: "INVIS_THREE" } } });
    pushEvent({ id: "gb8", seq: 609, ts: "2026-01-01T16:00:08Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_result", data: { callId: "cb3", name: "bash", result: "o", ok: true, durationMs: 3 } });
    flushRefreshes();
    await new Promise((r) => setTimeout(r, 500));

    const rowFor = (needle) => {
      for (const d of w.document.querySelectorAll(".embed")) {
        const sm = d.querySelector("summary");
        if (sm && sm.textContent.includes(needle)) return { cls: d.className, head: sm.textContent.trim() };
      }
      return null;
    };
    const one = rowFor("INVIS_ONE");
    const two = rowFor("INVIS_TWO");
    const three = rowFor("INVIS_THREE");
    if (!one || !two || !three) {
      console.error(`#75 check could not find all three rows (${!!one}/${!!two}/${!!three}) — vacuous`);
      process.exit(1);
    }
    // No glyph on ANY row of the run: `⚙` defaulted for every tool and no tool ever
    // overrode it, so it identified nothing (the tool name is in the author slot) and it
    // differed between a head and its continuations — the reported inconsistency.
    if (one.head.includes("\u2699")) {
      console.error(
        `#75 REGRESSION: a tool row carries a meaningless \u2699 glyph, got ${JSON.stringify(one.head)}`,
      );
      process.exit(1);
    }
    const rest: [string, { cls: string; head: string }][] = [
      ["2nd", two],
      ["3rd", three],
    ];
    for (const [name, r] of rest) {
      if (r.head.includes("\u2699")) {
        console.error(
          `#75 REGRESSION: the ${name} bash row has its own icon — an invisible row (state / carrier / log-only note) split the run (#75)` +
            `\n  first: ${JSON.stringify(one.head)}\n  ${name}  : ${JSON.stringify(r.head)}`,
        );
        process.exit(1);
      }
      if (!/\bgrouped\b/.test(r.cls)) {
        console.error(`#75 REGRESSION: the ${name} row is not marked grouped — cls=${JSON.stringify(r.cls)}`);
        process.exit(1);
      }
    }
    console.log("deep render ok: an invisible row does not split a tool run (#75)");
  }

  /* ---------- #59: the start/stop toggle must send what its LABEL says ---------
   * Reported: "stop した後に start が機能しない".
   *
   * The button is ONE element that flips between ▶ start and ■ stop, and it chose
   * the action with a bare expression:
   *
   *     onclick={isSelLive() ? act("/stop") : act("/start")}
   *
   * A bare expression in `onclick={…}` is evaluated ONCE, when the element is
   * created — the handler FROZE to whichever action was correct at that moment.
   * Solid does re-evaluate the label and `class` (tracked reads), so the button
   * could read "▶ start" while its frozen handler re-sent a stop. MEASURED, by
   * clicking the real bundle:
   *
   *     label="■ stop"  ->  click  ->  POST /start    <- reported as a dead button
   *     label="▶ start" ->  click  ->  POST /stop
   *
   * So an agent stopped while it was running could never be started again: every
   * press stopped it. The check below drives both presses and asserts the METHOD
   * matches the label, which is the property the operator experiences.
   */
  {
    const posted: string[] = [];
    const origFetchToggle = globalThis.fetch;
    setGlobal("fetch", async (u, init) => {
      if (typeof u === "string" && /\/stop|\/start$/.test(u) && init?.method === "POST") {
        posted.push(u.slice(u.lastIndexOf("/")));
      }
      return origFetchToggle(u, init);
    });
    const sockT = MockWS.instances.at(-1);
    if (!sockT?.onmessage) {
      console.error("#59 check: no app socket to drive");
      process.exit(1);
    }
    // The ▶/■ toggle lives in the channel header now (#panel) and shows a GLYPH rather than
    // the words "start"/"stop", so find it by its class. What the check is about is unchanged:
    // the handler must be chosen at CLICK time, not at element-creation time.
    const toggle = () => w.document.querySelector(".chan-head .runbtn");
    const readsStop = (b: Element | null) => !!b && b.classList.contains("danger");

    // live agent -> the button must offer stop AND send /stop
    sockT.onmessage({ data: JSON.stringify({ kind: "agent-update", agentId: AGENT.id, snapshot: { ...AGENT, status: "running", live: true } }) });
    await new Promise((r) => setTimeout(r, 300));
    const stopBtn = toggle();
    if (!stopBtn || !readsStop(stopBtn)) {
      console.error(
        `#59 check could not reach the stop state — got class=${JSON.stringify(stopBtn?.className)} ` +
          `(expected the header ▶/■ toggle to be in its danger state)`,
      );
      process.exit(1);
    }
    stopBtn.click();
    await new Promise((r) => setTimeout(r, 300));
    if (posted.at(-1) !== "/stop") {
      console.error(
        `#59 REGRESSION: a button showing ■ (danger) posted ${JSON.stringify(posted.at(-1))} — the click handler is frozen at element creation`,
      );
      process.exit(1);
    }

    // stopped agent -> must offer start AND send /start (the reported failure)
    sockT.onmessage({ data: JSON.stringify({ kind: "agent-update", agentId: AGENT.id, snapshot: { ...AGENT, status: "stopped", live: false } }) });
    await new Promise((r) => setTimeout(r, 300));
    const startBtn = toggle();
    if (!startBtn || readsStop(startBtn)) {
      console.error(
        `#59 check could not reach the start state — got class=${JSON.stringify(startBtn?.className)}`,
      );
      process.exit(1);
    }
    startBtn.click();
    await new Promise((r) => setTimeout(r, 300));
    if (posted.at(-1) !== "/start") {
      console.error(
        `#59 REGRESSION: after a stop, the button read "▶ start" but posted ${JSON.stringify(posted.at(-1))} — pressing start cannot restart the agent`,
      );
      process.exit(1);
    }
    console.log("deep render ok: the start/stop toggle sends what its label says (#59)");
  }

  /* ---------- the agent's controls are reachable WITHOUT opening the panel ----------
   * Reported: "右パネルの機能をいろいろ折りたたみにしたのが微妙 / 折りたたむことで隠してるだけ".
   * The panel used to hold start/stop, fork, stop-subs and archive under a `⏯ controls`
   * heading, so pausing the agent you were reading meant opening the details panel first.
   *
   * They live in the channel header now (#panel). This asserts the move actually happened:
   * the buttons must exist with the panel CLOSED, in the header, and the panel must not still
   * be carrying its own copy (two controls for one action is worse than one in the wrong
   * place).
   */
  {
    const header = w.document.querySelector(".chan-head");
    if (!header) {
      console.error("#panel check: no .chan-head to inspect");
      process.exit(1);
    }
    // the panel must be CLOSED for this to prove anything about reachability
    const panelOpen = !w.document.querySelector(".layout.right-hidden") &&
      !!w.document.querySelector(".rightbar");
    const actions = [...header.querySelectorAll("button")];
    const titles = actions.map((b) => b.getAttribute("title") ?? "");
    const has = (re: RegExp) => titles.some((t) => re.test(t));
    if (!has(/fork/i)) {
      console.error(`#panel REGRESSION: no fork button in the channel header — titles: ${JSON.stringify(titles)}`);
      process.exit(1);
    }
    if (!has(/archive/i)) {
      console.error(`#panel REGRESSION: no archive button in the channel header — titles: ${JSON.stringify(titles)}`);
      process.exit(1);
    }
    // the ▶/■ toggle is checked by #59 above; what matters here is that it is IN the header
    if (!header.querySelector(".runbtn")) {
      console.error("#panel REGRESSION: the start/stop toggle is not in the channel header");
      process.exit(1);
    }
    // …and the panel must not still offer its own copy
    const panel = w.document.querySelector(".rightbar");
    if (panel) {
      const panelBtns = [...panel.querySelectorAll("button")].map((b) => b.getAttribute("title") ?? "");
      const dup = panelBtns.filter((t) => /fork|archive|stop every sub-agent/i.test(t));
      if (dup.length > 0) {
        console.error(
          `#panel REGRESSION: the details panel still carries controls that moved to the ` +
            `header — ${JSON.stringify(dup)}. Two places for one action is worse than one in ` +
            `the wrong place.`,
        );
        process.exit(1);
      }
    }
    console.log(
      `deep render ok: fork / stop-subs / archive / start-stop are in the header, not behind the panel (#panel, panelOpen=${panelOpen})`,
    );
    /**
     * No bare ℹ glyph in the header.
     *
     * It used to render whenever `statusReason` was set, which the server fills on every status
     * write — so it sat there permanently, carrying one mechanical fact behind a hover. The rule
     * this pins: a control in the header must say what it is without being hovered. The status
     * BADGE is allowed, because it renders a readable word.
     */
    const glyphs = [...header.querySelectorAll(".sub")].filter(
      (s) => (s.textContent ?? "").trim() === "ℹ",
    );
    if (glyphs.length > 0) {
      console.error(
        "#panel REGRESSION: the header shows a bare ℹ with no readable label — " +
          "the status reason belongs on the badge's tooltip, not behind an unlabelled glyph",
      );
      process.exit(1);
    }
  }

  /* ---------- #170: a provider can hold SEVERAL keys ------------------------
   * The config used to give each provider one `apiKey`, so spreading load meant
   * duplicating the whole provider (this config had five `openrouter-*` entries
   * differing only in `model`, sharing one credential). Nothing rotated, so a rate
   * limit stalled every agent on it at once. The dialog must let the operator add
   * a second key for the SAME provider.
   */
  {
    const cfgBtn = [...w.document.querySelectorAll("button")].find((b) =>
      /settings|config/i.test(b.getAttribute("title") ?? b.textContent ?? ""),
    );
    if (!cfgBtn) {
      console.error("#170 check: no settings button to open the config dialog");
      process.exit(1);
    }
    cfgBtn.click();
    await new Promise((r) => setTimeout(r, 400));

    const keyInputs = () => [...w.document.querySelectorAll(".cfgkeyrow input")];
    if (keyInputs().length === 0) {
      console.error("#170 REGRESSION: the config dialog renders no key inputs at all");
      process.exit(1);
    }
    const before = keyInputs().length;
    const addKey = [...w.document.querySelectorAll(".cfgkeys > button")].find((b) => /\+\s*key/.test(b.textContent ?? ""));
    if (!addKey) {
      console.error(`#170 REGRESSION: no "+ key" control — a provider cannot hold a second key`);
      process.exit(1);
    }
    addKey.click();
    await new Promise((r) => setTimeout(r, 250));
    const after = keyInputs().length;
    if (after !== before + 1) {
      console.error(`#170 REGRESSION: "+ key" did not add a row (${before} -> ${after})`);
      process.exit(1);
    }
    // and removing is possible again, so a mistyped extra key is not permanent
    const removeBtn = [...w.document.querySelectorAll(".cfgkeyrow button")].find((b) => /remove this key/.test(b.getAttribute("title") ?? ""));
    if (!removeBtn) {
      console.error(`#170 REGRESSION: an added key cannot be removed`);
      process.exit(1);
    }
    console.log("deep render ok: a provider can hold several API keys (#170)");
    // CLOSE it again: the dialog is a full-screen overlay, and leaving it open
    // swallowed the Escape key that the later #50 drawer scenario presses —
    // MEASURED as "#50 REGRESSION: Escape did not close the drawer" in the
    // narrow run, a failure that named the wrong feature entirely.
    const modalClose = [...w.document.querySelectorAll(".modal-head .iconbtn")].at(-1);
    modalClose?.click();
    await new Promise((r) => setTimeout(r, 300));
    if (w.document.querySelector(".modal")) {
      console.error("#170 check did not close the config dialog; later checks would inherit it");
      process.exit(1);
    }
  }

  /* ---------- a DIFFERENT tool must not group under the previous one ------------
   * Reported: "write_file 後の bash が間違ってグループ化されてる". Every tool shared one
   * grouping bucket, so a `bash` after a `write_file` hung under the file panel with no
   * icon of its own. Driven through the real bundle: the defect was in what the feed
   * RENDERED.
   */
  {
    pushEvent({ id: "gx1", seq: 711, ts: "2026-01-01T17:10:01Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "message", data: { role: "assistant", content: "boundary before the tool run" } });
    pushEvent({ id: "gx2", seq: 712, ts: "2026-01-01T17:10:02Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_call", data: { callId: "cx1", name: "write_file", args: { path: "GROUP_SEP.txt", content: "x" } } });
    pushEvent({ id: "gx3", seq: 713, ts: "2026-01-01T17:10:03Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_result", data: { callId: "cx1", name: "write_file", result: "wrote it", ok: true, durationMs: 3 } });
    pushEvent({ id: "gx4", seq: 714, ts: "2026-01-01T17:10:04Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_call", data: { callId: "cx2", name: "bash", args: { command: "echo SEPARATE" } } });
    pushEvent({ id: "gx5", seq: 715, ts: "2026-01-01T17:10:05Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_result", data: { callId: "cx2", name: "bash", result: "SEPARATE", ok: true, durationMs: 3 } });
    flushRefreshes();
    await new Promise((r) => setTimeout(r, 400));
    const rowFor = (needle) => {
      for (const d of w.document.querySelectorAll(".embed")) {
        const sm = d.querySelector("summary");
        // the ROW class carries `grouped`; `.embed` itself only carries `embed grouped`
        const row = d.closest(".msg");
        if (sm && sm.textContent.includes(needle))
          return { head: sm.textContent.trim(), cls: `${row?.className ?? ""} ${d.className}` };
      }
      return null;
    };
    const wrote = rowFor("GROUP_SEP.txt");
    const bash = rowFor("SEPARATE");
    if (!wrote || !bash) {
      console.error(`tool-separation check could not find both rows (${!!wrote}/${!!bash}) — vacuous`);
      process.exit(1);
    }
    // The signal is the `grouped` CLASS, not a glyph: a different tool must start its
    // own row. This used to test for `⚙`, which no longer exists — every tool row now
    // omits it, because it was the same for all of them and identified nothing.
    if (/\bgrouped\b/.test(bash.cls)) {
      console.error(
        `SEPARATION REGRESSION: the bash after a write_file was grouped into its run` +
          `\n  write_file: ${JSON.stringify(wrote.head)} cls=${wrote.cls}` +
          `\n  bash      : ${JSON.stringify(bash.head)} cls=${bash.cls}`,
      );
      process.exit(1);
    }
    // and the write_file row it follows must NOT have been grouped into anything either
    if (/\bgrouped\b/.test(wrote.cls)) {
      console.error(`SEPARATION REGRESSION: the write_file row was itself marked grouped: ${wrote.cls}`);
      process.exit(1);
    }
    console.log("deep render ok: a different tool starts its own block, not a grouped row");
  }

  /* ---------- settings is a MENU: one section visible at a time ----------------
   * "settings ウィンドウもダサいので / メニューベースにする?" — five sections were stacked
   * in one column, so the dialog could not show its own extent. Now: pick a section,
   * see only that one.
   *
   * Asserted on what the operator EXPERIENCES — the COMPUTED display of each section,
   * and whether a typed edit survives switching — never on class names, which is the
   * "shape" this repo's testing rule forbids pinning.
   */
  {
    const openBtn = [...w.document.querySelectorAll("button")].find((b) =>
      /settings|config/i.test(b.getAttribute("title") ?? b.textContent ?? ""),
    );
    if (!openBtn) {
      console.error("#settings check: no settings button");
      process.exit(1);
    }
    openBtn.click();
    await new Promise((r) => setTimeout(r, 400));

    const menu = [...w.document.querySelectorAll(".cfgmenu-item")];
    const panels = [...w.document.querySelectorAll(".cfgpanel fieldset")];
    if (menu.length < 2 || panels.length < 2) {
      console.error(`#settings REGRESSION: no section menu (${menu.length} items, ${panels.length} panels)`);
      process.exit(1);
    }
    const visible = () =>
      [...w.document.querySelectorAll(".cfgpanel fieldset")].filter((f) => {
        const cs = w.document.defaultView.getComputedStyle(f);
        return cs.display !== "none" && cs.visibility !== "hidden";
      });
    if (visible().length !== 1) {
      console.error(`#settings REGRESSION: ${visible().length} sections visible at once — the old stacked form`);
      process.exit(1);
    }
    const wasShowing = visible()[0]?.textContent ?? "";
    const runtimeItem = menu.find((b) => /runtime/i.test(b.textContent ?? ""));
    if (!runtimeItem) {
      console.error("#settings check: no runtime section — vacuous");
      process.exit(1);
    }
    runtimeItem.click();
    await new Promise((r) => setTimeout(r, 250));
    const nowShowing = visible();
    if (nowShowing.length !== 1 || (nowShowing[0]?.textContent ?? "") === wasShowing) {
      console.error("#settings REGRESSION: clicking a menu item did not swap the visible section");
      process.exit(1);
    }

    // a typed edit must survive a round trip: the form is ONE submit, so sections are
    // HIDDEN, not unmounted — switching back must keep what was typed
    const intervalInput = () =>
      [...w.document.querySelectorAll(".cfgpanel label")].find((l) =>
        /progress interval/i.test(l.textContent ?? ""),
      )?.querySelector("input") ?? null;
    const target = intervalInput();
    if (!target) {
      console.error("#settings check: runtime has no progress-interval input — vacuous");
      process.exit(1);
    }
    target.value = "77";
    target.dispatchEvent(new w.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    menu[0].click();
    await new Promise((r) => setTimeout(r, 200));
    runtimeItem.click();
    await new Promise((r) => setTimeout(r, 250));
    const back = intervalInput();
    if (!back || String(back.value) !== "77") {
      console.error(
        `#settings REGRESSION: switching sections discarded a typed edit (77 -> ${JSON.stringify(back?.value)})`,
      );
      process.exit(1);
    }
    console.log("deep render ok: settings is a menu — one section shown, edits survive switching");
    /**
     * TYPING INTO A RUNTIME FIELD MUST NOT DROP FOCUS.
     *
     * Reported: "設定のruntimeメニューのテキストボックスに1文字入力するたびにフォーカスが外れる".
     * The helper was a plain function CALLED in the JSX, so every keystroke re-ran that expression
     * and Solid replaced the `<input>` — a new node cannot hold focus. It is a real component now,
     * mounted once.
     *
     * Asserted on the NODE IDENTITY as well as `activeElement`: a replacement that happens to
     * restore focus would still drop the caret position and any keystroke in flight.
     */
    {
      const field = intervalInput();
      if (!field) {
        console.error("#settings check: no field to type into — vacuous");
        process.exit(1);
      }
      field.focus();
      if (w.document.activeElement !== field) {
        console.error("#settings check: could not focus the field — vacuous");
        process.exit(1);
      }
      field.value = "7";
      field.dispatchEvent(new w.Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const stillThere = intervalInput();
      if (stillThere !== field || w.document.activeElement !== field) {
        console.error(
          "#settings REGRESSION: typing into a runtime field replaced it — focus and caret are lost\n" +
            `  sameNode=${stillThere === field} focus=${JSON.stringify(w.document.activeElement?.tagName ?? null)}`,
        );
        process.exit(1);
      }
      console.log("deep render ok: typing a runtime field keeps the node, the focus and the caret (#focus)");
    }

    /**
     * The help section, and the promise that made it: the explanations that used to sit in the
     * way are GONE from the working UI and available here.
     *
     * The composer hint is the concrete one — a keyboard cheat-sheet printed permanently under
     * the input, read once and then looked past forever. It must not be in the composer any
     * more, and its content must be reachable from settings.
     */
    {
      const helpItem = menu.find((b) => /help/i.test(b.textContent ?? ""));
      if (!helpItem) {
        console.error("#help REGRESSION: settings has no help section");
        process.exit(1);
      }
      helpItem.click();
      await new Promise((r) => setTimeout(r, 250));
      const shown = visible()[0]?.textContent ?? "";
      for (const want of ["shift+enter", "auto-continue", "auto-compact"]) {
        if (!shown.toLowerCase().includes(want)) {
          console.error(`#help REGRESSION: the help section does not mention ${want}`);
          process.exit(1);
        }
      }
      // and the static cheat-sheet must be out of the composer (flash messages still show)
      const hint = w.document.querySelector(".composerwrap .hint, .hint");
      if (hint && /enter send ·/i.test(hint.textContent ?? "")) {
        console.error("#help REGRESSION: the keyboard cheat-sheet is still printed under the composer");
        process.exit(1);
      }
      // go back so the theme checks below find the appearance section
      const appearance = menu.find((b) => /appearance/i.test(b.textContent ?? ""));
      appearance?.click();
      await new Promise((r) => setTimeout(r, 250));
      console.log("deep render ok: help section carries the keyboard + toggle explanations (#help)");
    }

    /* ---------- the background-image control must not lie ----------
     * Reported twice: "ファイルをアップロードしたのに no file chosen になってる".
     *
     * The native `<input type="file">` always reads "no file chosen" once its value is cleared,
     * and it MUST be cleared so the same file can be picked again — so the control's one piece of
     * state was permanently wrong immediately after a successful upload. It is now a button that
     * reports the real outcome, with the input hidden.
     *
     * Also pinned: choosing a file must not reach the settings <form>. It used to fire a full
     * PUT /api/config (saving every setting and running connectAll) on an upload.
     */
    {
      const bgFail = (msg: string) => {
        console.error(`#bgimage REGRESSION: ${msg}`);
        process.exit(1);
      };
      const modal = w.document.querySelector(".modal");
      if (!modal) bgFail("the settings dialog is closed — cannot check the image control");

      // the APPEARANCE section owns the theme editor, so select it through the rail first
      const apprBtn = [...modal!.querySelectorAll("button")].find((b) =>
        /appearance/i.test(b.textContent ?? ""),
      );
      if (!apprBtn) bgFail("no appearance section in the settings rail");
      apprBtn!.click();
      await new Promise((r) => setTimeout(r, 250));

      // the editor (and its background-image control) only exists once a CUSTOM theme does, so
      // create one through the real button rather than assuming it is there
      const dup = () =>
        [...w.document.querySelectorAll(".themeeditor button")].find((b) =>
          /duplicate current/i.test(b.textContent ?? ""),
        );
      if (!dup()) bgFail("no way to create a custom theme — the editor cannot be reached");
      // a real click event, not just .click(): Solid delegates, and the test harness has to
      // deliver the same event a browser would or the handler never runs
      // instrument the shim so a write is visible even if something later clears it
      let bubbled = 0;
      w.document.addEventListener("click", () => { bubbled++; });
      dup()!.click();
      await new Promise((r) => setTimeout(r, 300));
      dup()!.click();
      await new Promise((r) => setTimeout(r, 400));

      // PRECONDITION: the editor rendered its controls, or everything below is vacuous
      if (!w.document.querySelector(".themeeditor .paletterow")) {
        bgFail("the theme editor did not render after creating a theme — nothing to check");
      }

      // 1. no VISIBLE native file input: that is the thing that always says "no file chosen"
      const visibleFile = [...modal!.querySelectorAll('input[type="file"]')].find((i) => {
        const cs = w.document.defaultView.getComputedStyle(i);
        return cs.display !== "none";
      });
      if (visibleFile) {
        bgFail('a native file input is still visible — its label always says "no file chosen"');
      }

      /**
       * 2. A CONTROL opens the picker, and it is the image slot itself.
       *
       * Asserted as BEHAVIOUR, not as label text: the previous check looked for "choose image" /
       * "replace image" wording, which pinned the spelling and would pass for a button that did
       * nothing. Real behaviour is that clicking it reaches the hidden file input.
       */
      const pick = w.document.querySelector(".themeeditor button.bgpick") as HTMLButtonElement | null;
      if (!pick) bgFail("no `.bgpick` control — the theme's image slot must be the thing you click");
      /**
       * SCOPED to the editor. There are TWO image file inputs in the app — the composer's
       * attachment picker and this one — so an unscoped query grabbed whichever came first in the
       * document and measured the wrong control.
       */
      const fileInput = w.document.querySelector(
        '.themeeditor input[type="file"][accept="image/*"]',
      ) as HTMLInputElement | null;
      if (!fileInput) bgFail("no image file input at all");
      /**
       * Spy on the input's own `click()` rather than listening for an event: happy-dom does not
       * synthesise a bubbling click from `HTMLInputElement.click()` the way a browser does, so an
       * event listener measures the harness rather than the product.
       */
      // does the BUTTON receive a click at all? (isolates "handler never runs" from "input not opened")
      let btnClicks = 0;
      pick!.addEventListener("click", () => { btnClicks++; });
      let picked = 0;
      const realClick = fileInput!.click.bind(fileInput!);
      fileInput!.click = () => {
        picked += 1;
      };
      pick!.click();
      fileInput!.click = realClick;
      if (picked === 0) {
        // is the hidden input even IN the editor? a ref that never attached is the likely cause
        const inEditor = !!w.document.querySelector(".themeeditor input[type=file]");
        bgFail(
          `clicking the image slot did not open the file picker (pick=${pick!.tagName}.${pick!.className}` +
            ` inputInEditor=${inEditor} inputConnected=${fileInput!.isConnected} btnClicks=${btnClicks})`,
        );
      }

      // 3. picking a file must not submit the settings form
      let submitted = 0;
      const form = w.document.querySelector("form");
      const onSubmit = (e: Event) => {
        submitted += 1;
        e.preventDefault();
      };
      form?.addEventListener("submit", onSubmit);
      const fileIn = w.document.querySelector('.themeeditor input[type="file"][accept="image/*"]') as
        | HTMLInputElement
        | null;
      if (!fileIn) bgFail("no image file input at all");
      fileIn!.dispatchEvent(new w.Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      form?.removeEventListener("submit", onSubmit);
      if (submitted > 0) {
        bgFail(`choosing a file submitted the settings form (${submitted}x) — that is a full PUT /api/config`);
      }
      console.log("deep render ok: the image control reports its own state and cannot submit the form (#bgimage)");

      /**
       * The SKILLS section lists what the agent can load.
       *
       * The API returned skills and the client kept them for the `/` palette, but nothing ever
       * DISPLAYED them — "どんなスキルが保存されてるかを設定とかで見れると良いね". The precondition
       * is asserted: the stub serves one named skill, so an empty list here means the list is
       * broken rather than empty.
       */
      {
        const skFail = (msg: string) => {
          console.error(`#skills REGRESSION: ${msg}`);
          process.exit(1);
        };
        const rail = [...modal!.querySelectorAll("button")].find((b) =>
          (b.textContent ?? "").includes("skills"),
        );
        if (!rail) skFail("no skills entry in the settings rail");
        rail!.click();
        const rows = [...w.document.querySelectorAll(".skillrow")];
        if (rows.length === 0) skFail("the skills list rendered nothing (the stub serves one skill)");
        const text = rows.map((r) => r.textContent ?? "").join(" | ");
        if (!text.includes("headless-firefox-debug"))
          skFail(`the skill's NAME is not shown; got: ${text}`);
        if (!text.toLowerCase().includes("marionette"))
          skFail(`the skill's description is not shown; got: ${text}`);
        console.log("deep render ok: settings lists the available skills with their descriptions (#skills)");
      }

      /**
       * …AND THE THEME MUST ACTUALLY BE APPLIED.
       *
       * This is the half that was missing, and it is why the bug shipped twice: the control was
       * fixed, the store was fixed, and every edit still went nowhere because the theme being
       * edited was not ACTIVE — `applyCustomTheme()` paints only the active one.
       *
       * Asserting on `data-theme` plus the inline custom property is the only observable that
       * proves the operator would SEE a change: the data attribute names the active theme, and
       * the palette property is what actually repaints the document.
       */
      const html = w.document.documentElement;
      const activeId = html.dataset.theme ?? "";
      if (!/^custom-/.test(activeId)) {
        bgFail(
          `after creating a theme the active theme is ${JSON.stringify(activeId)}, not the new ` +
            `custom one — edits cannot be visible because applyCustomTheme only paints the ACTIVE theme`,
        );
      }
      // the palette is applied as INLINE custom properties (they outrank the stylesheet's)
      const painted = html.style.getPropertyValue("--bg-dark") || html.style.getPropertyValue("--fg");
      if (!painted) {
        bgFail("the active custom theme painted no palette variables — the document is unchanged");
      }
      console.log("deep render ok: creating a theme ADOPTS it, so edits are visible (#bgimage)");
    }

    /* ---------- theme cards must show the THEME, not an empty box ----------
     * Reported: "appearanceのテーマカードが左上に赤い点が付いてるだけで、中身の色がついてない".
     *
     * The preview is a miniature of the UI. Its root is a `<span>`, and an inline box ignores
     * `width`/`height: 100%` — so the positioned children collapsed to nothing and only the
     * fixed-size DOTS were painted. One red dot in the corner was all that survived.
     *
     * Asserted as COLOUR, not as a class: every card must actually carry a background from its
     * palette, and the miniature's own elements must have non-zero size.
     */
    {
      const appearanceFail = (msg: string) => {
        console.error(`#appearance REGRESSION: ${msg}`);
        process.exit(1);
      };
      const appearanceItem = [...w.document.querySelectorAll(".cfgmenu-item")].find((b) =>
        /appearance/i.test(b.textContent ?? ""),
      );
      if (!appearanceItem) {
        appearanceFail("#appearance check: no appearance section in the settings menu");
      }
      appearanceItem.click();
      await new Promise((r) => setTimeout(r, 300));

      const cards = [...w.document.querySelectorAll(".themecard")];
      if (cards.length < 3) {
        appearanceFail(`#appearance check: only ${cards.length} theme card(s) — nothing to compare`);
      }
      const noColour = cards.filter((c) => {
        const prev = c.querySelector(".tprev") as HTMLElement | null;
        const bg = prev ? w.document.defaultView.getComputedStyle(prev).backgroundColor : "";
        // a transparent/empty background means the miniature painted nothing
        return !bg || bg === "transparent" || /rgba\(0, 0, 0, 0\)/.test(bg);
      });
      if (noColour.length > 0) {
        const names = noColour.map((c) => c.textContent?.trim().slice(0, 20)).slice(0, 4);
        appearanceFail(
          `${noColour.length} of ${cards.length} theme cards paint NO background ` +
            `(e.g. ${JSON.stringify(names)}) — the miniature collapsed and only its dots show`,
        );
      }
      // and the miniature must be a BLOCK: an inline box ignores width/height, which is what
      // collapsed it. happy-dom does no layout (every rect is 0x0), so the computable fact is
      // `display` — anything inline means the preview cannot size itself however it is coloured.
      const first = cards[0]!.querySelector(".tprev") as HTMLElement | null;
      const disp = first ? w.document.defaultView.getComputedStyle(first).display : "";
      if (!first || disp === "inline" || disp === "") {
        appearanceFail(
          `the theme preview computes display:${JSON.stringify(disp)} — an inline box ignores ` +
            `width/height, so its positioned children collapse and only the dots paint`,
        );
      }
      console.log(
        `deep render ok: ${cards.length} theme cards paint their palette, preview display:${disp} (#appearance)`,
      );
    }

    // ---- the layout itself: a left rail, and a footer that cannot scroll away ----
    //
    // Asserted on COMPUTED geometry, because these are the properties the operator
    // feels: the menu must be a fixed-width rail beside the panel, and SAVE must be
    // reachable without scrolling the form. happy-dom does no layout and does not
    // expand the `flex-direction` shorthand, so the contract is expressed with what it
    // DOES resolve (`display`, `flex-basis`, `overflow-y`) — the same CSS-contract
    // approach the rest of this file uses for geometry.
    {
      const cssOf = (sel) => {
        const el = w.document.querySelector(sel);
        return el ? w.document.defaultView.getComputedStyle(el) : null;
      };
      const bodyCs = cssOf(".cfgbody");
      const menuCs = cssOf(".cfgmenu");
      const panelCs = cssOf(".cfgpanel");
      const footCs = cssOf(".cfgfoot");
      for (const [name, cs] of [["body", bodyCs], ["menu", menuCs], ["panel", panelCs], ["footer", footCs]]) {
        if (!cs) {
          console.error(`#settings REGRESSION: no .cfg${name} — the rail layout is missing`);
          process.exit(1);
        }
      }
      // side-by-side: the body is a flex row, and the rail has a FIXED basis, so a long
      // section cannot squeeze it
      if (bodyCs.display !== "flex") {
        console.error(`#settings REGRESSION: the body is ${bodyCs.display}, not a flex row`);
        process.exit(1);
      }
      if (!/^0\s+0\s+\d+px/.test(menuCs.flex || menuCs.flexBasis)) {
        console.error(
          `#settings REGRESSION: the rail does not have a fixed width (flex=${JSON.stringify(menuCs.flex)}, basis=${JSON.stringify(menuCs.flexBasis)})`,
        );
        process.exit(1);
      }
      // the panel scrolls ITSELF — that is what keeps the footer in place
      if (!/auto|scroll/.test(panelCs.overflowY)) {
        console.error(
          `#settings REGRESSION: the panel does not scroll on its own (overflow-y=${panelCs.overflowY}) — SAVE would scroll away with the form`,
        );
        process.exit(1);
      }
      // and the section's own <legend> must not repeat what the rail already says
      const legendCs = cssOf(".cfgpanel legend");
      if (legendCs && legendCs.display !== "none") {
        console.error(
          `#settings REGRESSION: the section legend is visible again (display=${legendCs.display}) — it duplicates the rail label`,
        );
        process.exit(1);
      }
    }
    console.log("deep render ok: settings is a left rail with a pinned footer");

    // ---- archive: the reversible half of "remove" ----
    //
    // Drives the real panel: select the archive section, wait for its fetch, and
    // assert that the row names the entry AND that `delete` is visibly the dangerous
    // one. A row that renders both buttons identically would be the exact bug the
    // feature exists to prevent — the operator could not tell reversible from not.
    {
      const railBtns = [...w.document.querySelectorAll(".cfgmenu-item")];
      const archBtn = railBtns.find((b) => /archive/.test(b.textContent ?? ""));
      if (!archBtn) {
        console.error("#archive REGRESSION: no 🗄 archive entry in the settings rail");
        process.exit(1);
      }
      archBtn.click();
      // the section fetches /api/archived on open — poll rather than sleep
      const deadline = Date.now() + 3000;
      let row: Element | null = null;
      while (Date.now() < deadline) {
        row = w.document.querySelector(".archrow");
        if (row) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!row) {
        console.error("#archive REGRESSION: the archive section rendered no rows");
        process.exit(1);
      }
      // PRECONDITION: the row must actually show the entry and its cost
      const rowText = String(row.textContent ?? "");
      if (!rowText.includes("shelved")) {
        console.error(`#archive REGRESSION: the row does not name the archived agent: ${rowText}`);
        process.exit(1);
      }
      if (!/3 sessions/.test(rowText)) {
        console.error(
          `#archive REGRESSION: the row does not say how much history is there: ${rowText}`,
        );
        process.exit(1);
      }
      const restore = row.querySelector(".archrestore");
      const del = row.querySelector("button.danger");
      if (!restore || !del) {
        console.error("#archive REGRESSION: a row must offer BOTH restore and delete");
        process.exit(1);
      }
      // the destructive one must be styled as such, and they must not look the same
      const restoreBg = w.document.defaultView.getComputedStyle(restore).background;
      const delBg = w.document.defaultView.getComputedStyle(del).background;
      if (restoreBg === delBg) {
        console.error(
          `#archive REGRESSION: restore and delete are styled identically (${restoreBg}) — ` +
            "the operator cannot tell reversible from irreversible",
        );
        process.exit(1);
      }
    }
    console.log("deep render ok: archive lists entries with distinct restore/delete");

    // ---- MCP servers (#67): the panel must show each server's LIVE state ----
    {
      const railBtns = [...w.document.querySelectorAll(".cfgmenu-item")];
      const mcpBtn = railBtns.find((b) => /MCP/.test(b.textContent ?? ""));
      if (!mcpBtn) {
        console.error("#mcp REGRESSION: no MCP entry in the settings rail");
        process.exit(1);
      }
      mcpBtn.click();
      // the section fetches /api/mcp on open, so poll for the CARD (renders from props)
      // and then for the PILL (renders only after the fetch resolves)
      const deadline = Date.now() + 3000;
      let card: HTMLElement | null = null;
      while (Date.now() < deadline) {
        card = w.document.querySelector(".mcpcard") as HTMLElement | null;
        if (card) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      while (card && !card.querySelector(".mcpstate") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!card) {
        console.error("#mcp REGRESSION: the MCP section rendered no server cards");
        process.exit(1);
      }
      // PRECONDITION: the configured server must be there, with its url
      const urlInput = card.querySelector('input[placeholder^="https://example.com"]') as HTMLInputElement | null;
      if (!urlInput) {
        console.error("#mcp REGRESSION: the server's url field is missing");
        process.exit(1);
      }
      if (urlInput.value !== "https://mcp.example/mcp") {
        console.error(`#mcp REGRESSION: the url field shows ${JSON.stringify(urlInput.value)}`);
        process.exit(1);
      }
      // the transport selector must reflect the configured transport, not default
      const sel = card.querySelector("select");
      if (!sel || sel.value !== "http") {
        console.error(`#mcp REGRESSION: transport selector shows ${JSON.stringify(sel?.value)}`);
        process.exit(1);
      }
      // and the LIVE state must be visible: a connected server shows its tool count.
      // A panel that silently drops this makes the operator test by asking an agent.
      const pill = card.querySelector(".mcpstate");
      if (!pill) {
        console.error("#mcp REGRESSION: no connection-state pill — status is invisible");
        process.exit(1);
      }
      const pillText = String(pill.textContent ?? "");
      if (!/4 tools/.test(pillText)) {
        console.error(
          `#mcp REGRESSION: the connected server's tool count is not shown (${JSON.stringify(pillText)})`,
        );
        process.exit(1);
      }
      if (!/connected/.test(pill.className)) {
        console.error(`#mcp REGRESSION: the pill does not carry the connected class (${pill.className})`);
        process.exit(1);
      }
      // the test button must exist — it is the only way to check a server before saving
      const testBtn = [...card.querySelectorAll("button")].find((b) => /test/.test(b.textContent ?? ""));
      if (!testBtn) {
        console.error("#mcp REGRESSION: no test button — a bad server can only be found by saving");
        process.exit(1);
      }
    }
    console.log("deep render ok: MCP panel shows server, transport and live tool count");

    // ---- OAuth: a server that demands a grant must OFFER to authorize ----
    //
    // The detection is what makes this automatic: a 401 Bearer challenge means "this
    // needs a grant", and the panel must then show a control that starts the flow.
    // Without it the operator sees only "error" and cannot tell a wrong url from a
    // missing grant.
    {
      const card = w.document.querySelector(".mcpcard") as HTMLElement | null;
      if (!card) {
        console.error("#oauth REGRESSION: no MCP card to check");
        process.exit(1);
      }
      const deadline = Date.now() + 4000;
      let authBtn: HTMLButtonElement | null = null;
      while (Date.now() < deadline) {
        authBtn =
          ([...card.querySelectorAll("button")] as HTMLButtonElement[]).find((b) =>
            /authorize/.test(b.textContent ?? ""),
          ) ?? null;
        if (authBtn) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!authBtn) {
        console.error(
          "#oauth REGRESSION: a server whose status says OAuth is required shows no " +
            "authorize control — the operator is left with a bare error",
        );
        process.exit(1);
      }
      // and it must be WIRED: clicking it must ask the server to start the flow
      const before = requests.filter((r) => r.url === "/api/mcp/oauth/start").length;
      authBtn.click();
      const startDeadline = Date.now() + 4000;
      let started = 0;
      while (Date.now() < startDeadline) {
        started = requests.filter((r) => r.url === "/api/mcp/oauth/start").length;
        if (started > before) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      if (started === before) {
        console.error("#oauth REGRESSION: the authorize button did not start a flow");
        process.exit(1);
      }
    }
    console.log("deep render ok: an OAuth-required server offers a wired authorize control (#oauth)");

    // ---- saving must SURFACE a newly-discovered OAuth requirement ----
    //
    // Reported: "一回設定を補んして設定パネルを閉じて、再度開かないとOAuthのボタンが出ない".
    // The save CONNECTS every server, and that connect is what discovers "needs a grant" —
    // but the panel only fetched the status when the section OPENED, so the button stayed
    // invisible until a reopen.
    {
      const saveBtn = w.document.querySelector(".cfgsave");
      if (!saveBtn) {
        console.error("#oauth-save: no save button");
        process.exit(1);
      }
      const before = requests.filter((r) => r.url === "/api/mcp/oauth/status").length;
      saveBtn.click();
      // the refresh happens during the save handler; poll rather than sleep
      const deadline = Date.now() + 4000;
      let after = before;
      while (Date.now() < deadline) {
        after = requests.filter((r) => r.url === "/api/mcp/oauth/status").length;
        if (after > before) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      if (after === before) {
        console.error(
          "#oauth-save REGRESSION: saving did not re-fetch the OAuth status, so a server " +
            "that turns out to need authorization shows no button until the panel is reopened",
        );
        process.exit(1);
      }
      // The save may KEEP the dialog open on the MCP section (it stays open only when
      // something needs action) or close it. Either way the later checks drive the same
      // panel from the runtime section, so restore that state here — a check must not
      // leave the UI somewhere another check does not expect.
      if (!w.document.querySelector(".modal")) {
        const gear = [...w.document.querySelectorAll(".iconbtn")].find(
          (b) => (b.getAttribute("title") ?? "") === "settings",
        );
        if (!gear) {
          console.error("#oauth-save: could not reopen the settings panel for later checks");
          process.exit(1);
        }
        gear.click();
        await new Promise((r) => setTimeout(r, 200));
      }
      const runtimeBtn = [...w.document.querySelectorAll(".cfgmenu-item")].find((b) =>
        /runtime/.test(b.textContent ?? ""),
      );
      if (!runtimeBtn) {
        console.error("#oauth-save: the settings rail has no runtime section to restore");
        process.exit(1);
      }
      runtimeBtn.click();
      await new Promise((r) => setTimeout(r, 150));
    }
    console.log("deep render ok: saving re-checks OAuth so the button appears without a reopen (#oauth-save)");

    // ---- #161: short-context mode is a REAL toggle, and it defaults to OFF ----
    //
    // It discards information early by design, so an accidental default-on would cost
    // every operator context they had room for. Asserting the default AND that the
    // control is bound (clicking it flips it) is what makes the opt-in guarantee real.
    {
      const railBtns = [...w.document.querySelectorAll(".cfgmenu-item")];
      const runtimeBtn = railBtns.find((b) => /runtime/.test(b.textContent ?? ""));
      if (!runtimeBtn) {
        console.error("#161 REGRESSION: no runtime section in the settings rail");
        process.exit(1);
      }
      runtimeBtn.click();
      await new Promise((r) => setTimeout(r, 60));
      const toggle = w.document.querySelector(".cfgtoggle input[type=checkbox]");
      if (!toggle) {
        console.error("#161 REGRESSION: the short-context toggle is missing from runtime");
        process.exit(1);
      }
      // PRECONDITION: the label must name the mode, or the operator cannot know what
      // this checkbox does
      const labelText = String(toggle.closest(".cfgtoggle")?.textContent ?? "");
      if (!/short-context/.test(labelText)) {
        console.error(`#161 REGRESSION: the toggle is unlabelled: ${JSON.stringify(labelText)}`);
        process.exit(1);
      }
      if (toggle.checked) {
        console.error("#161 REGRESSION: short-context mode is ON by default — it is opt-in");
        process.exit(1);
      }
      // Assert the BINDING through its effect on the saved config, not the checkbox's
      // DOM property: `checked` is set by Solid once, so a broken handler still leaves
      // the DOM checked and the assertion would pass vacuously (MEASURED — replacing
      // the handler with `() => {}` kept the old version of this check green).
      toggle.checked = true;
      toggle.dispatchEvent(new w.Event("change"));
      await new Promise((r) => setTimeout(r, 40));
      const saveBtn = w.document.querySelector(".cfgsave");
      if (!saveBtn) {
        console.error("#161 REGRESSION: no save button to commit the toggle");
        process.exit(1);
      }
      // the save PUTs /api/config; poll for a NEW one.
      //
      // The baseline MUST be taken before the click: taking it afterwards (as an earlier
      // version of this check did once the click was made to await) counts the request it
      // is trying to detect and reports "no PUT /api/config — the handler is not wired".
      //
      // `requests.find(...)` also scanned from the START, so it matched an EARLIER save in
      // this run (there are several, and each asserts its own field) and reported the wrong
      // body: "the saved config does not carry shortContext:true". The request made by
      // THIS click is the last one.
      const putsBefore = requests.filter((c) => c.url === "/api/config" && c.method === "PUT").length;
      saveBtn.click();
      const saveDeadline = Date.now() + 4000;
      let put: { url: string; method: string; body: any } | undefined;
      while (Date.now() < saveDeadline) {
        const puts = requests.filter((c) => c.url === "/api/config" && c.method === "PUT");
        if (puts.length > putsBefore) {
          put = puts[puts.length - 1];
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!put) {
        console.error(
          "#161 REGRESSION: toggling short-context did not change the saved config " +
            "(no PUT /api/config) — the handler is not wired",
        );
        process.exit(1);
      }
      if (put.body?.shortContext !== true) {
        console.error(
          `#161 REGRESSION: the saved config does not carry shortContext:true (got ${JSON.stringify(put.body?.shortContext)})`,
        );
        process.exit(1);
      }
    }
    console.log("deep render ok: short-context mode is an off-by-default bound toggle (#161)");

    // CLOSE the dialog: it is a full-screen overlay, and leaving it open swallows the
    // Escape key that the later #50 drawer scenario presses — MEASURED as
    // "#50 REGRESSION: Escape did not close the drawer", a failure that named the wrong
    // feature entirely.
    [...w.document.querySelectorAll(".modal-head .iconbtn")].at(-1)?.click();
    await new Promise((r) => setTimeout(r, 300));
    if (w.document.querySelector(".modal")) {
      console.error("#settings check did not close the dialog; later checks would inherit it");
      process.exit(1);
    }
  }

  /* ---------- #32: a constant branch label is not repeated on every row --------
   * Reported as part of "タイムラインが煩雑". MEASURED: all 14940 events of one real
   * session carried `br0`, so ~1500 rendered rows each printed "br0" — a label that
   * cannot distinguish anything while there is only one branch. It is worth showing
   * exactly when the session has FORKED.
   */
  {
    const branchLabels = () =>
      [...w.document.querySelectorAll(".msg-head")].filter((h) => /br\d/.test(h.textContent ?? "")).length;
    const before = branchLabels();
    if (before !== 0) {
      console.error(
        `#32 REGRESSION: ${before} rows repeat the branch label on a single-branch session`,
      );
      process.exit(1);
    }
    console.log("deep render ok: one branch -> no per-row branch label (#32)");
  }

  /* ---------- #160: scrolling to the tail must mark notifications read -------
   * "タイムラインを下までスクロールしても通知が既読にならない" (v0.29.17).
   *
   * `markSessionRead` had exactly ONE caller — the feed-refresh path — and it sat
   * inside `if (events().at(-1)?.id !== beforeId)`. So a session whose unread
   * notifications were ALREADY in `events()` marked nothing when the reader
   * scrolled down: no new event arrived, that branch never ran, and the badge
   * stayed lit. The scroll itself was never a reason to mark anything read.
   *
   * Driven through the REAL bundle, because the defect is a missing CALL SITE —
   * the helper was always correct, so a helper test would have been green all
   * along (#40's lesson, again).
   */
  {
    const sock = MockWS.instances.at(-1);
    if (!sock) {
      console.error("smoke: no app socket — the bundle never opened one");
      process.exit(1);
    }
    if (!sock?.onmessage) {
      console.error("#160 check: no app socket to drive");
      process.exit(1);
    }
    const unreadBadge = () => w.document.querySelector(".notifdot");
    // SERVE FIRST, then LOOK — exactly the reported case, and the one the old
    // code could not handle: the notification is already in the feed before the
    // reader scrolls, so no later refresh will come along to rescue the badge.
    //
    // A `message` with `final:true` is what raises a "finished" notification.
    pushEvent({
      id: "e160", seq: 160, ts: "2026-01-01T11:00:00Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "message",
      data: { role: "assistant", content: "all done here", final: true },
    });
    sock.onmessage({ data: JSON.stringify({
      kind: "agent-update", agentId: AGENT.id,
      snapshot: { ...RUNNING_AGENT, session: "alpha-s1" },
    }) });
    await new Promise((r) => setTimeout(r, 250));
    if (!unreadBadge()) {
      console.error("#160 check could not raise an unread badge — the test would pass vacuously");
      process.exit(1);
    }
    // give the feed a real scrollable height, or assigning scrollTop is a silent
    // no-op and the check passes without ever reaching the tail
    const feed = w.document.querySelector(".feed");
    if (!feed) {
      console.error("#160 check: .feed not found");
      process.exit(1);
    }
    const filler = w.document.createElement("div");
    filler.style.height = "4000px";
    feed.appendChild(filler);
    await new Promise((r) => setTimeout(r, 40));
    // the reader scrolls all the way down — the action the report describes
    feed.scrollTop = feed.scrollHeight;
    feed.dispatchEvent(new w.Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const still = unreadBadge();
    filler.remove();
    if (still) {
      console.error(
        "#160 REGRESSION: scrolling to the bottom left the notification unread" +
          `\nbadge: ${still.textContent}`,
      );
      process.exit(1);
    }
    console.log("deep render ok: scrolling to the tail marks the session read (#160)");
  }

  /* ---------- a new message must not re-mount the rows above it ----------
   * Reported: "apply_patch のカードを展開していたのに、新しいメッセージが来ると展開していた
   * のが閉じられる". A `<details open>` that CLOSES on its own is proof the row was
   * disposed and re-created — the browser drops the open state with the node.
   *
   * That is why this is measured rather than asserted on markup: a remount renders
   * IDENTICAL HTML, so every DOM-shaped check passes while the operator watches their
   * work collapse. The observable difference is DOM IDENTITY — the element that was on
   * screen must still be the same element afterwards.
   *
   * This is the re-render test the timeline never had: it counts how many rows an append
   * actually recreated.
   */
  {
    const rowsNow = () => [...w.document.querySelectorAll(".feed .msg")] as HTMLElement[];
    const details = [...w.document.querySelectorAll(".feed details")].filter(
      (d): d is HTMLDetailsElement => d instanceof w.HTMLDetailsElement,
    );
    if (details.length === 0) {
      console.error("#rerender check: no <details> in the feed — check would be vacuous");
      process.exit(1);
    }
    const watched = details[0]!;
    watched.open = true;
    // remember the row ELEMENTS before the append; identity is the thing being measured
    const before = rowsNow();
    const beforeIds = before.map((r) => r.dataset.eid ?? "");
    if (before.length < 2) {
      console.error(`#rerender check: only ${before.length} row(s) — cannot tell a remount from a no-op`);
      process.exit(1);
    }

    // one new message arrives, exactly as during a run
    pushEvent({
      id: "rerender-1",
      seq: 90001,
      ts: new Date().toISOString(),
      session: "alpha-s1",
      branch: "br0",
      parent: null,
      type: "message",
      data: { role: "assistant", content: "AFTER_APPEND" },
    });
    flushRefreshes();
    await waitFor("the appended row renders", () => bodyText().includes("AFTER_APPEND"), 8000);
    await new Promise((r) => setTimeout(r, 120));

    if (!bodyText().includes("AFTER_APPEND")) {
      console.error("#rerender check: the appended message never rendered");
      process.exit(1);
    }

    const after = rowsNow();
    const afterById = new Map(after.map((r) => [r.dataset.eid ?? "", r]));
    let remounted = 0;
    const examples: string[] = [];
    for (const [i, id] of beforeIds.entries()) {
      if (!id) continue;
      if (afterById.get(id) !== before[i]) {
        remounted++;
        if (examples.length < 3) examples.push(id);
      }
    }
    if (remounted > 0) {
      console.error(
        `#rerender REGRESSION: appending ONE message re-created ${remounted} of ${before.length} ` +
          `row(s) (e.g. ${examples.join(", ")}). A remount renders identical HTML but drops DOM ` +
          `state — that is why an expanded <details> slams shut, and why the timeline flickers.`,
      );
      process.exit(1);
    }
    if (!watched.isConnected || !watched.open) {
      console.error(
        "#rerender REGRESSION: the open <details> did not survive the append — its row was re-created",
      );
      process.exit(1);
    }

    /**
     * …and the SAME cause resets an inner scroll position.
     *
     * Reported: "bash 出力をスクロールしているとスクロール位置がリセットされる". A tool body is
     * `.embed .mono { max-height; overflow-y: auto }` — its scroll offset lives on that
     * ELEMENT. If the row is re-created, the offset dies with it; if only the row survives but
     * a CHILD is rebuilt (Solid re-runs a subtree whose props changed), the offset dies too.
     * So measure the scrolling element itself, not just the row.
     */
    const scrollable = [...w.document.querySelectorAll(".feed .embed .mono, .feed .toolbody")]
      .find((el) => (el as HTMLElement).scrollHeight > 0 || el.textContent.length > 0);
    if (!scrollable) {
      console.error(
        "#rerender check: no tool body in the feed — the inner-scroll half would be vacuous",
      );
      process.exit(1);
    }
    const scroller = scrollable as HTMLElement;
    // happy-dom does not lay out, so give it a real scrollable box and pin an offset
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 900 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 300 });
    let innerTop = 200;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => innerTop,
      set: (v: number) => {
        innerTop = Math.max(0, Math.min(v, 600));
      },
    });
    if (innerTop !== 200) {
      console.error("#rerender check: could not pin the inner scroll offset — vacuous");
      process.exit(1);
    }

    // another message arrives; the scrolled tool body must be the SAME element afterwards
    pushEvent({
      id: "rerender-2",
      seq: 90002,
      ts: new Date().toISOString(),
      session: "alpha-s1",
      branch: "br0",
      parent: null,
      type: "message",
      data: { role: "assistant", content: "AFTER_APPEND_2" },
    });
    flushRefreshes();
    await waitFor("the second appended row renders", () => bodyText().includes("AFTER_APPEND_2"), 8000);
    await new Promise((r) => setTimeout(r, 120));

    if (!scroller.isConnected) {
      console.error(
        "#rerender REGRESSION: the tool body that was scrolled is GONE after an append — its " +
          "subtree was re-created, which resets the scroll offset (the reported スクロール位置" +
          "がリセットされる)",
      );
      process.exit(1);
    }
    if (innerTop !== 200) {
      console.error(
        `#rerender REGRESSION: a scrolled tool body lost its offset (200 -> ${innerTop}) after ` +
          `an unrelated message arrived — the element was re-created under the row`,
      );
      process.exit(1);
    }
    console.log(
      `deep render ok: an appended message re-uses all ${before.length} existing rows, keeps <details> open, and preserves an inner scroll offset (#rerender)`,
    );
  }

  /**
   * A tool WITHOUT an explicit case must still show its OUTPUT.
   *
   * Reported: "bashやfile系以外のツールは入力パラメータは表示されるのに出力がタイムラインに表示され
   * ない". The `switch` in ToolRow had cases for bash/read_file/write_file/edit_file/
   * apply_patch/list_dir/read_url/bash_output/load_skill/save_skill and NO `default`, so every
   * other tool — MCP tools, wait_children, read_memory, the meta tools — kept the initial body,
   * which is the JSON of its INPUT. The result was in the log and paired correctly; nothing
   * rendered it.
   */
  {
    const outToken = "MCP_TOOL_OUTPUT_9c3f";
    pushEvent({
      id: "defcall", seq: 91001, ts: new Date().toISOString(), session: "alpha-s1",
      branch: "br0", parent: null, type: "tool_call",
      data: { callId: "cd1", name: "mcp__notion__search", args: { query: "IN_TOKEN_4a2b" } },
    });
    pushEvent({
      id: "defres", seq: 91002, ts: new Date().toISOString(), session: "alpha-s1",
      branch: "br0", parent: null, type: "tool_result",
      data: { callId: "cd1", ok: true, result: outToken, durationMs: 12 },
    });
    flushRefreshes();
    // PRECONDITION: the row exists and rendered its INPUT, or a missing output proves nothing
    if (!(await waitFor("the generic tool row renders", () => bodyText().includes("IN_TOKEN_4a2b"), 8000))) {
      console.error(
        "#toolout check: the row for a non-bash tool never rendered its input args — vacuous",
      );
      process.exit(1);
    }
    if (!bodyText().includes(outToken)) {
      console.error(
        "#toolout REGRESSION: a non-bash/file tool rendered its INPUT but not its OUTPUT — the " +
          "row's switch has no `default`, so every tool without an explicit case shows only " +
          "its arguments (reported: bashやfile系以外のツールは出力が表示されない)",
      );
      process.exit(1);
    }
    console.log("deep render ok: a tool with no explicit case still shows its output (#toolout)");
  }
}

/* ---------- #scroll: typing into a grown composer must not move the feed ----------
 * Reported (and unfixed until the state-based rewrite): "スクロール追従中に2行以上に拡大した
 * 入力欄に入力をするとちょっと上にスクロールする".
 *
 * The mechanism, which is why no before/after sample could ever decide it: growing the
 * composer SHRINKS the feed's viewport. Content and `scrollTop` are untouched, but the gap
 * to the tail becomes exactly the growth. Any rule that re-derives "is the reader at the
 * tail" from that gap concludes they moved, and then either stops following or scrolls to
 * "correct" a gap it thinks is real.
 *
 * happy-dom does no layout, so the geometry is simulated precisely: a scrollable feed, the
 * reader pinned at the tail, then the viewport shrinks by 40px as the composer grows a line.
 * The invariant is that `scrollTop` comes back to the new maximum — the tail is still shown.
 */
{
  const feed = w.document.querySelector(".feed") as HTMLElement | null;
  const ta = w.document.querySelector(".composer textarea") as HTMLTextAreaElement | null;
  if (!feed || !ta) {
    console.error("#scroll check: .feed or the composer textarea is missing");
    process.exit(1);
  }
  const CONTENT = 4000;
  let viewport = 800;
  // a real, scrollable feed: scrollHeight is fixed content, clientHeight is the viewport
  Object.defineProperty(feed, "scrollHeight", { configurable: true, get: () => CONTENT });
  Object.defineProperty(feed, "clientHeight", { configurable: true, get: () => viewport });
  let scrollTop = 0;
  Object.defineProperty(feed, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    // the browser clamps to the real maximum, which is what `pinToTail` relies on
    set: (v: number) => {
      scrollTop = Math.max(0, Math.min(v, Math.max(0, CONTENT - viewport)));
    },
  });
  // The composer must really measure as growing, or `autosizeComposer` sees an unchanged
  // height and never resizes — the check would then pass without exercising the bug at all.
  // happy-dom reports 0 for a textarea's scrollHeight, so simulate it: each extra line is
  // 20px, which is what the real box does.
  const LINE = 20;
  const lines = () => Math.max(1, ta.value.split("\n").length);
  Object.defineProperty(ta, "scrollHeight", {
    configurable: true,
    get: () => lines() * LINE,
  });
  // start pinned at the tail — the state the report describes ("スクロール追従中")
  scrollTop = CONTENT - viewport;
  feed.dispatchEvent(new w.Event("scroll", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  const atTailBefore = CONTENT - scrollTop - viewport;
  if (atTailBefore > 1) {
    console.error(`#scroll check: could not place the reader at the tail (gap ${atTailBefore}) — vacuous`);
    process.exit(1);
  }

  /**
   * The REAL causal chain, which is what the app relies on:
   *
   *   the composer grows a line  ->  the feed's BOX shrinks (they are flex siblings)
   *                             ->  ResizeObserver on .feed fires
   *                             ->  the app re-pins if following
   *
   * So the check must (a) make the composer measure a new height and (b) make the FEED
   * report a new box, then pump the observers. Driving only `clientHeight` would test the
   * harness's model of the app rather than the app.
   */
  const growComposer = (value: string, byPx: number) => {
    ta.value = value;
    ta.dispatchEvent(new w.Event("input", { bubbles: true }));
    // the feed's box shrinks by the same amount, as flex layout would do
    viewport -= byPx;
    // the ResizeObserver stub reports an element's height from its style/offsetHeight, so
    // give the feed one it can see change
    Object.defineProperty(feed, "offsetHeight", { configurable: true, get: () => viewport });
    pumpResize();
  };

  // The composer grows a line — the reported action.
  growComposer("line one\nline two", 40);
  await new Promise((r) => setTimeout(r, 150));

  const gapAfter = CONTENT - scrollTop - viewport;
  if (gapAfter > 32) {
    console.error(
      `#scroll REGRESSION: the composer growing left the reader ${gapAfter}px above the tail ` +
        `(scrollTop ${scrollTop}, content ${CONTENT}, viewport ${viewport}) — this is the reported ` +
        `"入力欄が2行以上に拡大するとちょっと上にスクロールする"`,
    );
    process.exit(1);
  }
  // PRE-CONDITION for the next half: the mechanism really did fire at least once
  if (viewport !== 760) {
    console.error(`#scroll check: the viewport did not shrink as expected (${viewport}) — vacuous`);
    process.exit(1);
  }

  /**
   * A FOLLOWER growing to 3+ lines — the case reported as "3行以上に入力欄が拡大してると入力時に
   * スクロールが戻る (2行の時は問題ない)".
   *
   * The case below this only ever grew the composer while PARKED, so it never exercised a
   * follower at 3 lines. Two lines leaves the reader 40px from the tail, which is outside
   * `AT_TAIL_PX`; each further line adds more distance, so if anything mis-measures the floor
   * the error compounds with height rather than appearing at a threshold.
   */
  scrollTop = CONTENT - viewport;
  feed.dispatchEvent(new w.Event("scroll", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  for (const value of ["a", "a\nb", "a\nb\nc", "a\nb\nc\nd"]) {
    growComposer(value, 20);
    await new Promise((r) => setTimeout(r, 80));
    const gap = CONTENT - scrollTop - viewport;
    if (gap > 8) {
      console.error(
        `#scroll REGRESSION: a follower was left ${gap}px above the tail while the composer ` +
          `grew to ${value.split("\n").length} line(s) (scrollTop ${scrollTop}, content ` +
          `${CONTENT}, viewport ${viewport}) — reported as "3行以上に入力欄が拡大してると入力時に` +
          `スクロールが戻る"`,
      );
      process.exit(1);
    }
  }
  console.log("deep render ok: a follower stays at the tail as the composer grows line by line (#scroll)");

  // A reader who deliberately scrolled up must STILL be left alone: the fix must not have
  // been bought by following unconditionally.
  const parked = CONTENT - viewport - 1000;
  scrollTop = parked;
  feed.dispatchEvent(new w.Event("scroll", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  growComposer("line one\nline two\nline three", 40);
  await new Promise((r) => setTimeout(r, 150));
  if (Math.abs(scrollTop - parked) > 32) {
    console.error(
      `#scroll REGRESSION: a reader who scrolled up was dragged (scrollTop ${scrollTop}, ` +
        `expected ~${parked}) when the composer grew`,
    );
    process.exit(1);
  }
  console.log(
    "deep render ok: a growing composer re-pins a follower and leaves a scrolled-up reader alone (#scroll)",
  );

  /**
   * AND IT MUST STILL WORK AFTER A SESSION SWITCH.
   *
   * This is the half that made v0.29.44 pass every check and do nothing in the real app.
   * The timeline lives inside `<Show when={sel()?.id} keyed>`, so switching session REBUILDS
   * `.channel` and with it `.feed` — a NEW DOM node. A ResizeObserver attached once at mount
   * keeps watching the OLD, detached node and never fires again. The harness renders once, so
   * it could not see that; here we switch and re-run the same growth.
   */
  {
    const switchToBeta = async () => {
      const row = [...w.document.querySelectorAll(".agent-item")].find((el) =>
        /\bbeta\b/.test(el.textContent ?? ""),
      ) as HTMLElement | undefined;
      if (!row) {
        console.error("#scroll check: no beta agent row — cannot test the post-switch case");
        process.exit(1);
      }
      row.click();
      await new Promise((r) => setTimeout(r, 250));
    };
    await switchToBeta();
    const feed2 = w.document.querySelector(".feed") as HTMLElement | null;
    if (!feed2) {
      console.error("#scroll check: .feed missing after the switch");
      process.exit(1);
    }
    // PRECONDITION: `<Show … keyed>` must have produced a NEW element, or this proves nothing
    if (feed2 === feed) {
      console.error(
        "#scroll check: the feed element did not change across the session switch — the " +
          "keyed rebuild this check exists for did not happen, so it is vacuous",
      );
      process.exit(1);
    }
    const CONTENT2 = 3000;
    let viewport2 = 700;
    let top2 = 0;
    Object.defineProperty(feed2, "scrollHeight", { configurable: true, get: () => CONTENT2 });
    Object.defineProperty(feed2, "clientHeight", { configurable: true, get: () => viewport2 });
    Object.defineProperty(feed2, "offsetHeight", { configurable: true, get: () => viewport2 });
    Object.defineProperty(feed2, "scrollTop", {
      configurable: true,
      get: () => top2,
      set: (v: number) => {
        top2 = Math.max(0, Math.min(v, Math.max(0, CONTENT2 - viewport2)));
      },
    });
    top2 = CONTENT2 - viewport2;
    feed2.dispatchEvent(new w.Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    // …now grow the composer, exactly as before
    const ta2 = w.document.querySelector(".composer textarea") as HTMLTextAreaElement | null;
    if (!ta2) {
      console.error("#scroll check: composer textarea missing after the switch");
      process.exit(1);
    }
    Object.defineProperty(ta2, "scrollHeight", { configurable: true, get: () => 60 });
    ta2.value = "a\nb\nc";
    ta2.dispatchEvent(new w.Event("input", { bubbles: true }));
    viewport2 -= 40;
    pumpResize();
    await new Promise((r) => setTimeout(r, 150));
    const gap2 = CONTENT2 - top2 - viewport2;
    if (gap2 > 32) {
      console.error(
        `#scroll REGRESSION: after a session switch the feed observer is watching a DETACHED ` +
          `node, so growing the composer left the reader ${gap2}px above the tail. The timeline ` +
          `is rebuilt by <Show keyed>, so the observer must re-attach (use the feed's ref).`,
      );
      process.exit(1);
    }
    console.log("deep render ok: the feed box observer survives a session switch (#scroll)");

    // PUT IT BACK. Every later check assumes this document is showing `alpha`; leaving it on
    // `beta` made an unrelated assertion fail ("no events yet") and would have hidden the
    // real cause. A check that changes global state must undo it.
    const back = [...w.document.querySelectorAll(".agent-item")].find((el) =>
      /\balpha\b/.test(el.textContent ?? ""),
    ) as HTMLElement | undefined;
    back?.click();
    await new Promise((r) => setTimeout(r, 250));
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
  if (!appWs2) {
    console.error("smoke: no app socket for the update check");
    process.exit(1);
  }
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

  // ---- a DRAGGED height must survive the edit/preview toggle ----
  //
  // The textarea is natively resizable, so the browser applies a drag as an INLINE height
  // on that one element. The preview is a DIFFERENT element and fell back to the
  // stylesheet's `11.5em`, so the height was lost on every switch. The component now
  // remembers it (and persists it), which is what this asserts.
  {
    const edit = w.document.getElementById("todo-input");
    if (!edit) {
      console.error("#todo-height: the editor is gone — the check would be vacuous");
      process.exit(1);
    }
    // happy-dom does no layout, so a real drag cannot be simulated; set the inline height
    // the browser would have written, then PUMP the observer the way a real drag would
    edit.style.height = "260px";
    pumpResize();
    // the component's callback is deferred, so let it run
    await new Promise((r) => setTimeout(r, 80));

    const toggle = [...w.document.querySelectorAll("button")].find(
      (b) => (b.getAttribute("title") ?? "") === "rendered checklist",
    );
    if (!toggle) {
      console.error("#todo-height: no toggle to the preview");
      process.exit(1);
    }
    toggle.click();
    await new Promise((r) => setTimeout(r, 100));

    const pane = w.document.querySelector(".todopane");
    if (!pane) {
      console.error("#todo-height: the preview pane never rendered");
      process.exit(1);
    }
    // PRECONDITION: the preview really is the OTHER element, or "the height survived"
    // would just mean we measured the same node twice
    if (pane.id === "todo-input") {
      console.error("#todo-height: the preview is the editor — the check is vacuous");
      process.exit(1);
    }
    if ((pane as HTMLElement).style.height !== "260px") {
      console.error(
        `#todo-height REGRESSION: the dragged height was lost switching to the preview ` +
          `(style.height=${JSON.stringify((pane as HTMLElement).style.height)})`,
      );
      process.exit(1);
    }

    // and back again: the EDITOR must come back at the same height
    const back = [...w.document.querySelectorAll("button")].find(
      (b) => (b.getAttribute("title") ?? "") === "edit markdown",
    );
    back?.click();
    await new Promise((r) => setTimeout(r, 100));
    const edit2 = w.document.getElementById("todo-input") as HTMLElement | null;
    if (!edit2 || edit2.style.height !== "260px") {
      console.error(
        `#todo-height REGRESSION: the height was lost coming back to the editor ` +
          `(style.height=${JSON.stringify(edit2?.style.height ?? null)})`,
      );
      process.exit(1);
    }
    // it must also be REMEMBERED, so a reload or a panel re-render keeps it
    if (localStorage.getItem("teapot.todoH") !== "260") {
      console.error(
        `#todo-height REGRESSION: the height was not persisted ` +
          `(teapot.todoH=${JSON.stringify(localStorage.getItem("teapot.todoH"))})`,
      );
      process.exit(1);
    }
  }
  console.log("deep render ok: a dragged tasks height survives the edit/preview toggle (#todo-height)");
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
  //
  // Sub-agent groups are now COLLAPSED BY DEFAULT, so this starts from an explicit
  // expansion: a default-collapsed caret that was never clicked would make the
  // "collapsing hides the child" assertion below pass without exercising anything.
  caretIn(rowFor("gamma"))?.click();
  await sleep(200);
  const expandedGamma = [...w.document.querySelectorAll(".agent-item")]
    .map((el) => el.textContent.match(/\b(gamma-sub|alpha|beta|gamma)\b/)?.[1])
    .filter(Boolean);
  if (!expandedGamma.includes("gamma-sub")) {
    fail(
      `precondition: expanding gamma must reveal gamma-sub, got ${JSON.stringify(expandedGamma)} — ` +
        `without this the collapse check below proves nothing`,
    );
  }
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

  /* ---------- a caret row must always carry its count ----------
   * Reported: "サブエージェントが存在する(折りたたみのアイコンが有る)のに、サブエージェント数が
   * カウントされていないセッションがあります".
   *
   * Sub-agent groups are COLLAPSED BY DEFAULT now, so the predicate deciding "is this subtree
   * hidden?" is `subsCollapsed()`. The 🧩 badge still read the RAW persisted set, where
   * "absent" means OPEN — so on every default-collapsed row the badge was suppressed, while
   * the count was exactly what the caret was promising. The two must agree.
   *
   * Only COLLAPSED rows are checked: an expanded row shows its children, so a count there
   * would restate what is already on screen.
   */
  {
    const withCaret = [...w.document.querySelectorAll(".agent-item")].filter((el) =>
      el.querySelector(".caret"),
    );
    const collapsed = withCaret.filter((el) =>
      (el.querySelector(".caret")?.textContent ?? "").includes("▸"),
    );
    if (collapsed.length === 0) {
      fail("#panel check: no COLLAPSED caret rows — the count check would be vacuous");
    }
    const missing = collapsed.filter((el) => !el.querySelector(".subcount"));
    if (missing.length > 0) {
      const names = missing.map((el) => el.textContent?.trim().slice(0, 24)).slice(0, 4);
      fail(
        `${missing.length} row(s) offer a collapse caret but show NO sub-agent count ` +
          `(e.g. ${JSON.stringify(names)}). The caret says "there is more under here" and the ` +
          `badge is the only thing that says how much.`,
      );
    }
    console.log(
      `deep render ok: every COLLAPSED caret row carries its sub-agent count (#panel, ${collapsed.length} rows)`,
    );
  }

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
  // This block is the ONLY one gated on loading narrow: it checks that the
  // minifier's hoisted media-query rules still leave the ✕ row visible, which
  // happy-dom can only answer for the width the document was parsed at. The
  // caller therefore runs this script twice (1440 and 900) — see
  // test/web-bundle.test.ts. Everything else here runs once, wide, and the
  // resize scenario below narrows in-process for the flows that need it.
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
  const stopCalls: string[] = [];
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

// ---- #108: the compaction banner must live INSIDE the scrollable feed ----
//
// If it sat outside the feed it could not change the scroll height at all, which is the
// whole reason a compaction pass detaches follow mode. Asserted in the real DOM: push the
// `compaction-progress` frame the server sends and check where the banner lands.
{
  const sock = MockWS.instances.at(-1);
  if (!sock?.onmessage) {
    console.error("#108 REGRESSION: no app socket to drive");
    process.exit(1);
  }
  sock.onmessage({
    data: JSON.stringify({
      kind: "compaction-progress",
      agentId: AGENT.id,
      phase: "summarizing",
      summarized: 120,
    }),
  });
  await new Promise((r) => setTimeout(r, 200));

  const banner = w.document.querySelector(".divider-msg.compacting");
  if (!banner) {
    console.error("#108 REGRESSION: the compaction banner never rendered");
    process.exit(1);
  }
  // PRECONDITION + the property: the banner is a DESCENDANT of the scroll container, so
  // it contributes to scrollHeight. Asserting the containment is the structural fact the
  // old source-text test was standing for.
  const feed = w.document.querySelector(".feed");
  if (!feed || !feed.contains(banner)) {
    console.error(
      "#108 REGRESSION: the compaction banner is outside .feed, so a pass cannot change " +
        "the scroll height — follow mode can no longer detach on it",
    );
    process.exit(1);
  }
  // and it says what phase it is in, so the operator can tell it is working
  if (!/summarizing/.test(banner.textContent ?? "")) {
    console.error(`#108: the banner does not name the phase: ${JSON.stringify(banner.textContent)}`);
    process.exit(1);
  }
  // clearing it (phase done) removes the row again — the other direction
  sock.onmessage({
    data: JSON.stringify({ kind: "compaction-progress", agentId: AGENT.id, phase: "done" }),
  });
  await new Promise((r) => setTimeout(r, 200));
  if (w.document.querySelector(".divider-msg.compacting")) {
    console.error("#108 REGRESSION: the banner survived its `done` phase");
    process.exit(1);
  }
}
console.log("deep render ok: the compaction banner lives inside the feed (#108)");

/* ---------- scroll follow is asserted as a CSS/behaviour CONTRACT ----------
 * happy-dom does no layout: `scrollHeight` is always 0, so a check that appends rows and asserts
 * the reader stayed at the tail is VACUOUS there (it cannot distinguish a re-pin from a no-op).
 * That is why this lives in `test/scroll-follow-content.test.ts`, which asserts the rule the
 * effect obeys. Real geometry belongs in the browser harness, not here.
 */


// give deferred Solid effects a final tick before declaring victory
await new Promise((r) => setTimeout(r, 120));
console.log(`first render survived (${fetchCount} api calls served)`);
process.exit(0);