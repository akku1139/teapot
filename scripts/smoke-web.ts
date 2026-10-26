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

const AGENT = {
  id: "alpha",
  status: "idle",
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
  ctx: { usedTokens: 123_456, compactAt: 72_000, window: 200_000 },
};

const EVENTS = [
  { id: "e1", seq: 1, ts: "2026-01-01T10:00:00Z", session: "alpha-s1", branch: "br0", parent: null,
    type: "prompt", data: { source: "user", text: "hello **world**" } },
  { id: "e2", seq: 2, ts: "2026-01-01T10:00:05Z", session: "alpha-s1", branch: "br0", parent: "e1",
    type: "message", data: { content: "hi there\n\n- one\n- two", final: true } },
  { id: "e3", seq: 3, ts: "2026-01-01T10:00:09Z", session: "alpha-s1", branch: "br0", parent: "e2",
    type: "tool_call", data: { callId: "c1", name: "bash", args: { 
      command: "echo SHIKI_MARKER --flag=value --another-flag=value2 --third-flag=value3 --fourth-flag=value4 --fifth-flag=value5 --sixth" } } },
  { id: "e4", seq: 4, ts: "2026-01-01T10:00:10Z", session: "alpha-s1", branch: "br0", parent: "e3",
    type: "tool_result", data: { callId: "c1", name: "bash", result: "file.txt", ok: true, durationMs: 12 } },
  // a tool that returned an IMAGE: the timeline must show it, not just the sentence about it (#blobs)
  { id: "e-img-call", seq: 4, ts: "2026-01-01T10:00:10Z", session: "alpha-s1", branch: "br0", parent: "e4",
    type: "tool_call", data: { callId: "c-img", name: "read_file", args: { path: "card.jpg" } } },
  { id: "e-img-res", seq: 5, ts: "2026-01-01T10:00:10Z", session: "alpha-s1", branch: "br0", parent: "e-img-call",
    type: "tool_result", data: { callId: "c-img", name: "read_file", ok: true, durationMs: 9,
      result: "card.jpg is a JPEG image — the image itself is attached to this message",
      images: [{ url: "blobs/3220fc7838ccdab0a3a21b5d8498275c7abe6930abbb059e9fdb4939bba8c2fd.jpg", name: "card.jpg" }] } },
  { id: "e4b", seq: 5, ts: "2026-01-01T10:00:11Z", session: "alpha-s1", branch: "br0", parent: "e4",
    type: "prompt", data: { source: "harness", text: "[harness] Sub-agent alpha-kid finished. Final report:\nCHILD REPORT TEXT" } },
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
      mcpServers: [{ name: "files", url: "https://mcp.example/mcp", transport: "http", enabled: true }],
      agents: [{ id: AGENT.id, workspace: AGENT.workspace }],
      tasks: [],
    };
  if (u === "/api/agents")
    return { agents: [AGENT, { ...AGENT, id: "beta", workspace: "/tmp/other-project" }] };
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
  if (u === "/api/mcp")
    return {
      servers: [{ name: "files", url: "https://mcp.example/mcp", transport: "http", enabled: true }],
      states: [{ name: "files", status: "connected", tools: 4 }],
    };
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
const requestedUrls: string[] = [];

const WS_EVENTS = []; 
class MockWS {
  static instances: MockWS[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(_data: string) {
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

const BOOT_SESSION = "alpha-s1";
const w = new Window({ url: `http://localhost:7788/session/${BOOT_SESSION}` });
let viewportWidth = Number(process.env.SMOKE_WIDTH ?? 1440);
Object.defineProperty(w, "innerWidth", {
  configurable: true,
  get: () => viewportWidth,
  set: (v) => { viewportWidth = Number(v); },
});
w.document.body.innerHTML = `<div id="root"></div>`;

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
  }
};
setGlobal("window", w);
setGlobal("document", w.document);
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
const resizeObservers: { check: () => void }[] = [];
const pumpResize = () => {
  for (const ro of resizeObservers) ro.check();
};
setGlobal(
  "ResizeObserver",
  class {
    cb: (entries: unknown[]) => void;
    targets: { el: any; last: number }[] = [];
    constructor(cb: (entries: unknown[]) => void) {
      this.cb = cb;
      resizeObservers.push(this);
    }
    observe(el: any) {
      this.targets.push({ el, last: -1 });
      this.check();
    }
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

const requests: { url: string; method: string; body: any }[] = [];
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

async function waitFor(label, predicate, deadlineMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      if (predicate()) return true;
    } catch {  }
    await new Promise((r) => setTimeout(r, 50));
  }
  console.error(`DEEP RENDER TIMEOUT: ${label} never became true`);
  if (process.env.SMOKE_DEBUG)
    console.error("BODY:", JSON.stringify(bodyText().slice(0, 2500)));
  return false;
}

const bodyText = () => w.document.body.textContent ?? "";

if (!(await waitFor("agent list", () => bodyText().includes("alpha")))) process.exit(1);
console.log("deep render ok: sidebar shows agent");

if (!(await waitFor("runtime gauge", () => bodyText().includes("61.7% of 200k")))) process.exit(1);
console.log("deep render ok: context gauge shows '61.7% of 200k'");

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

if (!(await waitFor("file tree", () => bodyText().includes("README.md")))) process.exit(1);
console.log("deep render ok: file tree present");

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

{
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
  const inner = w.document.querySelector(".feed .toolbody.shiki pre.shiki") as HTMLElement | null;
  if (inner && (inner.style.backgroundColor || inner.getAttribute("style")?.includes("background-color"))) {
    console.error("#shiki REGRESSION: shiki's own background is on the inner pre — it must be layout only");
    process.exit(1);
  }
  console.log(`deep render ok: tool cards are shiki-highlighted (${tokens.length} token spans) (#shiki)`);
}

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

    if (css(line, "display") === "flex")
      fail(`.goalline must not be display:flex — that is the same-row bug (#51)`);
    if (line.classList.contains("divider-msg"))
      fail(`the audit row still uses the flex .divider-msg container (#51)`);
    if (css(label, "display") === "flex" || css(label, "display") === "inline-flex")
      fail(`the label must be its own block so the card drops beneath it (#51)`);

    const card = line.querySelector(".card");
    if (card) {
      if (card.parentElement === line && label.parentElement === line) {
        const parentDisplay = css(line, "display");
        if (parentDisplay.includes("flex"))
          fail(`label and card are flex siblings of ${line.className} (#51)`);
      }
      if (/margin-left|transform/.test(css(card, "margin-left") + css(card, "transform")))
        fail(`the audit card must not be offset from the feed's left edge (#51)`);
    }
  }

  const approvedLine = lines.find((l) => /audit: approved/.test(text(l)));
  if (!approvedLine) fail("the approved audit row is missing (#51)");
  if (approvedLine.querySelector(".card"))
    fail(
      `a verdict with no reason must render the label ALONE, not a card (#51): ${text(approvedLine).slice(0, 60)}`,
    );
  if (/no detail/i.test(text(approvedLine)))
    fail(`the literal "no detail" placeholder must never reach the UI (#51)`);

  const rejectedLine = lines.find((l) => /changes required/.test(text(l)));
  if (!rejectedLine?.querySelector(".card")) fail("a real audit finding must still render its card (#51)");
  if (!/CRLF/.test(text(rejectedLine)))
    fail(`the auditor's reason must be visible (#51): ${text(rejectedLine).slice(0, 60)}`);

  console.log("deep render ok: audit rows stack and a reasonless verdict shows no card (#51)");
}

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
  const freeInput = w.document.querySelector(".qfree input");
  if (freeInput && !freeInput.disabled)
    fail("the free-text answer must disable with the options (#55)");

  console.log("deep render ok: an answered ask_user disables its options at once (#55)");

  {
    const sock = MockWS.instances.at(-1);
    if (!sock) {
      console.error("smoke: no app socket — the bundle never opened one");
      process.exit(1);
    }
    sock.onmessage?.({
      data: JSON.stringify({
        kind: "agent-update",
        agentId: AGENT.id,
        snapshot: { ...AGENT, status: "running" },
      }),
    });
    await new Promise((r) => setTimeout(r, 150));
    sock.onmessage?.({
      data: JSON.stringify({
        kind: "llm-delta",
        agentId: AGENT.id,
        sessionId: "alpha",
        text: "",
        reasoning: "weighing the options",
      }),
    });
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
    sock.onmessage({
      data: JSON.stringify({
        kind: "agent-update",
        agentId: AGENT.id,
        snapshot: { ...AGENT, status: "running" },
      }),
    });
    await new Promise((r) => setTimeout(r, 60));
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

{
  const LIVE_AGENT = { ...AGENT, status: "running", pendingPrompts: 1 };
  const TOOL_TS = new Date(Date.now() + 5000).toISOString();
  const LIVE_EVENTS = [
    ...EVENTS,
    {
      id: "live-tool-1",
      seq: 702,
      ts: TOOL_TS,
      agent: AGENT.id,
      session: "alpha-s1",
      branch: "br0",
      parent: null,
      type: "tool_call",
      data: { callId: "c-live", name: "bash", args: { command: "ls" } },
    },
    {
      id: "live-tool-1-result",
      seq: 703,
      ts: TOOL_TS,
      agent: AGENT.id,
      session: "alpha-s1",
      branch: "br0",
      parent: "live-tool-1",
      type: "tool_result",
      data: { callId: "c-live", name: "bash", ok: true, durationMs: 5, result: "a.txt" },
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
  if (!w.document.querySelector(".msg.live")) {
    console.error(
      "reasoning→tool check could not create a LIVE row (status/session gate) — the assertion " +
        "after the tool call would pass vacuously",
    );
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 500));
  const statusText = w.document.querySelector(".chan-head")?.textContent ?? "";
  if (!statusText.includes("running") && w.document.body.textContent.includes("▶ start")) {
    console.error(
      "reasoning→tool check: the agent is IDLE, so the status sweep — not this rule — would " +
        "clear the row. The check would pass vacuously.",
    );
    process.exit(1);
  }
  const liveRow = w.document.querySelector(".msg.live");
  const liveStillThinking = !!liveRow?.querySelector("details.reasoning");
  if (process.env.SMOKE_DEBUG_LIVE) {
    console.error(
      "DEBUG live row=" + (liveRow ? JSON.stringify(liveRow.textContent.slice(0, 120)) : "NONE") +
      " reasoningBlock=" + liveStillThinking,
    );
    console.error("DEBUG events in feed=" + w.document.querySelectorAll("[data-eid]").length);
  }
  if (liveRow && liveStillThinking) {
    console.error(
      "reasoning→tool REGRESSION: the LIVE bubble still renders a 💭 block after a tool call " +
        "started while the turn is running — stale reasoning must be retired from the live row",
    );
    process.exit(1);
  }
  console.log("reasoning followed by a tool call leaves no stale 💭 block");
  if (baseFetch) setGlobal("fetch", baseFetch);
}

{
  const fail = (msg) => { console.error(`#reasoning REGRESSION: ${msg}`); process.exit(1); };
  const sock = MockWS.instances.at(-1);
  if (!sock?.onmessage) {
    fail("no app socket to drive");
    throw new Error("unreachable");
  }
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
        reasoning: "\n  \n",
      }),
    });
  }
  await new Promise((r) => setTimeout(r, 260));

  const bubble = w.document.querySelector(".msg.live");
  if (!bubble) fail("no live bubble — the check would pass vacuously");
  const details = bubble.querySelector("details.reasoning");
  if (details) {
    fail("a whitespace-only reasoning delta drew an empty 💭 block");
  }
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

{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (msg) => { console.error(`#58 REGRESSION: ${msg}`); process.exit(1); };

  const want = "alpha-s9";
  history.replaceState(null, "", `/session/${want}`);
  requestedUrls.length = 0;
  history.replaceState(null, "", `/session/${want}`);
  w.dispatchEvent(new w.PopStateEvent("popstate", { bubbles: true }));
  await sleep(400);

  const eventFetches = requestedUrls.filter((u) => /\/events/.test(u));
  if (!eventFetches.length) fail("no events request was made for the deep-linked session (#58)");
  if (!eventFetches.some((u) => u.includes(`session=${want}`)))
    fail(
      `the deep link to ${want} never reached the events fetch: ${JSON.stringify(eventFetches)} (#58)`,
    );
  if (!location.pathname.includes(want))
    fail(`the URL was rewritten away from ${want} to ${location.pathname} (#58)`);
  console.log("deep render ok: a deep link opens the session it names (#58)");
  history.replaceState(null, "", `/session/${BOOT_SESSION}`);
  w.dispatchEvent(new w.PopStateEvent("popstate", { bubbles: true }));
  await sleep(400);
}

{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (msg) => { console.error(`#52 REGRESSION: ${msg}`); process.exit(1); };

  const copied: string[] = [];
  let execCommandCalls = 0;
  const realExec = w.document.execCommand;
  w.document.execCommand = (cmd) => {
    if (cmd === "copy") {
      execCommandCalls++;
      const ta = w.document.querySelector("textarea[style*='fixed']");
      if (ta) copied.push(ta.value);
    }
    return true;
  };
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
  btn.click(); 
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

  const glyph = () => btn.textContent.trim();
  if (!["✓", "⧉", "✗"].includes(glyph()))
    fail(`the Copy button shows unexpected state ${JSON.stringify(glyph())} (#52)`);
  const afterClick = glyph();
  if (afterClick === "✓") {
    await sleep(1200);
    if (glyph() === "✓")
      fail("the copied state must revert, or the button lies about later copies (#52)");
  }

  try { w.document.execCommand = realExec; } catch {}
  if (hadClipboard === "undefined") {
    try { delete w.navigator.clipboard; } catch {}
  }
  console.log("deep render ok: a Copy button actually copies (#52)");
}

{
  const RUNNING_AGENT = { ...AGENT, status: "running", pendingPrompts: 1 };
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

  const appWs = MockWS.instances.at(-1);
  if (!appWs?.onmessage) { console.error("MOCK WS missing"); process.exit(1); }
  if (!appWs.onmessage) {
    console.error("[dbg] appWs has NO onmessage handler!");
    process.exit(1);
  }
  const appOnMessage = appWs.onmessage.bind(appWs);
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
        event: { agent: AGENT.id, ...event }, 
      }),
    });
  const last = PENDING_EVENTS.at(-1);
  if (!last) throw new Error("PENDING_EVENTS must not be empty");
  pushEvent(last);
  const flushRefreshes = () =>
    w.document.dispatchEvent(new w.Event("visibilitychange"));
  flushRefreshes();
  await waitFor("feed has e5", () => {
    return true;
  });

  const ta = w.document.querySelector(".composer textarea");
  if (!ta) { console.error("composer textarea not found"); process.exit(1); }
  ta.value = "queued while running";
  ta.dispatchEvent(new w.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const form = ta.closest("form");
  form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor("echo appears once", () => bodyText().split("queued while running").length - 1 === 1);
  await new Promise((r) => setTimeout(r, 150)); 

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

  {
    const feed = w.document.querySelector(".feed") as HTMLElement | null;
    if (!feed) {
      console.error("#send-scroll check: .feed missing");
      process.exit(1);
    }
    let CONTENT = 5000; 
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
    top = 1200;
    feed.dispatchEvent(new w.Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const before = top;

    ta.value = "another";
    ta.dispatchEvent(new w.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
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

    top = CONTENT - viewport; 
    feed.dispatchEvent(new w.Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));

    ta.value = "following";
    ta.dispatchEvent(new w.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    viewport += 20;
    pumpResize();
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

    top = CONTENT - viewport;
    feed.dispatchEvent(new w.Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    top = CONTENT - viewport - 400;
    feed.dispatchEvent(new w.Event("scroll", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    for (let step = 0; step < 3; step++) {
      const beforeWheel = top;
      top = Math.max(0, top - 200);
      CONTENT += 150; 
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
    pushEvent({
      id: "e40", seq: 40, ts: "2026-01-01T10:01:00Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "message",
      data: { role: "assistant", content: "tool-call reply body" },
    });
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
    if (!two.head.includes("GROUPED_TWO")) {
      console.error(`#75: a grouped row must keep its command, got ${JSON.stringify(two.head)}`);
      process.exit(1);
    }
    console.log("deep render ok: consecutive tool rows group under one head (#75)");

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

      const gaps: { label: string; px: number }[] = [];
      for (let i = 0; i < feedRows.length - 1; i++) {
        const a = feedRows[i];
        const b = feedRows[i + 1];
        const ae = a.querySelector(".embed");
        const be = b.querySelector(".embed");
        if (!ae || !be) continue;
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
      const ordinary = feedRows.find((r) => !r.classList.contains("grouped"));
      const ordAv = ordinary?.querySelector(".avatar");
      if (!ordAv || parseFloat(cssOf(ordAv).height) <= 0) {
        console.error(
          "#grouped REGRESSION: an ordinary row's avatar collapsed — a 0px avatar belongs only " +
            "to continuations, which carry no icon",
        );
        process.exit(1);
      }
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

  {
    const _sockB = MockWS.instances.at(-1);
    pushEvent({ id: "gb0", seq: 601, ts: "2026-01-01T16:00:00Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "message", data: { role: "assistant", content: "boundary before the run" } });
    pushEvent({ id: "gb1", seq: 602, ts: "2026-01-01T16:00:01Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_call", data: { callId: "cb1", name: "bash", args: { command: "INVIS_ONE" } } });
    pushEvent({ id: "gb2", seq: 603, ts: "2026-01-01T16:00:02Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_result", data: { callId: "cb1", name: "bash", result: "o", ok: true, durationMs: 3 } });
    pushEvent({ id: "gb3", seq: 604, ts: "2026-01-01T16:00:03Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "state", data: { from: "running", to: "running", detail: "llm turn start", turn: 91 } });
    pushEvent({ id: "gb4", seq: 605, ts: "2026-01-01T16:00:04Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "message", data: { role: "assistant", content: "", toolCalls: [{ id: "x", name: "bash" }] } });
    pushEvent({ id: "gb5", seq: 606, ts: "2026-01-01T16:00:05Z", session: "alpha-s1", branch: "br0",
      parent: null, type: "tool_call", data: { callId: "cb2", name: "bash", args: { command: "INVIS_TWO" } } });
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
    const toggle = () => w.document.querySelector(".chan-head .runbtn");
    const readsStop = (b: Element | null) => !!b && b.classList.contains("danger");

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

  {
    const header = w.document.querySelector(".chan-head");
    if (!header) {
      console.error("#panel check: no .chan-head to inspect");
      process.exit(1);
    }
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
    if (!header.querySelector(".runbtn")) {
      console.error("#panel REGRESSION: the start/stop toggle is not in the channel header");
      process.exit(1);
    }
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
    const removeBtn = [...w.document.querySelectorAll(".cfgkeyrow button")].find((b) => /remove this key/.test(b.getAttribute("title") ?? ""));
    if (!removeBtn) {
      console.error(`#170 REGRESSION: an added key cannot be removed`);
      process.exit(1);
    }
    console.log("deep render ok: a provider can hold several API keys (#170)");
    const modalClose = [...w.document.querySelectorAll(".modal-head .iconbtn")].at(-1);
    modalClose?.click();
    await new Promise((r) => setTimeout(r, 300));
    if (w.document.querySelector(".modal")) {
      console.error("#170 check did not close the config dialog; later checks would inherit it");
      process.exit(1);
    }
  }

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
    if (/\bgrouped\b/.test(bash.cls)) {
      console.error(
        `SEPARATION REGRESSION: the bash after a write_file was grouped into its run` +
          `\n  write_file: ${JSON.stringify(wrote.head)} cls=${wrote.cls}` +
          `\n  bash      : ${JSON.stringify(bash.head)} cls=${bash.cls}`,
      );
      process.exit(1);
    }
    if (/\bgrouped\b/.test(wrote.cls)) {
      console.error(`SEPARATION REGRESSION: the write_file row was itself marked grouped: ${wrote.cls}`);
      process.exit(1);
    }
    console.log("deep render ok: a different tool starts its own block, not a grouped row");
  }

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
      const hint = w.document.querySelector(".composerwrap .hint, .hint");
      if (hint && /enter send ·/i.test(hint.textContent ?? "")) {
        console.error("#help REGRESSION: the keyboard cheat-sheet is still printed under the composer");
        process.exit(1);
      }
      const appearance = menu.find((b) => /appearance/i.test(b.textContent ?? ""));
      appearance?.click();
      await new Promise((r) => setTimeout(r, 250));
      console.log("deep render ok: help section carries the keyboard + toggle explanations (#help)");
    }

    {
      const bgFail = (msg: string) => {
        console.error(`#bgimage REGRESSION: ${msg}`);
        process.exit(1);
      };
      const modal = w.document.querySelector(".modal");
      if (!modal) bgFail("the settings dialog is closed — cannot check the image control");

      const apprBtn = [...modal!.querySelectorAll("button")].find((b) =>
        /appearance/i.test(b.textContent ?? ""),
      );
      if (!apprBtn) bgFail("no appearance section in the settings rail");
      apprBtn!.click();
      await new Promise((r) => setTimeout(r, 250));

      const dup = () =>
        [...w.document.querySelectorAll(".themeeditor button")].find((b) =>
          /duplicate current/i.test(b.textContent ?? ""),
        );
      if (!dup()) bgFail("no way to create a custom theme — the editor cannot be reached");
      let bubbled = 0;
      w.document.addEventListener("click", () => { bubbled++; });
      dup()!.click();
      await new Promise((r) => setTimeout(r, 300));
      dup()!.click();
      await new Promise((r) => setTimeout(r, 400));

      if (!w.document.querySelector(".themeeditor .paletterow")) {
        bgFail("the theme editor did not render after creating a theme — nothing to check");
      }

      const visibleFile = [...modal!.querySelectorAll('input[type="file"]')].find((i) => {
        const cs = w.document.defaultView.getComputedStyle(i);
        return cs.display !== "none";
      });
      if (visibleFile) {
        bgFail('a native file input is still visible — its label always says "no file chosen"');
      }

      const pick = w.document.querySelector(".themeeditor button.bgpick") as HTMLButtonElement | null;
      if (!pick) bgFail("no `.bgpick` control — the theme's image slot must be the thing you click");
      const fileInput = w.document.querySelector(
        '.themeeditor input[type="file"][accept="image/*"]',
      ) as HTMLInputElement | null;
      if (!fileInput) bgFail("no image file input at all");
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
        const inEditor = !!w.document.querySelector(".themeeditor input[type=file]");
        bgFail(
          `clicking the image slot did not open the file picker (pick=${pick!.tagName}.${pick!.className}` +
            ` inputInEditor=${inEditor} inputConnected=${fileInput!.isConnected} btnClicks=${btnClicks})`,
        );
      }

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

      const html = w.document.documentElement;
      const activeId = html.dataset.theme ?? "";
      if (!/^custom-/.test(activeId)) {
        bgFail(
          `after creating a theme the active theme is ${JSON.stringify(activeId)}, not the new ` +
            `custom one — edits cannot be visible because applyCustomTheme only paints the ACTIVE theme`,
        );
      }
      const painted = html.style.getPropertyValue("--bg-dark") || html.style.getPropertyValue("--fg");
      if (!painted) {
        bgFail("the active custom theme painted no palette variables — the document is unchanged");
      }
      console.log("deep render ok: creating a theme ADOPTS it, so edits are visible (#bgimage)");
    }

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
        return !bg || bg === "transparent" || /rgba\(0, 0, 0, 0\)/.test(bg);
      });
      if (noColour.length > 0) {
        const names = noColour.map((c) => c.textContent?.trim().slice(0, 20)).slice(0, 4);
        appearanceFail(
          `${noColour.length} of ${cards.length} theme cards paint NO background ` +
            `(e.g. ${JSON.stringify(names)}) — the miniature collapsed and only its dots show`,
        );
      }
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
      if (!/auto|scroll/.test(panelCs.overflowY)) {
        console.error(
          `#settings REGRESSION: the panel does not scroll on its own (overflow-y=${panelCs.overflowY}) — SAVE would scroll away with the form`,
        );
        process.exit(1);
      }
      const legendCs = cssOf(".cfgpanel legend");
      if (legendCs && legendCs.display !== "none") {
        console.error(
          `#settings REGRESSION: the section legend is visible again (display=${legendCs.display}) — it duplicates the rail label`,
        );
        process.exit(1);
      }
    }
    console.log("deep render ok: settings is a left rail with a pinned footer");

    {
      const railBtns = [...w.document.querySelectorAll(".cfgmenu-item")];
      const archBtn = railBtns.find((b) => /archive/.test(b.textContent ?? ""));
      if (!archBtn) {
        console.error("#archive REGRESSION: no 🗄 archive entry in the settings rail");
        process.exit(1);
      }
      archBtn.click();
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

    {
      const railBtns = [...w.document.querySelectorAll(".cfgmenu-item")];
      const mcpBtn = railBtns.find((b) => /MCP/.test(b.textContent ?? ""));
      if (!mcpBtn) {
        console.error("#mcp REGRESSION: no MCP entry in the settings rail");
        process.exit(1);
      }
      mcpBtn.click();
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
      const urlInput = card.querySelector('input[placeholder^="https://example.com"]') as HTMLInputElement | null;
      if (!urlInput) {
        console.error("#mcp REGRESSION: the server's url field is missing");
        process.exit(1);
      }
      if (urlInput.value !== "https://mcp.example/mcp") {
        console.error(`#mcp REGRESSION: the url field shows ${JSON.stringify(urlInput.value)}`);
        process.exit(1);
      }
      const sel = card.querySelector("select");
      if (!sel || sel.value !== "http") {
        console.error(`#mcp REGRESSION: transport selector shows ${JSON.stringify(sel?.value)}`);
        process.exit(1);
      }
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
      const testBtn = [...card.querySelectorAll("button")].find((b) => /test/.test(b.textContent ?? ""));
      if (!testBtn) {
        console.error("#mcp REGRESSION: no test button — a bad server can only be found by saving");
        process.exit(1);
      }
    }
    console.log("deep render ok: MCP panel shows server, transport and live tool count");

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

    {
      const saveBtn = w.document.querySelector(".cfgsave");
      if (!saveBtn) {
        console.error("#oauth-save: no save button");
        process.exit(1);
      }
      const before = requests.filter((r) => r.url === "/api/mcp/oauth/status").length;
      saveBtn.click();
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
      const labelText = String(toggle.closest(".cfgtoggle")?.textContent ?? "");
      if (!/short-context/.test(labelText)) {
        console.error(`#161 REGRESSION: the toggle is unlabelled: ${JSON.stringify(labelText)}`);
        process.exit(1);
      }
      if (toggle.checked) {
        console.error("#161 REGRESSION: short-context mode is ON by default — it is opt-in");
        process.exit(1);
      }
      toggle.checked = true;
      toggle.dispatchEvent(new w.Event("change"));
      await new Promise((r) => setTimeout(r, 40));
      const saveBtn = w.document.querySelector(".cfgsave");
      if (!saveBtn) {
        console.error("#161 REGRESSION: no save button to commit the toggle");
        process.exit(1);
      }
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

    [...w.document.querySelectorAll(".modal-head .iconbtn")].at(-1)?.click();
    await new Promise((r) => setTimeout(r, 300));
    if (w.document.querySelector(".modal")) {
      console.error("#settings check did not close the dialog; later checks would inherit it");
      process.exit(1);
    }
  }

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
    const feed = w.document.querySelector(".feed");
    if (!feed) {
      console.error("#160 check: .feed not found");
      process.exit(1);
    }
    const filler = w.document.createElement("div");
    filler.style.height = "4000px";
    feed.appendChild(filler);
    await new Promise((r) => setTimeout(r, 40));
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
    const before = rowsNow();
    const beforeIds = before.map((r) => r.dataset.eid ?? "");
    if (before.length < 2) {
      console.error(`#rerender check: only ${before.length} row(s) — cannot tell a remount from a no-op`);
      process.exit(1);
    }

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

    const scrollable = [...w.document.querySelectorAll(".feed .embed .mono, .feed .toolbody")]
      .find((el) => (el as HTMLElement).scrollHeight > 0 || el.textContent.length > 0);
    if (!scrollable) {
      console.error(
        "#rerender check: no tool body in the feed — the inner-scroll half would be vacuous",
      );
      process.exit(1);
    }
    const scroller = scrollable as HTMLElement;
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

{
  const feed = w.document.querySelector(".feed") as HTMLElement | null;
  const ta = w.document.querySelector(".composer textarea") as HTMLTextAreaElement | null;
  if (!feed || !ta) {
    console.error("#scroll check: .feed or the composer textarea is missing");
    process.exit(1);
  }
  const CONTENT = 4000;
  let viewport = 800;
  Object.defineProperty(feed, "scrollHeight", { configurable: true, get: () => CONTENT });
  Object.defineProperty(feed, "clientHeight", { configurable: true, get: () => viewport });
  let scrollTop = 0;
  Object.defineProperty(feed, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = Math.max(0, Math.min(v, Math.max(0, CONTENT - viewport)));
    },
  });
  const LINE = 20;
  const lines = () => Math.max(1, ta.value.split("\n").length);
  Object.defineProperty(ta, "scrollHeight", {
    configurable: true,
    get: () => lines() * LINE,
  });
  scrollTop = CONTENT - viewport;
  feed.dispatchEvent(new w.Event("scroll", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  const atTailBefore = CONTENT - scrollTop - viewport;
  if (atTailBefore > 1) {
    console.error(`#scroll check: could not place the reader at the tail (gap ${atTailBefore}) — vacuous`);
    process.exit(1);
  }

  const growComposer = (value: string, byPx: number) => {
    ta.value = value;
    ta.dispatchEvent(new w.Event("input", { bubbles: true }));
    viewport -= byPx;
    Object.defineProperty(feed, "offsetHeight", { configurable: true, get: () => viewport });
    pumpResize();
  };

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
  if (viewport !== 760) {
    console.error(`#scroll check: the viewport did not shrink as expected (${viewport}) — vacuous`);
    process.exit(1);
  }

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

    const back = [...w.document.querySelectorAll(".agent-item")].find((el) =>
      /\balpha\b/.test(el.textContent ?? ""),
    ) as HTMLElement | undefined;
    back?.click();
    await new Promise((r) => setTimeout(r, 250));
  }
}

{
  const editor = w.document.getElementById("todo-input");
  if (!editor) {
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

  const box0 = w.document.getElementById("todo-input");
  box0.value = "- first pass";
  box0.dispatchEvent(new w.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  const saveBtn = [...w.document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("save tasks"),
  );
  if (!saveBtn) { console.error("#30: no 'save tasks' button"); process.exit(1); }
  saveBtn.click();
  await new Promise((r) => setTimeout(r, 120));

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

  {
    const edit = w.document.getElementById("todo-input");
    if (!edit) {
      console.error("#todo-height: the editor is gone — the check would be vacuous");
      process.exit(1);
    }
    edit.style.height = "260px";
    pumpResize();
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

{
  const headers = [...w.document.querySelectorAll(".wsheader")].map((h) => h.textContent.trim());
  const items = w.document.querySelectorAll(".agent-item").length;
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
  const headerFor = (ws) => headers().find((h) => h.getAttribute("title")?.startsWith(ws));
  const target = headerFor(AGENT.workspace);
  if (!target) fail(`no header for ${AGENT.workspace}: ${headers().map((h) => h.getAttribute("title"))}`);
  const wasCollapsed = /▸/.test(target.querySelector(".wscaret")?.textContent ?? "");

  target.click();
  await sleep(120);
  const after = itemIds();
  const caret = headerFor(AGENT.workspace)?.querySelector(".wscaret")?.textContent ?? "";

  if (caret === (wasCollapsed ? "▸" : "▾"))
    fail(
      `the caret did not flip — still "${caret}" after clicking a ${wasCollapsed ? "collapsed" : "open"} group`,
    );
  if (after.length === before.length)
    fail(
      `clicking a workspace header must hide its chats — still ${after.length} rows (${JSON.stringify(after)})`,
    );
  if (after.includes("alpha")) fail(`alpha stayed visible after collapsing its group: ${JSON.stringify(after)}`);
  if (!after.includes("beta")) fail(`beta belongs to another group and must stay: ${JSON.stringify(after)}`);
  if (headers().length !== 2)
    fail(`a collapsed group must keep its header so it can be reopened, got ${headers().length}`);

  headerFor(AGENT.workspace)?.click();
  await sleep(120);
  const restored = itemIds();
  if (restored.length !== 2)
    fail(`reopening must restore every chat, got ${JSON.stringify(restored)}`);
  console.log("deep render ok: a workspace group really collapses and reopens (#18)");
}

{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (msg) => { console.error(`#18 REGRESSION: ${msg}`); process.exit(1); };
  const origFetch = globalThis.fetch;
  const THIRD = { ...AGENT, id: "gamma", workspace: AGENT.workspace }; 
  const GAMMA_SUB = { ...AGENT, id: "gamma-sub", parent: "gamma", workspace: AGENT.workspace };
  const DELTA = { ...AGENT, id: "delta", workspace: "/tmp/ws" };
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
  const sock = MockWS.instances.at(-1);
  sock?.onmessage?.({
    data: JSON.stringify({ kind: "agent-update", agentId: THIRD.id, snapshot: THIRD }),
  });
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

  const wsTitles = [...w.document.querySelectorAll(".wsheader")].map((h) => h.getAttribute("title") ?? "");
  const sharedRuns = wsTitles.filter((t) => t.startsWith(AGENT.workspace)).length;
  if (sharedRuns < 1) fail(`the shared directory lost its header entirely: ${JSON.stringify(wsTitles)}`);
  for (let i = 1; i < wsTitles.length; i++) {
    if (wsTitles[i] === wsTitles[i - 1])
      fail(`consecutive identical workspace headers: ${JSON.stringify(wsTitles)}`);
  }

  const rowText = (el) =>
    el.textContent.replace(/[▾▸🔔🧩✓]/g, "").replace(/\d+/g, "").trim();
  const rowFor = (id) =>
    [...w.document.querySelectorAll(".agent-item")].find((el) => {
      const parts = rowText(el).split(/\s+/);
      return parts.includes(id) || rowText(el) === id;
    });
  const caretIn = (el) => el?.querySelector(".caret");
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
  const alphaAfter = rowFor("gamma");
  if (!alphaAfter)
    fail(`a collapsed chat must keep its row so it can be reopened (#18)`);
  if (!alphaAfter.className.includes("collapsed"))
    fail(`a collapsed chat must be marked collapsed, got ${JSON.stringify(alphaAfter.className)}`);
  if (caretIn(alphaAfter)?.textContent.trim() !== "▸")
    fail(`a collapsed chat's caret must point closed, got ${JSON.stringify(caretIn(alphaAfter)?.textContent)}`);
  if (!afterOne.includes("alpha"))
    fail(`alpha shares a DIRECTORY but is a separate chat — it must stay visible, got ${JSON.stringify(afterOne)}`);
  if (afterOne.includes("gamma-sub"))
    fail(`a collapsed chat must hide its sub-agents (#106), got ${JSON.stringify(afterOne)}`);
  if (!afterOne.includes("beta"))
    fail(`beta is in another project entirely and must stay visible, got ${JSON.stringify(afterOne)}`);

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
  if (caretIn(rowFor("gamma"))?.textContent.trim() !== "▾")
    fail(`reopened gamma must point its caret open (#18/#106)`);

  if (!caretIn(rowFor("gamma")))
    fail("a childless top-level chat must still offer a collapse caret (#18)");

  headerFor(AGENT.workspace)?.click();
  await sleep(200);
  const afterWs = [...w.document.querySelectorAll(".agent-item")]
    .map((el) => el.textContent.match(/\b(alpha|beta|gamma)\b/)?.[1])
    .filter(Boolean);
  if (afterWs.includes("alpha") || afterWs.includes("gamma"))
    fail(`collapsing the directory must hide both of its chats, got ${JSON.stringify(afterWs)}`);
  headerFor(AGENT.workspace)?.click();
  await sleep(200);

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

{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (msg) => { console.error(`#18 REGRESSION: ${msg}`); process.exit(1); };
  const headers = () => [...w.document.querySelectorAll(".wsheader")];
  const headerFor = (ws) => headers().find((h) => h.getAttribute("title")?.startsWith(ws));

  const soloHeader = headerFor("/tmp/other-project");
  if (!soloHeader) fail("the single-chat project lost its header (#18)");
  if (soloHeader.querySelector(".wscount"))
    fail(`a single-chat project must not show a count badge: ${soloHeader.textContent}`);

  soloHeader.click(); 
  await sleep(150);
  const collapsedHeader = headerFor("/tmp/other-project");
  if (!collapsedHeader) fail("collapsing removed the header — no way to reopen (#18)");
  const badge = collapsedHeader.querySelector(".wscount");
  if (!badge) fail(`a collapsed group must still show how many chats it hides (#18): ${collapsedHeader.textContent}`);
  if (badge.textContent.trim() !== "1")
    fail(`a collapsed single-chat group should read 1, got ${JSON.stringify(badge.textContent)}`);
  if (!/collapsed/i.test(collapsedHeader.getAttribute("title") ?? ""))
    fail("a collapsed header's tooltip should say so (#18)");
  if (/1 chats/.test(collapsedHeader.getAttribute("title") ?? ""))
    fail(`a one-chat group must read "1 chat hidden", got ${JSON.stringify(collapsedHeader.getAttribute("title"))}`);
  if ([...w.document.querySelectorAll(".agent-item")].some((el) => /beta/.test(el.textContent)))
    fail("beta's chat should be hidden while its group is collapsed (#18)");

  collapsedHeader.click(); 
  await sleep(150);
  if (![...w.document.querySelectorAll(".agent-item")].some((el) => /beta/.test(el.textContent)))
    fail("reopening must bring beta's chat back (#18)");
  if (![...w.document.querySelectorAll(".agent-item")].some((el) => /alpha|gamma/.test(el.textContent)))
    fail("collapsing one project must not disturb the others (#18)");
  console.log("deep render ok: a collapsed group still reports what it hides (#18)");
}

{
  const sleepW = (ms) => new Promise((r) => setTimeout(r, ms));
  const failW = (msg) => { console.error(`#50 WIDE REGRESSION: ${msg}`); process.exit(1); };
  if (Number(process.env.SMOKE_WIDTH ?? 1440) > 1100) {
    const bar = () => w.document.querySelector(".rightbar");
    const toggle = [...w.document.querySelectorAll(".iconbtn")].find(
      (b) => /toggle details panel/.test(b.getAttribute("title") ?? ""),
    );
    if (!toggle) failW("no ▤ details-panel toggle found");
    if (!bar()?.classList.contains("open")) toggle.click(); 
    await sleepW(80);
    if (!bar()?.classList.contains("open")) failW("could not open the panel on a wide screen");
    if (w.document.querySelector(".rightbarbackdrop"))
      failW("a full-screen backdrop is mounted on a wide screen — it would swallow every click in the app");
    const head = w.document.querySelector(".rightbarhead");
    if (head && w.document.defaultView.getComputedStyle(head).display !== "none")
      failW("the drawer-only ✕ row is visible on a wide screen");
    toggle.click(); 
    await sleepW(80);
    if (bar()?.classList.contains("open")) failW("the ▤ toggle no longer closes the panel");
    if (w.document.querySelector(".rightbarbackdrop"))
      failW("backdrop mounted after closing on a wide screen");
    console.log("deep render ok: wide panel is an inline toggle, no drawer chrome (#50)");
  }
}

if (Number(process.env.SMOKE_WIDTH ?? 1440) <= 1100) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const drawer = () => w.document.querySelector(".rightbar");
  const drawerOpen = () => drawer()?.classList.contains("open") ?? false;
  const fail = (msg) => { console.error(`#50 REGRESSION: ${msg}`); process.exit(1); };

  const toggle = [...w.document.querySelectorAll(".iconbtn")].find(
    (b) => /toggle details panel/.test(b.getAttribute("title") ?? ""),
  );
  if (!toggle) fail("no ▤ details-panel toggle found");
  if (!drawerOpen()) toggle.click();
  await sleep(80);
  if (!drawerOpen()) fail("the ▤ toggle did not open the drawer at narrow width");

  const closeBtn = [...w.document.querySelectorAll(".rightbarhead .iconbtn")].find(
    (b) => /close details panel/.test(b.getAttribute("title") ?? ""),
  );
  if (!closeBtn) fail("no ✕ close button inside the drawer — the drawer covers its own opener");
  if (!drawer().contains(closeBtn))
    fail("the ✕ is not a descendant of .rightbar — it must travel with the panel (#50)");

  {
    const row = w.document.querySelector(".rightbarhead");
    const cs = w.document.defaultView.getComputedStyle(row);
    if (cs.display === "none" || cs.display === "hidden")
      fail(`the ✕ row is ${cs.display} at narrow width — the drawer has no visible way out (#50)`);
    if (cs.position !== "sticky")
      fail(`the ✕ row must be sticky (got position:${cs.position}) (#50)`);
  }

  {
    const filler = w.document.createElement("div");
    filler.style.height = "4000px";
    drawer().appendChild(filler);
    await sleep(30);
    const el = drawer();
    el.scrollTop = el.scrollHeight; 
    w.dispatchEvent(new w.Event("scroll", { bubbles: true }));
    await sleep(60);
    const head = w.document.querySelector(".rightbarhead");
    if (!head || !drawer().contains(head)) fail("the ✕ row left the panel after a scroll (#50)");
    const cs = w.document.defaultView.getComputedStyle(head);
    if (cs.position !== "sticky")
      fail(`the ✕ row must be sticky so scrolling cannot hide it (got position:${cs.position}) (#50)`);
    const btn = head.querySelector(".iconbtn");
    if (!btn) fail("the ✕ button vanished from the row after scrolling (#50)");
    btn.click();
    await sleep(80);
    if (drawerOpen()) fail("the ✕ did not close the drawer after scrolling to the bottom");
    filler.remove();
    await sleep(20);
  }

  toggle.click();
  await sleep(80);
  if (!drawerOpen()) fail("re-opening the drawer failed");
  const backdrop = w.document.querySelector(".rightbarbackdrop");
  if (!backdrop) fail("no click-outside backdrop while the drawer is open");
  backdrop.click();
  await sleep(80);
  if (drawerOpen()) fail("clicking outside did not dismiss the drawer");
  if (w.document.querySelector(".rightbarbackdrop"))
    fail("backdrop still mounted after close — it would swallow every click in the app");

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

  if (w.document.querySelector(".rightbarbackdrop")) fail("backdrop left mounted");

  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(120);
  if (!stopCalls.length)
    fail("Escape no longer stops the running agent once the drawer is closed — the panel shadowed it forever");
  console.log("deep render ok: Escape still interrupts a running agent when no drawer is open (#50)");

  {
    const cs = (sel, prop) => {
      const el = w.document.querySelector(sel);
      return el ? w.document.defaultView.getComputedStyle(el).getPropertyValue(prop) : null;
    };
    const isNone = (v) => !v || v === "none" || v === "0px" || v === "";

    const shadowClosed = cs(".rightbar", "box-shadow");
    if (!isNone(shadowClosed))
      fail(`a CLOSED drawer must not paint a box-shadow, got ${JSON.stringify(shadowClosed)} (#53)`);
    if (cs(".rightbar", "visibility") === "visible" && !isNone(cs(".rightbar", "opacity")))
      fail(`a closed drawer must not be painted, opacity=${cs(".rightbar", "opacity")} (#53)`);

    const bd = w.document.querySelector(".rightbarbackdrop");
    if (bd) {
      const disp = w.document.defaultView.getComputedStyle(bd).display;
      const op = w.document.defaultView.getComputedStyle(bd).opacity;
      if (disp !== "none" && op !== "0" && Number(op) !== 0)
        fail(`a closed drawer must not leave a click-catching backdrop (display=${disp}, opacity=${op}) (#53)`);
    }

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

if (Number(process.env.SMOKE_WIDTH ?? 1440) > 1100) {
  const sleepR = (ms) => new Promise((r) => setTimeout(r, ms));
  const failR = (msg) => { console.error(`#50 RESIZE REGRESSION: ${msg}`); process.exit(1); };
  const barOpen = () => w.document.querySelector(".rightbar")?.classList.contains("open") ?? false;
  const detailToggle = () =>
    [...w.document.querySelectorAll(".iconbtn")].find(
      (b) => /toggle details panel/.test(b.getAttribute("title") ?? ""),
    );

  if (!barOpen()) detailToggle().click();
  await sleepR(80);
  if (!barOpen()) failR("panel not open at wide load");
  if (w.document.querySelector(".rightbarbackdrop")) failR("backdrop present on a wide screen");

  viewportWidth = 900;
  w.dispatchEvent(new w.Event("resize"));
  await sleepR(120);
  if (!barOpen()) failR("narrowing the window closed the panel outright");

  const closeBtn = [...w.document.querySelectorAll(".rightbarhead .iconbtn")].find(
    (b) => /close details panel/.test(b.getAttribute("title") ?? ""),
  );
  if (!closeBtn) failR("no ✕ after narrowing — the drawer covers its own opener");

  if (!w.document.querySelector(".rightbarbackdrop"))
    failR("narrowing the window mounted no click-outside backdrop (isNarrow is not reactive)");
  console.log("deep render ok: narrowing the window arms the drawer's close paths (#50)");

  closeBtn.click(); await sleepR(80);
  if (barOpen()) failR("✕ did not close the drawer after a resize");
  detailToggle().click(); await sleepR(80);
  if (!barOpen()) failR("could not re-open after a resize");
  w.document.querySelector(".rightbarbackdrop").click(); await sleepR(80);
  if (barOpen()) failR("click-outside did not dismiss after a resize");

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
  {
    const feedText63 = w.document.querySelector(".feed")?.textContent ?? "";
    if (feedText63.includes("child.txt"))
      failR(`a child's tool output must not appear in the parent's feed (#63)`);
    if (!feedText63.includes("CHILD REPORT TEXT"))
      failR(`the child's report must still reach the parent (#63), got: ${JSON.stringify(feedText63.slice(0, 300))}`);
    if (!/harness/i.test(feedText63))
      failR(`the report must be attributed to the harness, not the child (#63)`);
    const chips63 = [...w.document.querySelectorAll(".actor")].map((el) => el.textContent.trim());
    if (chips63.some((t) => t.includes("alpha-kid")))
      failR(`the parent must carry no child attribution (#63), got ${JSON.stringify(chips63)}`);
  }
  console.log("deep render ok: the parent's feed shows only its own work (#63)");

  console.log("deep render ok: widening back disarms the drawer without breaking the column (#50)");
}

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
  const feed = w.document.querySelector(".feed");
  if (!feed || !feed.contains(banner)) {
    console.error(
      "#108 REGRESSION: the compaction banner is outside .feed, so a pass cannot change " +
        "the scroll height — follow mode can no longer detach on it",
    );
    process.exit(1);
  }
  if (!/summarizing/.test(banner.textContent ?? "")) {
    console.error(`#108: the banner does not name the phase: ${JSON.stringify(banner.textContent)}`);
    process.exit(1);
  }
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

/**
 * A tool that returned an image must RENDER it.
 *
 * MEASURED on v0.37.73: the bytes were stored and the log referenced them, but `blobs/<hash>` went
 * straight into `<img src>` (resolved against `/session/…` → 404), and before that tool results drew
 * no `<img>` at all — so the agent could see the picture and the operator could not. Both failures were
 * invisible to a test that only read the log, which is why this checks the DOM.
 */
{
  const img = w.document.querySelector("img.promptimg[alt='tool image']");
  if (!img) {
    console.error("#blobs REGRESSION: a tool result with an image rendered no <img> — the operator cannot see it");
    process.exit(1);
  }
  const src = img.getAttribute("src") ?? "";
  const want = "blobs/3220fc7838ccdab0a3a21b5d8498275c7abe6930abbb059e9fdb4939bba8c2fd.jpg";
  if (src === want) {
    console.error(`#blobs REGRESSION: src is the STORED reference (${src}), which the browser resolves to a 404`);
    process.exit(1);
  }
  if (!src.startsWith(`/api/agents/${AGENT.id}/blobs/`)) {
    console.error(`#blobs REGRESSION: src is not the agent blob route: ${src}`);
    process.exit(1);
  }
  console.log("a tool image renders through the agent blob route (#blobs)");
}

await new Promise((r) => setTimeout(r, 120));
console.log(`first render survived (${fetchCount} api calls served)`);
process.exit(0);