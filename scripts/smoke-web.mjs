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
  if (u === "/api/agents") return { agents: [AGENT] };
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

const w = new Window({ url: "http://localhost:7788/session/test" });
// widen the viewport so the details panel is open by default (the crash site)
Object.defineProperty(w, "innerWidth", { value: 1440 });
w.document.body.innerHTML = `<div id="root"></div>`;
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
// used 123456 / window 200000 → exactly "62% of 200k"
if (!(await waitFor("runtime gauge", () => bodyText().includes("62% of 200k")))) process.exit(1);
console.log("deep render ok: context gauge shows '62% of 200k'");

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

// give deferred Solid effects a final tick before declaring victory
await new Promise((r) => setTimeout(r, 120));
console.log(`first render survived (${fetchCount} api calls served)`);
process.exit(0);
