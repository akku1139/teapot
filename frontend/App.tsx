import { createSignal, onMount, onCleanup, For, Show, createMemo, createEffect } from "solid-js";
import { renderMarkdown } from "./md";
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

/* ---------- types ---------- */
interface Agent {
  id: string; status: string; statusReason: string; workspace: string;
  session: string; branch: string; goal: { status: string; text: string };
  latestProgress: any; stats: any; model: string; provider?: string;
  pendingPrompts?: number;
  todo?: string;
  parent?: string;
  autoContinue?: boolean;
  ctx?: { usedTokens: number; compactAt: number; window: number };
}
interface Ev {
  id: string; seq: number; ts: string; session: string; branch: string;
  type: string; parent: string | null; data: any;
}

const AUTHORS: Record<string, { name: string; icon: string; color: string }> = {
  prompt: { name: "you", icon: "🟧", color: "#faa81a" },
  user: { name: "you", icon: "🟧", color: "#faa81a" },
  message: { name: "agent", icon: "🫖", color: "#5865f2" },
  progress: { name: "progress", icon: "📈", color: "#3ba55d" },
  question: { name: "agent", icon: "❓", color: "#5865f2" }, // ask_user comes from the agent too
};
const HARNESS_AUTH = { name: "harness", icon: "📣", color: "#3ba55d" };

/* ---------- transient toast hint (module scope: also used by SwitchContent) ---------- */
const [flash, setFlash] = createSignal("");
let flashTimer: ReturnType<typeof setTimeout> | undefined;
const flashHint = (msg: string) => {
  setFlash(msg);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setFlash(""), 3200);
};

/* ---------- themes ---------- */
type ThemeMeta = {
  key: string;
  label: string;
  mode: "dark" | "light";
  /** three preview dots: page bg · raised surface · accent */
  sw: [string, string, string];
};
const THEMES: ThemeMeta[] = [
  { key: "dark", label: "Dark", mode: "dark", sw: ["#1a1c22", "#2b2e39", "#5865f2"] },
  { key: "midnight", label: "Midnight", mode: "dark", sw: ["#0d0f18", "#252a42", "#8b7cf7"] },
  { key: "tea", label: "Milk Tea", mode: "dark", sw: ["#241c16", "#493b2d", "#d98e32"] },
  { key: "coffee", label: "Coffee", mode: "dark", sw: ["#191410", "#403527", "#c68a4b"] },
  { key: "matcha", label: "Matcha", mode: "dark", sw: ["#1b2217", "#3c4a33", "#8db64e"] },
  { key: "matrix", label: "Matrix", mode: "dark", sw: ["#060a06", "#18301d", "#2fd558"] },
  { key: "sunset", label: "Sunset", mode: "dark", sw: ["#1c1422", "#452f52", "#f2784b"] },
  { key: "light", label: "Light", mode: "light", sw: ["#eceef4", "#ffffff", "#4757d8"] },
  { key: "strawberry", label: "Strawberry", mode: "light", sw: ["#fbe4ea", "#fffafb", "#e05575"] },
  { key: "ramune", label: "Ramune", mode: "light", sw: ["#ddeff7", "#fbfeff", "#1d86ae"] },
];

/** xterm palette pulled from the active theme's CSS variables (fallback: dark) */
function themeColors(): { background: string; foreground: string } {
  let bg = "";
  let fg = "";
  try {
    const cs = getComputedStyle(document.documentElement);
    bg = cs.getPropertyValue("--term-bg").trim();
    fg = cs.getPropertyValue("--term-fg").trim();
  } catch { /* non-DOM context */ }
  return { background: bg || "#0d0e12", foreground: fg || "#dcdee4" };
}

/** author for an event — mirrored sub-agent rows act under their own id */
const authorOf = (e: Ev) => {
  if (e.data?.actor) return { name: `@${String(e.data.actor)}`, icon: "🧩", color: "#3ba0c9" };
  if (e.type === "tool_call" || e.type === "tool_result")
    return { name: String(e.data?.name ?? "tool"), icon: "⚙", color: "#3ba0c9" };
  if (e.type === "prompt") {
    const src = String(e.data?.source ?? "user");
    if (src === "user") return AUTHORS.prompt;
    return src.startsWith("scheduler:") ? { name: src.slice(10), icon: "📣", color: "#3ba55d" } : HARNESS_AUTH;
  }
  return AUTHORS[e.type] ?? { name: e.type, icon: "•", color: "#9298a5" };
};

// state/error/fork/goal render as dividers or embeds inside the feed
const FEED_TYPES = new Set([
  "user", "message", "prompt", "tool_call", "tool_result", "progress",
  "state", "error", "fork", "goal", "todo", "question", "decision",
]);
const fmtTs = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

async function api(path: string, opts?: RequestInit) {
  const token = localStorage.getItem("teapot.token");
  const headers = new Headers(opts?.headers);
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) {
    // auth gate: surface once so the login overlay can appear
    if (res.status === 401) window.dispatchEvent(new CustomEvent("teapot:unauthorized"));
    let detail = "";
    try { detail = (await res.json())?.error ?? ""; } catch { /* not json */ }
    throw new Error(detail || `${path}: HTTP ${res.status}`);
  }
  return res.json();
}

// TEAPOT_API_TOKEN flow: open the UI as http://host/#token=<secret> once —
// it is stored and stripped from the URL, then attached to every request.
const hashTok = location.hash.match(/[#&]token=([^&]+)/);
if (hashTok) {
  localStorage.setItem("teapot.token", decodeURIComponent(hashTok[1]));
  history.replaceState(null, "", location.pathname + location.search);
}
const wsTokenQuery = () => {
  const t = localStorage.getItem("teapot.token");
  return t ? `?token=${encodeURIComponent(t)}` : "";
};

/* ---------- app ---------- */
export default function App() {
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [events, setEvents] = createSignal<Ev[]>([]);
  const [eventsTotal, setEventsTotal] = createSignal(0); // server-side count (window is capped)
  const [branches, setBranches] = createSignal<any[]>([]);
  const [metrics, setMetrics] = createSignal<any>(null);
  const [draft, setDraft] = createSignal("");
  const [cfg, setCfg] = createSignal<any>({ providers: {} });
  const [showNew, setShowNew] = createSignal(false);
  const [showCfg, setShowCfg] = createSignal(false);
  const [showRight, setShowRight] = createSignal(
    localStorage.getItem("teapot.panel") !== null
      ? localStorage.getItem("teapot.panel") === "1"
      : window.innerWidth > 1100,
  );
  const toggleRight = () => {
    const next = !showRight();
    setShowRight(next);
    localStorage.setItem("teapot.panel", next ? "1" : "0");
  };

  /* ---------- theme picker (per-browser, localStorage-backed) ---------- */
  const [showThemes, setShowThemes] = createSignal(false);
  // fixed theme…
  const [fixedTheme, setFixedTheme] = createSignal(localStorage.getItem("teapot.theme") ?? "dark");
  // …or follow the OS, with an explicit choice per system appearance
  const [themeAuto, setThemeAuto] = createSignal(localStorage.getItem("teapot.theme.auto") === "1");
  const [sysLightTheme, setSysLightTheme] = createSignal(
    localStorage.getItem("teapot.theme.light") ?? "light",
  );
  const [sysDarkTheme, setSysDarkTheme] = createSignal(
    localStorage.getItem("teapot.theme.dark") ?? "dark",
  );
  const sysMql =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: light)")
      : null;
  const [sysPrefersLight, setSysPrefersLight] = createSignal(sysMql?.matches ?? false);
  onMount(() => {
    const onChange = (e: MediaQueryListEvent) => setSysPrefersLight(e.matches);
    sysMql?.addEventListener("change", onChange);
    onCleanup(() => sysMql?.removeEventListener("change", onChange));
  });
  // single writer: resolves the active theme and slaps it on <html>
  createEffect(() => {
    document.documentElement.dataset.theme = themeAuto()
      ? sysPrefersLight()
        ? sysLightTheme()
        : sysDarkTheme()
      : fixedTheme();
  });
  // model switcher state
  const [modelProvider, setModelProvider] = createSignal("");
  const [modelDraft, setModelDraft] = createSignal("");
  const [models, setModels] = createSignal<
    { id: string; contextLength?: number; pricing?: { prompt: number; completion: number } }[]
  >([]);
  const providerList = () => Object.keys(cfg().providers ?? {});
  async function loadModels(prov: string) {
    if (!prov) return;
    try {
      const r = await api(`/api/models?provider=${encodeURIComponent(prov)}`);
      setModels(r.models ?? []);
    } catch { setModels([]); }
  }
  /** "ctx 1m · $3/M in · $15/M out" for the draft (or current) model */
  const modelSpec = () => {
    const id = modelDraft().trim() || sel()?.model || "";
    if (!id) return "";
    const m = models().find((x) => x.id === id);
    if (!m) return "";
    const parts: string[] = [];
    if (m.contextLength) parts.push(`ctx ${fmtK(m.contextLength)} tok`);
    const price = (p?: number) =>
      p === undefined ? "" : `$${p * 1e6 >= 10 ? Math.round(p * 1e6) : +(p * 1e6).toFixed(1)}/M`;
    if (m.pricing) {
      const pin = price(m.pricing.prompt);
      const pout = price(m.pricing.completion);
      if (pin && pout) parts.push(`${pin} in · ${pout} out`);
      else if (pin || pout) parts.push(price(m.pricing.prompt ?? m.pricing.completion));
    }
    return parts.join(" · ");
  };
  // keep the switcher aligned with the selected session
  createEffect(() => {
    const a = sel();
    if (!a) return;
    setModelProvider(a.provider || cfg().defaultProvider || providerList()[0] || "");
    setModelDraft("");
    loadModels(modelProvider());
  });
  // autoscroll: follow the tail only while the reader is already at the bottom
  const [atBottom, setAtBottom] = createSignal(true);
  const [missed, setMissed] = createSignal(0);
  const [live, setLive] = createSignal<{ text: string; reasoning: string } | null>(null);
  // markdown-rendered live body, throttled so per-chunk deltas don't re-parse
  // the whole (growing) text on every single WS message
  const [liveText, setLiveText] = createSignal("");
  let liveRenderTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const l = live();
    if (!l) {
      clearTimeout(liveRenderTimer);
      liveRenderTimer = undefined;
      setLiveText("");
      return;
    }
    if (liveRenderTimer) return; // a render is already scheduled
    liveRenderTimer = setTimeout(() => {
      liveRenderTimer = undefined;
      setLiveText(live()?.text ?? "");
    }, 60);
  });
  onCleanup(() => clearTimeout(liveRenderTimer));

  // auto-scroll the feed when live reasoning grows and we're at the bottom
  createEffect(() => {
    const txt = liveText();
    if (!txt) return;
    if (!atBottom()) return;
    // wait for the DOM to paint the new text
    requestAnimationFrame(() => {
      if (nearBottom()) scrollBottom(true);
    });
  });
  const sel = createMemo(() => agents().find((a) => a.id === selected()));
  // prompt being edited → edit-prompt fork dialog
  const [editing, setEditing] = createSignal<{ eventId: string; text: string } | null>(null);
  // optimistic echoes of prompts we just sent but haven't seen in the log yet
  const [pendingMsgs, setPendingMsgs] = createSignal<{ id: string; text: string; at: number }[]>([]);

  // pair tool_call events with their (possibly still missing) results:
  // consumed results are hidden from the feed, calls render as one merged row
  // that shows "running…" until its result lands
  const pairInfo = createMemo(() => {
    const resFor = new Map<string, Ev>();
    const consumed = new Set<string>();
    const awaiting = new Map<string, Ev[]>();
    for (const e of events()) {
      if (!FEED_TYPES.has(e.type)) continue;
      if (e.type === "tool_call") {
        const q = awaiting.get(e.data.callId) ?? [];
        q.push(e);
        awaiting.set(e.data.callId, q);
      } else if (e.type === "tool_result") {
        const call = awaiting.get(e.data.callId)?.shift();
        if (call) {
          resFor.set(call.id, e);
          consumed.add(e.id);
        }
      }
    }
    return { resFor, consumed };
  });
  const chatEvents = createMemo(() => {
    const { consumed } = pairInfo();
    const real = events().filter((e) => {
      if (!FEED_TYPES.has(e.type)) return false;
      // paired tool results live inside their call's merged row
      if (e.type === "tool_result") return !consumed.has(e.id);
      // tool-call carrier turns have no visible payload — the ToolRow below
      // already tells that story; an empty agent bubble is just noise
      if (e.type === "message")
        return (
          String(e.data?.content ?? "").trim() !== "" ||
          String(e.data?.reasoning ?? "").trim() !== "" ||
          !!e.data?.final
        );
      return true;
    });
    // expand mirrored child activity ("sub" events) into normal-looking rows
    // tagged with the acting sub id, so the parent feed shows who did what
    const expanded: Ev[] = [];
    for (const e of real) {
      if (e.type === "sub") {
        const d = e.data as { sub?: string; type?: string; data?: any };
        const kind = String(d?.type ?? "message");
        if (kind === "state") continue; // child state churn is noise up here
        expanded.push({ ...e, type: kind, data: { ...(d?.data ?? {}), actor: d?.sub } });
      } else expanded.push(e);
    }
    // append optimistic echoes not yet present in the log
    const pend = pendingMsgs().filter(
      (p) =>
        !expanded.some(
          (e) =>
            e.type === "prompt" &&
            e.data?.source === "user" &&
            e.data?.text === p.text &&
            new Date(e.ts).getTime() >= p.at - 1000,
        ),
    );
    const echoes: Ev[] = pend.map((p) => ({
      id: p.id,
      seq: 0,
      ts: new Date(p.at).toISOString(),
      session: sel()?.session ?? "",
      branch: sel()?.branch ?? "br0",
      parent: null,
      type: "prompt",
      data: { source: "user", text: p.text, pending: true },
    }));
    return [...expanded, ...echoes];
  });
  const loadCfg = () => api("/api/config").then(setCfg).catch(() => {});
  // password auth: any 401 from /api/* flips this on → login overlay
  const [authLocked, setAuthLocked] = createSignal(false);
  onMount(() => {
    const onUnauthorized = () => setAuthLocked(true);
    window.addEventListener("teapot:unauthorized", onUnauthorized);
    onCleanup(() => window.removeEventListener("teapot:unauthorized", onUnauthorized));
  });

  // operator task list draft — seeded per selected agent; while the user
  // hasn't touched it, it follows server updates (the agent edits it too)
  const [todoDraft, setTodoDraft] = createSignal("");
  const [todoDirty, setTodoDirty] = createSignal(false);
  let todoSeededFor = "";
  createEffect(() => {
    const id = selected();
    const serverTodo = agents().find((a) => a.id === id)?.todo ?? "";
    if (id && id !== todoSeededFor) {
      todoSeededFor = id;
      setTodoDirty(false);
      setTodoDraft(serverTodo);
    } else if (id && !todoDirty()) {
      setTodoDraft(serverTodo); // stay current with agent-side set_todo edits
    }
  });
  const saveTodo = async () => {
    const notify = (document.getElementById("todo-notify") as HTMLInputElement)?.checked ?? true;
    if (!selected()) return;
    try {
      await api(`/api/agents/${selected()}/todo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: todoDraft(), notify }),
      });
      setTodoDirty(false);
      flashHint(`tasks saved${notify && todoDraft().trim() ? " & notification queued" : ""}`);
      refreshAgents();
    } catch (ex) {
      flashHint(`save failed: ${(ex as Error).message}`);
    }
  };

  /** count markdown checkboxes ("- [ ]" / "- [x]") in the draft for the progress pill */
  const todoStats = createMemo(() => {
    let total = 0;
    let done = 0;
    for (const line of todoDraft().split("\n")) {
      const m = line.match(/^\s*[-*+] \[([ xX])\]/);
      if (!m) continue;
      total++;
      if (m[1]!.toLowerCase() === "x") done++;
    }
    return { total, done };
  });

  const refreshAgents = () => api("/api/agents").then((d) => setAgents(d.agents)).catch(() => {});
  const refreshMetrics = () => api("/api/metrics").then(setMetrics).catch(() => {});

  // scheduled (cron) tasks — shown in the right panel so "what runs when" is legible
  const [tasks, setTasks] = createSignal<any[]>([]);
  const loadTasks = () => api("/api/tasks").then((d) => setTasks(d.tasks)).catch(() => {});
  const agentTasks = (id: string | null) => tasks().filter((t) => t.agent === id);

  // sidebar tree: subs hang under their parent, collapsible per parent
  const [collapsedSubs, setCollapsedSubs] = createSignal<Set<string>>((() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("teapot.collapsed") ?? "[]"));
    } catch { return new Set(); }
  })());
  const toggleCollapse = (id: string) => {
    const next = new Set(collapsedSubs());
    next.has(id) ? next.delete(id) : next.add(id);
    setCollapsedSubs(next);
    localStorage.setItem("teapot.collapsed", JSON.stringify([...next]));
  };
  const treeRows = createMemo(() => {
    const list = agents();
    const byParent = new Map<string, Agent[]>();
    const roots: Agent[] = [];
    for (const a of list) {
      const isSub = a.parent && list.some((p) => p.id === a.parent);
      if (isSub) {
        if (!byParent.has(a.parent!)) byParent.set(a.parent!, []);
        byParent.get(a.parent!)!.push(a);
      } else roots.push(a);
    }
    const rows: { a: Agent; depth: number }[] = [];
    const walk = (nodes: Agent[], depth: number) => {
      for (const a of nodes) {
        rows.push({ a, depth });
        const kids = byParent.get(a.id);
        if (kids?.length && !collapsedSubs().has(a.id)) walk(kids, depth + 1);
      }
    };
    walk(roots, 0);
    return rows;
  });

  // null = show everything; otherwise only the chosen branch's events
  const [branchFilter, setBranchFilter] = createSignal<string | null>(null);
  // Reference-stabilize events across fetches: logged events are immutable,
  // so reuse the previous object when the id already exists. Without this,
  // every refresh produced all-new references and Solid's <For> tore down
  // and rebuilt EVERY timeline row (markdown re-parse included) — heavy on
  // long sessions and it collapsed open <details>.
  const evCache = new Map<string, Ev>();
  function stabilize(list: Ev[]): Ev[] {
    const out = new Array<Ev>(list.length);
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      const known = evCache.get(e.id);
      out[i] = known ?? e;
      if (!known) {
        evCache.set(e.id, e);
        if (evCache.size > 3000) {
          const oldest = evCache.keys().next().value;
          if (oldest !== undefined) evCache.delete(oldest);
        }
      }
    }
    return out;
  }

  // upward pagination: prepend the page before the oldest loaded id
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [olderDone, setOlderDone] = createSignal(false);

  /** merge fetched page into state by id, seq-ascending, refs stabilized */
  function mergeEvents(incoming: Ev[]): void {
    setEvents((prev) => {
      const map = new Map<string, Ev>();
      for (const e of prev) map.set(e.id, e);
      for (const e of stabilize(incoming)) if (!map.has(e.id)) map.set(e.id, e);
      return [...map.values()].sort((a, b) => a.seq - b.seq);
    });
  }

  async function loadOlder(): Promise<void> {
    const id = selected();
    const oldest = events()[0];
    if (!id || !oldest || loadingOlder() || olderDone()) return;
    setLoadingOlder(true);
    try {
      const f = feedEl();
      const prevH = f?.scrollHeight ?? 0;
      const prevTop = f?.scrollTop ?? 0;
      const bf = branchFilter();
      const res = await api(
        `/api/agents/${id}/events?limit=300&before=${encodeURIComponent(oldest.id)}${bf ? `&branch=${encodeURIComponent(bf)}` : ""}`,
      );
      const page: Ev[] = res.events ?? [];
      if (page.length === 0) { setOlderDone(true); return; }
      mergeEvents(page);
      // keep the viewport anchored to the same content after prepending
      requestAnimationFrame(() => {
        const el = feedEl();
        if (el) el.scrollTop = prevTop + (el.scrollHeight - prevH);
      });
    } catch { /* transient — user can scroll up again */ }
    finally { setLoadingOlder(false); }
  }

  async function loadEvents(id: string) {
    try {
      const bf = branchFilter();
      const [ev, br, sk] = await Promise.all([
        api(`/api/agents/${id}/events?limit=300${bf ? `&branch=${encodeURIComponent(bf)}` : ""}`),
        api(`/api/agents/${id}/branches`),
        api(`/api/agents/${id}/skills`).catch(() => ({ skills: [] })),
      ]);
      setEvents((prev) => {
        // tail refresh: union-merge so prepended older pages survive, and
        // stabilize() keeps unchanged rows reference-identical (no re-mounts)
        const map = new Map<string, Ev>();
        for (const e of prev) map.set(e.id, e);
        for (const e of stabilize(ev.events)) map.set(e.id, e);
        return [...map.values()].sort((a, b) => a.seq - b.seq);
      });
      setEventsTotal(ev.total ?? ev.events.length);
      setBranches(br.branches);
      setAgentSkills(sk.skills ?? []);
    } catch { /* agent may be gone */ }
  }

  function feedEl() { return document.querySelector(".feed"); }
  function nearBottom() {
    const f = feedEl();
    return !f || f.scrollHeight - f.scrollTop - f.clientHeight < 80;
  }
  function scrollBottom(force = false) {
    const f = feedEl();
    if (f && (force || atBottom())) {
      f.scrollTop = f.scrollHeight;
      setMissed(0);
    }
  }

  async function select(id: string, push = true) {
    setSelected(id);
    setLive(null);
    setBranchFilter(null);
    setOlderDone(false);
    setLoadingOlder(false);
    setPendingMsgs([]);
    localStorage.setItem("teapot.session", id);
    navigate(id, push);
    // lazy sessions sit in "stopped" until touched — clicking loads them
    api(`/api/agents/${id}/load`, { method: "POST" }).then(refreshAgents).catch(() => {});
    await loadEvents(id);
    requestAnimationFrame(() => scrollBottom(true));
  }

  /* ---------- realtime over WebSocket (auto-reconnect) ---------- */
  const [connected, setConnected] = createSignal(false);
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => ws?.close());
  function connectWs() {
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(`${proto}${location.host}/api/ws${wsTokenQuery()}`);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setTimeout(connectWs, 1500); // reconnect with a fixed short backoff
    };
    ws.onerror = () => ws?.close();
    // event types that don't change the feed — refreshing on every one of
    // these would hammer /events several times per turn for nothing
    const FEED_IRRELEVANT = new Set(["state", "usage", "session_start"]);
    // last streaming delta per agent — decides whether the live bubble is
    // still generating or already fully persisted
    let lastDelta: { id: string; at: number } | null = null;
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.kind === "ping" || msg.kind === "pong") return;
      if (msg.kind === "llm-delta") {
        lastDelta = { id: msg.agentId, at: Date.now() };
        if (msg.agentId === selected()) setLive({ text: msg.text ?? "", reasoning: msg.reasoning ?? "" });
        return;
      }
      if (msg.kind === "event" && FEED_IRRELEVANT.has(msg.event?.type)) return;
      if (timer) return;
      timer = setTimeout(async () => {
        timer = null;
        await refreshAgents();
        await refreshMetrics();
        if (selected()) {
          // compare last event ID, not array length: the /events window is
          // capped at 300, so long sessions have a CONSTANT length and a
          // length check never noticed new events (leaving the live bubble
          // blinking forever after the agent went idle)
          const beforeId = events().at(-1)?.id;
          const beforeTotal = eventsTotal();
          const fetchStartedAt = Date.now();
          await loadEvents(selected()!);
          if (events().at(-1)?.id !== beforeId) {
            // keep the bubble only if THIS agent streamed a delta after the
            // fetch started (i.e. the bubble shows something newer than
            // everything persisted). Otherwise it must go — otherwise a
            // stale "thinking…"/duplicate bubble outlives an idle agent.
            const stillStreaming = lastDelta?.id === selected() && lastDelta.at >= fetchStartedAt;
            if (!stillStreaming) setLive(null);
            if (nearBottom()) scrollBottom(true);
            else setMissed(missed() + Math.max(0, eventsTotal() - beforeTotal));
          }
          // drop optimistic echoes that the log has now caught up with
          setPendingMsgs((list) =>
            list.filter(
              (p) =>
                !events().some(
                  (e) =>
                    e.type === "prompt" &&
                    e.data?.text === p.text &&
                    new Date(e.ts).getTime() >= p.at - 1000,
                ),
            ),
          );
        }
      }, 400);
    };
  }

  /* ---------- /session/<id> routing ---------- */
  const pathId = () => decodeURIComponent(location.pathname.split("/")[2] ?? "");
  function navigate(id: string, push = true) {
    const url = `/session/${encodeURIComponent(id)}`;
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }
  window.addEventListener("popstate", () => {
    const id = pathId();
    if (id && agents().some((a) => a.id === id) && id !== selected()) select(id, false);
  });

  /* ---------- small UX niceties ---------- */
  createEffect(() => {
    const a = sel();
    document.title = a ? `${a.status === "running" ? "▶ " : a.status === "error" ? "⚠ " : ""}${a.id} · teapot` : "teapot";
  });
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (typing) {
      if (e.key === "Escape") (t as HTMLElement).blur();
      return;
    }
    if (e.key === "Escape") {
      if (showNew()) { setShowNew(false); return; }
      if (showCfg()) { setShowCfg(false); return; }
      if (editing()) { setEditing(null); return; }
      if (showThemes()) { setShowThemes(false); return; }
      const s = sel();
      if (s?.status === "running") {
        // Claude-Code-style: Esc interrupts the running agent
        api(`/api/agents/${s.id}/stop`, { method: "POST" }).then(refreshAgents);
        return;
      }
      if (showRight() && window.innerWidth <= 1100) setShowRight(false);
      return;
    }
    if (showNew() || showCfg()) return;
    if (e.key === "/") {
      e.preventDefault();
      document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
    } else if (e.key === "d") {
      toggleRight();
    } else if (e.key === "t") {
      toggleTerm();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // follow the visible sidebar tree order (parents, then expanded subs)
      const list = treeRows().map((r) => r.a);
      if (list.length === 0) return;
      e.preventDefault();
      const idx = list.findIndex((a) => a.id === selected());
      const next = e.key === "ArrowDown" ? Math.min(idx + 1, list.length - 1) : Math.max(idx - 1, 0);
      if (next !== idx) select(list[next].id);
    }
  });

  /* ---------- human terminal (bottom drawer: resizable, tabs, split) ---------- */
  const [termOpen, setTermOpen] = createSignal(localStorage.getItem("teapot.term") === "1");
  const toggleTerm = () => {
    const next = !termOpen();
    setTermOpen(next);
    localStorage.setItem("teapot.term", next ? "1" : "0");
  };

  type TermTab = { key: string; agentId: string; title: string };
  type TermSession = {
    el: HTMLDivElement;
    term: any;
    fit: any;
    ws: WebSocket;
    ro: ResizeObserver | null;
  };
  const [termTabs, setTermTabs] = createSignal<TermTab[]>([]);
  // each pane holds an index into termTabs (-1 = empty slot)
  const [paneL, setPaneL] = createSignal(0);
  const [paneR, setPaneR] = createSignal(-1);
  const [splitView, setSplitView] = createSignal(false);
  const [focusedPane, setFocusedPane] = createSignal(0);
  const [termHeight, setTermHeight] = createSignal(
    Number(localStorage.getItem("teapot.termH")) ||
      Math.max(220, Math.round(window.innerHeight * 0.35)),
  );
  const liveTerms = new Map<string, TermSession>();
  const paneHosts: (HTMLDivElement | null)[] = [null, null];

  /** the tab currently shown in the focused pane */
  const activeTab = () =>
    termTabs()[focusedPane() === 0 ? paneL() : paneR()] ?? null;

  function focusTab(i: number) {
    const tab = termTabs()[i];
    if (!tab) return;
    const mine = focusedPane() === 0 ? paneL : paneR;
    const other = focusedPane() === 0 ? paneR : paneL;
    if (other() === i) {
      // it's in the other pane — swap so both stay visible
      focusedPane() === 0 ? setPaneR(mine()) : setPaneL(mine());
    }
    mine() === i ? void i : (focusedPane() === 0 ? setPaneL(i) : setPaneR(i));
  }

  const addFromSelected = () => addTab();

  function addTab(agentId?: string) {
    const who = agentId ?? selected();
    if (!who) return;
    const perAgent = termTabs().filter((t) => t.agentId === who).length;
    if (perAgent >= 2) {
      flashHint(`max 2 shells per agent (${who})`);
      return;
    }
    const n = termTabs().length + 1;
    const tab: TermTab =
      perAgent === 0
        ? { key: `${who}`, agentId: who, title: who }
        : { key: `${who}#${perAgent + 1}`, agentId: who, title: `${who}·${perAgent + 1}` };
    setTermTabs((list) => [...list, tab]);
    // land in the focused pane (swap if the other pane shows it already)
    if (focusedPane() === 0) setPaneL(termTabs().length); else setPaneR(termTabs().length);
    void n;
  }

  function closeTab(i: number) {
    const tab = termTabs()[i];
    if (!tab) return;
    const s = liveTerms.get(tab.key);
    if (s) {
      s.ro?.disconnect();
      try { s.ws.close(); } catch { /* gone */ }
      s.term.dispose();
      liveTerms.delete(tab.key);
    }
    const rest = termTabs().filter((_, j) => j !== i);
    setTermTabs(rest);
    const shift = (idx: number) => (idx === i ? -1 : idx > i ? idx - 1 : idx);
    setPaneL((p) => Math.min(shift(p), rest.length - 1));
    setPaneR((p) => (p === -1 ? -1 : Math.min(shift(p), rest.length - 1)));
  }

  function disposeAllTerms() {
    for (const [, s] of liveTerms) {
      s.ro?.disconnect();
      try { s.ws.close(); } catch { /* gone */ }
      s.term.dispose();
    }
    liveTerms.clear();
  }

  /** create (and mount) a session lazily; moving panes just re-appends its el */
  function ensureSession(tab: TermTab, host: HTMLElement): TermSession {
    let s = liveTerms.get(tab.key);
    if (!s) {
      const el = document.createElement("div");
      el.className = "termsession";
      host.appendChild(el);
      const t = new Terminal({
        cursorBlink: true,
        fontSize: 12.5,
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        theme: themeColors(),
      });
      const f = new FitAddon();
      t.loadAddon(f);
      t.open(el);
      const proto = location.protocol === "https:" ? "wss://" : "ws://";
      const w = new WebSocket(`${proto}${location.host}/api/agents/${tab.agentId}/term${wsTokenQuery()}`);
      w.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.kind === "data") t.write(msg.data);
        else if (msg.kind === "exit") t.write(`\r\n\x1b[2m[terminal exited ${msg.code ?? ""}]\x1b[0m\r\n`);
      };
      t.onData((d: string) => {
        if (w.readyState === WebSocket.OPEN) w.send(JSON.stringify({ kind: "input", data: d }));
      });
      let last = { cols: 0, rows: 0 };
      const resizeTimer: ReturnType<typeof setTimeout>[] = [];
      const pushResize = () => {
        try { f.fit(); } catch { /* hidden */ }
        if ((t.cols !== last.cols || t.rows !== last.rows) && w.readyState === WebSocket.OPEN) {
          last = { cols: t.cols, rows: t.rows };
          w.send(JSON.stringify({ kind: "resize", cols: t.cols, rows: t.rows }));
        }
      };
      const ro = new ResizeObserver(() => {
        if (resizeTimer[0]) clearTimeout(resizeTimer[0]);
        resizeTimer[0] = setTimeout(pushResize, 250);
      });
      ro.observe(el);
      setTimeout(pushResize, 60);
      s = { el, term: t, fit: f, ws: w, ro };
      liveTerms.set(tab.key, s);
    } else if (s.el.parentElement !== host) {
      host.appendChild(s.el); // moved between panes — xterm DOM survives the move
      setTimeout(() => { try { s!.fit(); } catch { /* */ } }, 30);
    }
    return s;
  }

  function mountPane(idx: number) {
    const host = paneHosts[idx];
    if (!host) return;
    const tab = termTabs()[idx === 0 ? paneL() : paneR()];
    if (!tab) {
      host.replaceChildren();
      return;
    }
    const s = ensureSession(tab, host);
    if (focusedPane() === (idx === 0 ? 0 : 1)) {
      requestAnimationFrame(() => {
        try { s.fit(); s.term.focus(); } catch { /* */ }
      });
    }
  }

  // (re)mount both panes whenever layout inputs change
  createEffect(() => {
    void termTabs();
    void splitView();
    void paneL();
    void paneR();
    void termHeight();
    requestAnimationFrame(() => {
      mountPane(0);
      if (splitView()) mountPane(1);
    });
  });

  // opening the drawer ensures a shell for the selected agent
  createEffect(() => {
    if (!termOpen()) return;
    const id = selected();
    if (!id) return;
    if (!termTabs().some((t) => t.agentId === id) && termTabs().length === 0) addTab(id);
    else if (!termTabs().some((t) => t.agentId === id)) {
      // another agent — focus its tab in the active pane if present
      const i = termTabs().findIndex((t) => t.agentId === id);
      if (i >= 0) focusTab(i);
    }
  });

  // drawer height drag (double-click resets)
  const startGrip = (e: PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = termHeight();
    const move = (ev: PointerEvent) => {
      const h = Math.min(Math.max(startH - (ev.clientY - startY), 140), Math.round(window.innerHeight * 0.85));
      setTermHeight(h);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem("teapot.termH", String(termHeight()));
      requestAnimationFrame(() => { mountPane(0); if (splitView()) mountPane(1); });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toggleSplit = () => {
    const next = !splitView();
    setSplitView(next);
    if (next && paneR() === -1) {
      // seed the second pane with any other tab (or leave it as an empty slot)
      const other = termTabs().findIndex((_, i) => i !== paneL());
      setPaneR(other >= 0 ? other : -1);
    }
  };

  onCleanup(disposeAllTerms);

  // legacy single-host refs kept for pane mounting
  const setPaneHost = (idx: number) => (el: HTMLDivElement) => {
    paneHosts[idx] = el;
  };

  onMount(() => {
    loadCfg();
    refreshAgents().then(() => {
      // deep link → last session → first agent
      const want = pathId() || localStorage.getItem("teapot.session") || "";
      const initial = agents().find((a) => a.id === want) ?? agents()[0];
      if (initial) select(initial.id, false);
    });
    refreshMetrics();
    loadTasks();
    loadPersonas();
    connectWs();
    const mi = setInterval(() => {
      refreshMetrics();
      loadTasks();
    }, 30_000);
    onCleanup(() => clearInterval(mi));
  });

  const SLASH_COMMANDS = [
    { cmd: "/start", desc: "start working toward the goal" },
    { cmd: "/stop", desc: "interrupt the running agent" },
    { cmd: "/fork", desc: "branch the conversation here" },
    { cmd: "/goal", desc: "/goal <text> — set goal & notify the agent" },
    { cmd: "/compact", desc: "force a context compaction now" },
    { cmd: "/skill", desc: "/skill <name> — force-load a skill and follow it" },
  ];

  // @mentions: personas spawn sub-agents, agent ids target existing ones
  const [personas, setPersonas] = createSignal<{ key: string; label: string }[]>([]);
  const loadPersonas = () => api("/api/personas").then((d) => setPersonas(d.personas)).catch(() => {});
  const [mentionFork, setMentionFork] = createSignal(false);
  const mentionQuery = () => {
    const m = draft().match(/^@([A-Za-z0-9._-]*)$/);
    return m ? m[1]!.toLowerCase() : null;
  };
  const mentionMatches = () => {
    const q = mentionQuery();
    if (q === null) return [];
    const list = [
      ...personas().map((p) => ({ key: p.key, label: `${p.label} — spawns a sub-agent`, kind: "persona" as const })),
      ...agents()
        .filter((a) => a.id !== selected())
        .map((a) => ({ key: a.id, label: `${a.status} — send directly`, kind: "agent" as const })),
    ];
    return list.filter((x) => x.key.toLowerCase().startsWith(q));
  };
  // popup shows while typing the first token of a command
  const filteredCmds = () => {
    const d = draft();
    if (!d.startsWith("/") || d.includes(" ") || d.includes("\n")) return [];
    return SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(d.slice(1).toLowerCase()));
  };

  // unified suggestions: slash commands, then /skill argument completion
  // (skill names come from the selected agent's roots via /api/agents/:id/skills)
  type Suggest = { insert: string; title: string };
  const NO_ARG_COMMANDS = new Set(["start", "stop", "fork", "compact"]);
  const [agentSkills, setAgentSkills] = createSignal<{ name: string; description: string }[]>([]);
  const [cmdIdx, setCmdIdx] = createSignal(-1);
  const suggestions = (): Suggest[] => {
    const d = draft();
    if (!d.startsWith("/") || d.includes("\n")) return [];
    const m = d.match(/^\/([a-z]*)(?:\s+(.*))?$/i);
    if (!m) return [];
    const cmdName = m[1]!.toLowerCase();
    const argPart = (m[3] ?? "").trim();
    if (!argPart && cmdName !== "skill") {
      const rows = SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(cmdName));
      // an exact, argument-less command must EXECUTE on Enter — don't keep a
      // popup open that would swallow the keystroke as another selection
      const exact = rows.find((c) => c.cmd.slice(1) === cmdName);
      if (exact && NO_ARG_COMMANDS.has(cmdName)) return [];
      return rows.map((c) => ({ insert: c.cmd + " ", title: c.desc }));
    }
    if (cmdName === "skill") {
      let rows = agentSkills().filter((s) => s.name.toLowerCase().startsWith(argPart.toLowerCase()));
      // a single exact match means the name is complete — stop suggesting so
      // the following Enter dispatches /skill instead of re-selecting
      if (rows.length === 1 && rows[0]!.name.toLowerCase() === argPart.toLowerCase()) return [];
      return rows.map((s) => ({ insert: `/skill ${s.name} `, title: s.description || "(bundled skill)" }));
    }
    return [];
  };
  let composerEl: HTMLTextAreaElement | undefined;
  const autosizeComposer = () => {
    if (!composerEl) return;
    composerEl.style.height = "auto";
    composerEl.style.height = `${Math.min(composerEl.scrollHeight, 160)}px`;
  };
  createEffect(() => {
    draft(); // re-run on typing AND after send() clears the draft
    autosizeComposer();
  });

  /** post a raw prompt (used by composer AND question-option taps) */
  const sendText = async (text: string, targetId?: string) => {
    const id = targetId ?? selected();
    if (!id) return;
    try {
      await api(`/api/agents/${id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, start: true }),
      });
      // optimistic echo — replaced by the logged event once the feed catches up
      setPendingMsgs((l) => [...l, { id: `@p${Date.now()}${Math.random().toString(36).slice(2, 6)}`, text, at: Date.now() }]);
      // scroll to bottom after our message appears
      requestAnimationFrame(() => scrollBottom(true));
    } catch (ex) {
      setDraft(text); // never eat the user's message on a failed send
      console.error("send failed:", ex);
    }
  };

  const send = async (e: Event) => {
    e.preventDefault();
    const id = selected();
    const text = draft().trim();
    if (!id || !text) return;

    // @mentions: persona → spawn sub-agent; agent id → direct message
    if (text.startsWith("@")) {
      const sp = text.indexOf(" ");
      const name = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
      const arg = sp === -1 ? "" : text.slice(sp + 1).trim();
      const isPersona = personas().some((p) => p.key.toLowerCase() === name);
      const knownAgent = agents().some((a) => a.id.toLowerCase() === name);
      try {
        if (isPersona) {
          if (!arg) { flashHint(`usage: @${name} <task>`); return; }
          const r = await api(`/api/agents/${selected()}/spawn`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ persona: name, task: arg, context: mentionFork() ? "fork" : "none" }),
          });
          flashHint(`🧩 spawned ${(r as any).id}${mentionFork() ? " (forked context)" : ""}`);
          refreshAgents(); setDraft("");
        } else if (knownAgent) {
          if (!arg) { flashHint(`usage: @${name} <message>`); return; }
          await api(`/api/agents/${encodeURIComponent(name)}/prompt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: arg, start: true }),
          });
          flashHint(`→ delivered to @${name}`);
          setDraft("");
        } else {
          flashHint(`unknown @${name} — personas: ${personas().map((p) => p.key).join(", ") || "(none)"}`);
          return;
        }
      } catch (ex) {
        flashHint(`@${name} failed: ${(ex as Error).message}`);
      }
      return;
    }

    // slash commands are client-side operations
    if (text.startsWith("/")) {
      const sp = text.indexOf(" ");
      const name = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
      const arg = sp === -1 ? "" : text.slice(sp + 1).trim();
      if (name === "goal" && !arg) { setDraft("/goal "); return; } // keep typing
      if (name === "skill" && !arg) { setDraft("/skill "); return; }
      setDraft("");
      await executeSlash(name, arg);
      return;
    }

    setDraft("");
    await sendText(text);
  };

  const executeSlash = async (name: string, arg: string): Promise<void> => {
    const id = selected();
    if (!id) return;
    const post = (p: string, body?: unknown) =>
      api(`/api/agents/${id}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }).then(refreshAgents);
    try {
      if (name === "start") await post("/start");
      else if (name === "stop") await post("/stop");
      else if (name === "fork") { await post("/fork", {}); await select(id); }
      else if (name === "compact") {
        const r: any = await post("/compact");
        flashHint(r?.ran ? "context compacted" : "nothing to compact yet");
      }
      else if (name === "goal") {
        if (!arg) { flashHint("usage: /goal <text>"); return; }
        await post("/goal", { text: arg, notify: true });
        flashHint("goal saved & notification queued");
      }
      else if (name === "skill") {
        if (!arg) { flashHint("usage: /skill <name>"); return; }
        await sendText(
          `[harness] Force-load and follow the skill "${arg}" now: call load_skill("${arg}") and execute its playbook for the current task.`,
        );
        flashHint(`skill "${arg}" dispatched`);
      }
      else {
        flashHint(`unknown command "${name}" — /start /stop /fork /goal /skill /compact`);
      }
    } catch (ex) {
      flashHint(`/${name} failed: ${(ex as Error).message}`);
    }
  };

  const act = (path: string) =>
    () => selected() && api(`/api/agents/${selected()}${path}`, { method: "POST" }).then(refreshAgents);

  const setGoal = async (e: Event) => {
    e.preventDefault();
    const input = document.getElementById("goal-input") as HTMLTextAreaElement;
    const notify = (document.getElementById("goal-notify") as HTMLInputElement)?.checked ?? true;
    if (!selected() || !input.value.trim()) return;
    await api(`/api/agents/${selected()}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: input.value, notify }),
    });
    input.value = "";
    refreshAgents();
  };

  return (
    <>
    <Show when={cfg()?.needsSetup} fallback={null}>
      <SetupWizard onDone={() => location.reload()} />
    </Show>
    <Show when={authLocked()}>
      <div class="overlay">
        <div class="modal" style="max-width:360px">
          <div class="modal-head"><b>🔒 sign in</b><span /></div>
          <form
            onsubmit={(e) => {
              e.preventDefault();
              const el = document.getElementById("pw-input") as HTMLInputElement;
              localStorage.setItem("teapot.token", el.value);
              location.reload();
            }}
            style="display:flex;flex-direction:column;gap:10px"
          >
            <input id="pw-input" type="password" placeholder="password" autofocus />
            <button type="submit" style="background:var(--acc);border:none;border-radius:6px;color:#fff;padding:7px 12px;cursor:pointer">unlock</button>
            <span class="muted" style="font-size:11px">the token is stored locally and sent as Bearer to this server only</span>
          </form>
        </div>
      </div>
    </Show>
    <Show when={!cfg()?.needsSetup}>
    <div class={"layout" + (showRight() ? "" : " right-hidden")}>
      {/* ---------- sidebar ---------- */}
      <nav class="sidebar">
        <h1>🫖 teapot
          <span class={"conn" + (connected() ? " ok" : "")} title={connected() ? "live (websocket)" : "reconnecting…"} />
          <span style="float:right;display:flex;gap:4px">
            <button class="iconbtn" title="new agent" onclick={() => { loadCfg(); setShowNew(true); }}>＋</button>
            <button class="iconbtn" title="themes" onclick={() => setShowThemes(!showThemes())}>◐</button>
            <button class="iconbtn" title="settings" onclick={() => { loadCfg(); setShowCfg(true); }}>⚙</button>
          </span>
        </h1>
        <Show when={showThemes()}>
          <div class="themepop">
            <label class="trow" title="switch automatically when the OS switches appearance — pick which theme to use for each">
              <input
                type="checkbox"
                checked={themeAuto()}
                onchange={(e) => {
                  const v = e.currentTarget.checked;
                  setThemeAuto(v);
                  localStorage.setItem("teapot.theme.auto", v ? "1" : "0");
                }}
              />
              follow system
            </label>
            <Show
              when={!themeAuto()}
              fallback={
                <>
                  <label class="trow">system light →
                    <select
                      class="w100"
                      value={sysLightTheme()}
                      onchange={(e) => {
                        setSysLightTheme(e.currentTarget.value);
                        localStorage.setItem("teapot.theme.light", e.currentTarget.value);
                      }}
                    >
                      <For each={THEMES.filter((t) => t.mode === "light")}>
                        {(t) => <option value={t.key}>{t.label}</option>}
                      </For>
                    </select>
                  </label>
                  <label class="trow">system dark →
                    <select
                      class="w100"
                      value={sysDarkTheme()}
                      onchange={(e) => {
                        setSysDarkTheme(e.currentTarget.value);
                        localStorage.setItem("teapot.theme.dark", e.currentTarget.value);
                      }}
                    >
                      <For each={THEMES.filter((t) => t.mode === "dark")}>
                        {(t) => <option value={t.key}>{t.label}</option>}
                      </For>
                    </select>
                  </label>
                </>
              }
            >
              <div class="themegrid">
                <For each={THEMES}>
                  {(t) => (
                    <button
                      class={"themebtn" + (fixedTheme() === t.key ? " on" : "")}
                      title={`${t.label} (${t.mode})`}
                      onclick={() => {
                        setFixedTheme(t.key);
                        localStorage.setItem("teapot.theme", t.key);
                      }}
                    >
                      <span class="swdots">{t.sw.map((c) => <i style={{ background: c }} />)}</span>
                      {t.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
        <div class="agent-list">
          <For each={treeRows()}>
            {({ a, depth }) => (
              <div
                class={"agent-item" + (a.id === selected() ? " sel" : "") + (depth > 0 ? " sub-row" : "")}
                style={depth > 0 ? `padding-left:${10 + depth * 14}px` : ""}
                onclick={() => select(a.id)}
                title={a.parent ? `sub-agent of @${a.parent}` : undefined}
              >
                <Show when={agents().some((x) => x.parent === a.id)} fallback={<span class="caret-spacer" />}>
                  <span
                    class="caret"
                    title={collapsedSubs().has(a.id) ? "expand sub-agents" : "collapse sub-agents"}
                    onclick={(e: MouseEvent) => { e.stopPropagation(); toggleCollapse(a.id); }}
                  >{collapsedSubs().has(a.id) ? "▸" : "▾"}</span>
                </Show>
                <span class={`dot ${a.status}`} />
                <span>{a.id}</span>
                <Show when={a.parent}><span class="subtag">🧩</span></Show>
                <Show when={agentTasks(a.id).length > 0}>
                  <span class="mini-cron" title={agentTasks(a.id).map((t) => `${t.id}: ${t.schedule}`).join("\n")}>⏰</span>
                </Show>
                <Show when={a.goal.status === "done"}><span title="goal done">✓</span></Show>
              </div>
            )}
          </For>
        </div>
        <div class="metrics">
          <Show when={metrics()}>
            master rss {metrics().rssMb}MB · heap {metrics().heapUsedMb}MB<br />
            load1 {metrics().loadavg1} · up {Math.floor(metrics().uptimeSec / 60)}m
          </Show>
        </div>
      </nav>

      {/* ---------- channel ---------- */}
      <section class="channel">
        <Show when={sel()} fallback={<div style="display:grid;place-items:center;height:100%" class="muted">select an agent</div>}>
          <header class="chan-head">
            <span class="hash">#</span>
            <span class="title">{sel()!.id}</span>
            <span class={`badge ${sel()!.status}`}>{sel()!.status}</span>
            <Show when={(sel()!.pendingPrompts ?? 0) > 0}>
              <span class="badge queued" title={`${sel()!.pendingPrompts} prompt(s) waiting — the agent picks them up at the next turn boundary`}>
                ⏳ {sel()!.pendingPrompts} queued
              </span>
            </Show>
            <Show when={agentTasks(sel()!.id).length > 0}>
              <span class="badge cron" title={`scheduled tasks:\n${agentTasks(sel()!.id).map((t) => `${t.schedule} · ${t.id}${t.forked ? " (forked)" : ""}`).join("\n")}`}>
                ⏰ {agentTasks(sel()!.id).length}
              </span>
            </Show>
            <span class="sub">
              {sel()!.model} · {sel()!.session}/{sel()!.branch} · turns {sel()!.stats.turns} · tools {sel()!.stats.toolCalls}
            </span>
            <span style="margin-left:auto;display:flex;gap:4px">
              <Show when={sel()!.statusReason}>
                <span class="sub" title={sel()!.statusReason}>ℹ</span>
              </Show>
              <button class="iconbtn" title="terminal (t)" onclick={toggleTerm}>⌨</button>
              <button class="iconbtn" title="toggle details panel (d)" onclick={toggleRight}>▤</button>
            </span>
          </header>

          <div class="feed" onscroll={(e) => {
            const el = e.currentTarget;
            const nb = nearBottom();
            if (nb && missed()) setMissed(0);
            setAtBottom(nb);
            // reached the top → pull the next older page (infinite scroll up)
            if (el.scrollTop <= 4 && selected() && !loadingOlder() && !olderDone() && events().length > 0) {
              void loadOlder();
            }
          }}>
            <Show when={olderDone() && chatEvents().length > 0}>
              <div class="divider-msg">── beginning of log ──</div>
            </Show>
            <Show when={loadingOlder()}>
              <div class="divider-msg">loading older events…</div>
            </Show>
            <Show when={chatEvents().length > 0} fallback={
              <div style="display:grid;place-items:center;height:100%" class="muted">no events yet — say something or press ▶ start</div>
            }>
              <For each={chatEvents()}>
                {(e, i) => (
                  <MessageRow
                    e={e}
                    prev={chatEvents()[i() - 1]}
                    res={pairInfo().resFor.get(e.id)}
                    onOption={(t) => void sendText(t)}
                    onEdit={
                      e.type === "prompt" && e.data?.source === "user"
                        ? () => setEditing({ eventId: e.id, text: String(e.data?.text ?? "") })
                        : undefined
                    }
                  />
                )}
              </For>
              <Show when={live()}>
                <div class="msg live">
                  <div class="avatar" style="background:#5865f233;border:1px solid #5865f266">🫖</div>
                  <div class="msg-body">
                    <div class="msg-head">
                      <span class="author" style="color:var(--acc)">agent</span>
                      <span class="ts">streaming…</span>
                    </div>
                    <Show when={live()!.reasoning}>
                      <details class="reasoning">
                        <summary>💭 reasoning</summary>
                        <div class="mono">{live()!.reasoning}</div>
                      </details>
                    </Show>
                    <Show
                      when={liveText()}
                      fallback={<div class="content muted">thinking…</div>}
                    >
                      <div class="content" innerHTML={renderMarkdown(liveText() + "▍")} />
                    </Show>
                  </div>
                </div>
              </Show>
            </Show>
          </div>

          <Show when={!atBottom() || missed() > 0}>
            <button class="jump" onclick={() => scrollBottom(true)}>
              ↓ {missed() > 0 ? `${missed()} new message${missed() > 1 ? "s" : ""}` : "jump to present"}
            </button>
          </Show>

          <Show when={termOpen()}>
            <div class="termdrawer" style={{ height: `${termHeight()}px` }}>
              <div class="termgrip" onpointerdown={startGrip} ondblclick={() => { setTermHeight(Math.max(220, Math.round(window.innerHeight * 0.35))); localStorage.setItem("teapot.termH", String(termHeight())); }} title="drag to resize · double-click to reset" />
              <div class="termbar">
                <div class="termtabs">
                  <For each={termTabs()}>
                    {(t, i) => (
                      <span
                        class={"termtab" + (focusedPane() === 0 && paneL() === i() ? " active" : "") + (splitView() && focusedPane() === 1 && paneR() === i() ? " active" : "")}
                        onclick={() => focusTab(i())}
                        title={`${t.title} — click to show in focused pane`}
                      >
                        ⌨ {t.title}
                        <button class="tabx" onclick={(e) => { e.stopPropagation(); closeTab(i()); }} title="close this shell">✕</button>
                      </span>
                    )}
                  </For>
                  <button class="iconbtn" title="new shell in this workspace (max 2 per agent)" onclick={addFromSelected}>＋</button>
                </div>
                <div style="display:flex;gap:4px;align-items:center">
                  <span class="muted mono" style="flex:1;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    {activeTab() ? agents().find((a) => a.id === activeTab()!.agentId)?.workspace.split("/").filter(Boolean).pop() : sel()?.workspace}
                  </span>
                  <button class="iconbtn" title={splitView() ? "single pane" : "split panes (50/50)"} onclick={toggleSplit}>◫</button>
                  <button class="iconbtn" title="close terminal (t)" onclick={toggleTerm}>✕</button>
                </div>
              </div>
              <div class="termbody" classList={{ split: splitView() }}>
                <div class="termpane" classList={{ focused: focusedPane() === 0 }} onpointerdown={() => setFocusedPane(0)} ref={setPaneHost(0)}>
                  <Show when={!activeTab() || (focusedPane() === 0 && paneL() === -1)}>
                    <div class="termempty muted">no shell here — ＋ opens one, tabs fill the focused pane</div>
                  </Show>
                </div>
                <Show when={splitView()}>
                  <div class="termsplit" />
                  <div class="termpane" classList={{ focused: focusedPane() === 1 }} onpointerdown={() => setFocusedPane(1)} ref={setPaneHost(1)}>
                    <Show when={paneR() === -1 || termTabs().length <= paneR()}>
                      <div class="termempty muted">no shell here — click a tab or ＋ to add</div>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
          </Show>

          <div class="composer">
            <Show when={suggestions().length > 0}>
              <div class="cmds">
                <For each={suggestions()}>
                  {(s, i) => (
                    <div
                      class={"cmdrow" + (i() === cmdIdx() ? " active" : "")}
                      title={s.title}
                      onclick={() => { setDraft(s.insert); setCmdIdx(-1); }}
                    >
                      <b class="mono">{s.insert.trim()}</b>
                      <span class="muted">{s.title}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={mentionMatches().length > 0}>
              <div class="cmds">
                <For each={mentionMatches()}>
                  {(m) => (
                    <div class="cmdrow" title={m.label} onclick={() => { setDraft(`@${m.key} `); setCmdIdx(-1); }}>
                      <b>@{m.key}</b>
                      <span class="muted">{m.label}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <form onsubmit={send}>
              <textarea
                ref={composerEl}
                rows={1}
                placeholder={`message #${sel()!.id} — / for commands`}
                value={draft()}
                oninput={(e) => {
                  setDraft(e.currentTarget.value);
                  setCmdIdx(0); // highlight first suggestion while popup is open
                  autosizeComposer();
                }}
                onkeydown={(e) => {
                  // unified suggestion navigation — the input keeps focus, the
                  // highlighted row just moves (↑↓), Tab/Enter accepts
                  const sugg = suggestions();
                  if (sugg.length > 0 && e.key === "ArrowDown") {
                    e.preventDefault();
                    setCmdIdx((i) => Math.min(i + 1, sugg.length - 1));
                    return;
                  }
                  if (sugg.length > 0 && e.key === "ArrowUp") {
                    e.preventDefault();
                    setCmdIdx((i) => Math.max(i - 1, 0));
                    return;
                  }
                  if (sugg.length > 0 && (e.key === "Tab" || e.key === "Enter") && !e.shiftKey && cmdIdx() >= 0) {
                    e.preventDefault();
                    setDraft(sugg[cmdIdx()]!.insert);
                    setCmdIdx(-1);
                    return;
                  }
                  if (e.key === "Escape" && sugg.length > 0) {
                    setCmdIdx(-1); // close popup only
                    return;
                  }
                  // IME composition: Enter confirms the conversion, never sends
                  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                    e.preventDefault();
                    void send(e);
                  }
                }}
              />
              <Show when={draft().startsWith("@") && draft().includes(" ")}>
                <label
                  class="forkchip"
                  title="inherit the conversation prefix byte-exactly — the sub-agent's provider prefix cache starts warm"
                >
                  <input type="checkbox" checked={mentionFork()} onchange={(e) => setMentionFork(e.currentTarget.checked)} />
                  fork ctx
                </label>
              </Show>
              <button type="submit">send</button>
            </form>
            <div class="hint">
              {flash() ||
                "enter send · shift+enter newline · ↑↓ sessions · / commands & focus · t terminal · d panel · esc interrupt · messages sent while the agent works queue up and land at the next turn boundary"}
            </div>
          </div>
        </Show>
      </section>

      {/* ---------- right bar ---------- */}
      <aside class={"rightbar" + (showRight() ? " open" : "")}>
        <Show when={sel()}>
          <h3 title="identity + storage locations for this agent">🎛 session</h3>
          <div class="card sesscard">
            <div class="sessrow"><span class="k">agent</span><b>{sel()!.id}</b><span class={`badge ${sel()!.status}`}>{sel()!.status}</span></div>
            <div class="sessrow"><span class="k">workspace</span><span class="mono ellip" title={sel()!.workspace}>{sel()!.workspace}</span></div>
            <div class="sessrow"><span class="k">session</span><span class="mono">{sel()!.session}/{sel()!.branch}</span></div>
          </div>

          <FilesPanel agentId={sel()!.id} workspace={sel()!.workspace} />

          <h3 title="switch provider/model live — applies from the agent's next turn; the list shows context window & pricing from the provider">🧦 model</h3>
          <div class="modelbox">
            <select
              value={modelProvider()}
              onchange={(e) => { setModelProvider(e.currentTarget.value); loadModels(e.currentTarget.value); }}
              title="provider (OpenAI-compatible endpoint)"
            >
              <For each={providerList()}>{(p) => <option value={p}>{p}{p === cfg().defaultProvider ? " ★" : ""}</option>}</For>
            </select>
            <div style="display:flex;gap:4px">
              <input
                type="text"
                list="model-list"
                placeholder={sel()!.model}
                value={modelDraft()}
                oninput={(e) => setModelDraft(e.currentTarget.value)}
                style="flex:1;min-width:0"
              />
              <datalist id="model-list">
                <For each={models()}>{(m) => <option value={m.id} />}</For>
              </datalist>
              <button
                title="apply to this session — takes effect from the agent's next turn"
                onclick={async (e) => {
                  if (!selected()) return;
                  const btn = e.currentTarget as HTMLButtonElement;
                  btn.disabled = true;
                  try {
                    await api(`/api/agents/${selected()}/model`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        provider: modelProvider(),
                        model: modelDraft().trim() || undefined,
                        // pass the provider-reported window so the runtime
                        // gauge + derived compaction budget work immediately
                        contextWindowTokens:
                          models().find((m) => m.id === (modelDraft().trim() || undefined))?.contextLength,
                      }),
                    });
                    btn.textContent = "✓ applied";
                    refreshAgents();
                  } catch (ex) {
                    alert(`model switch failed: ${(ex as Error).message}`);
                  } finally {
                    setTimeout(() => { btn.textContent = "apply"; btn.disabled = false; }, 1200);
                  }
                }}
              >apply</button>
            </div>
            <div class="meta">
              current: {sel()!.model}<Show when={models().length}> · {models().length} models loaded</Show>
            </div>
            <Show when={modelSpec()}>
              <div class="meta" style="color:var(--fg)">{modelSpec()}</div>
            </Show>
          </div>

          <h3>⏯ controls</h3>
          <div class="btnrow">
            <Show
              when={sel()!.status === "running"}
              fallback={
                <button class="runbtn" onclick={act("/start")} title="run toward the goal (starts the loop)">
                  ▶ start
                </button>
              }
            >
              <button
                class="danger"
                onclick={act("/stop")}
                title="interrupt: aborts the current LLM call; the running tool finishes first"
              >
                ■ stop
              </button>
            </Show>
            <button
              title="branch off the conversation here — try things without disturbing the main line"
              onclick={() => api(`/api/agents/${sel()!.id}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(() => select(sel()!.id))}
            >⑂ fork</button>
            <button onclick={async () => {
              const id = selected();
              if (!id || !confirm(`remove agent ${id}? (log is kept)`)) return;
              await api(`/api/agents/${id}`, { method: "DELETE" }).catch(() => {});
              const rest = agents().filter((a) => a.id !== id);
              setAgents(rest);
              if (rest[0]) select(rest[0].id);
              else { setSelected(null); setEvents([]); }
              }} title="remove agent from teapot (session log stays on disk)">🗑 remove</button>
              <Show when={agents().some((a) => a.parent === selected())}>
                <button
                  onclick={async () => {
                    if (!selected()) return;
                    const r = await api(`/api/agents/${selected()}/stop-children`, { method: "POST" });
                    flashHint(`stopped: ${((r as any).stopped ?? []).join(", ") || "(none)"}`);
                    refreshAgents();
                  }}
                  title="stop every sub-agent this agent spawned (descendants included)"
                >⏹ subs</button>
              </Show>
          </div>
          <div class="ctrlrow">
            <label
              title="auto-continue fires after a round ONLY when all hold: ① this toggle is on ② a goal is set and its status is 'active' ③ the round ended cleanly (no error / not stopped). It stops when the goal is marked done, or if you press ■ stop. Sending any prompt also starts an idle agent regardless."
            >
              <input
                type="checkbox"
                checked={sel()!.autoContinue ?? true}
                onchange={(e) => {
                  if (!selected()) return;
                  api(`/api/agents/${selected()}/auto-continue`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ value: e.currentTarget.checked }),
                  }).then(refreshAgents);
                }}
              />
              auto-continue
            </label>
            <span class="muted">loops while goal is active · stops on done / stop</span>
          </div>

          <h3 title="what the agent is working toward — auto-continue keeps looping while the status is 'active'">🎯 goal
            <span class={`badge ${sel()!.goal.status === "active" ? "running" : sel()!.goal.status}`}>{sel()!.goal.status}</span>
          </h3>
          <div class="statrow" style="margin-bottom:6px">
            <span class="k">status</span>
            <For each={["active", "done", "paused"] as const}>
              {(s) => (
                <button
                  class={"goalstate" + (sel()!.goal.status === s ? ` on ${s}` : "")}
                  disabled={sel()!.goal.status === s}
                  title={
                    s === "active"
                      ? "agent keeps working toward the goal (with auto-continue)"
                      : s === "done"
                        ? "mark achieved — auto-continue stops"
                        : "parked on purpose — resume by setting active again"
                  }
                  onclick={() => {
                    if (!selected()) return;
                    api(`/api/agents/${selected()}/goal`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ status: s }),
                    }).then(refreshAgents);
                  }}
                >{s === "active" ? "▶ working" : s === "done" ? "✓ done" : "⏸ paused"}</button>
              )}
            </For>
          </div>
          <Show
            when={sel()!.goal.text}
            fallback={<div class="card muted">no goal yet — write one below and press ✓ save. Then ▶ start (or any message) sets it in motion.</div>}
          >
            <div class="card">
              <div class="content" innerHTML={renderMarkdown(String(sel()!.goal.text))} />
            </div>
          </Show>
          <div class="muted" style="font-size:11px;margin-top:4px">
            stored with the session · the agent reads it via get_goal() · auto-continue loops while status is "working" and stops when marked done
          </div>
          <form onsubmit={setGoal} style="display:flex;flex-direction:column;gap:6px;margin-top:8px;margin-bottom:6px">
            <textarea
              id="goal-input"
              rows={3}
              placeholder="set new goal…"
              style="background:var(--bg-darkest);border:none;border-radius:6px;padding:6px 8px;color:var(--fg);font:inherit;width:100%;resize:vertical"
            />
            <div style="display:flex;justify-content:flex-end;align-items:center;gap:10px">
              <label
                class="muted"
                style="display:flex;align-items:center;gap:4px;font-size:11.5px;white-space:nowrap;cursor:pointer"
                title="queue a harness prompt telling the agent about the new goal at its next turn boundary"
              >
                <input id="goal-notify" type="checkbox" checked /> notify agent
              </label>
              <button type="submit" style="background:var(--acc);border:none;border-radius:6px;color:#fff;padding:4px 12px;cursor:pointer">✓ save goal</button>
            </div>
          </form>

          <h3 title="todo.md — a shared checklist in the session dir. Write tasks like '- [ ] fix login'; the agent ticks them off via set_todo, you edit here. With notify on, it's told at its next turn boundary.">
            ✅ tasks
            <Show when={todoStats().total > 0}>
              <span class="badge" style={todoStats().done === todoStats().total ? "color:var(--ok)" : "color:var(--warn)"}>
                {todoStats().done}/{todoStats().total} done
              </span>
            </Show>
            <span class="muted" style="text-transform:none;letter-spacing:0">· shared checklist (you + agent)</span>
          </h3>
          <Show when={todoStats().total > 0}>
            <div class="bartrack" style="margin-bottom:6px">
              <div
                class={"barfill " + (todoStats().done === todoStats().total ? "" : "warn")}
                style={{ width: `${Math.round((todoStats().done / todoStats().total) * 100)}%` }}
              />
            </div>
          </Show>
          <textarea
            id="todo-input"
            class="mono"
            rows={5}
            placeholder={"- task one\n- task two"}
            value={todoDraft()}
            oninput={(e) => {
              setTodoDraft(e.currentTarget.value);
              setTodoDirty(true);
            }}
            title="shared with the agent — it may check items off via set_todo; your unsaved edits win until you save"
            style="width:100%;background:var(--bg-darkest);border:none;border-radius:6px;padding:6px 8px;color:var(--fg);font-family:ui-monospace,Menlo,monospace;font-size:12.5px;resize:vertical"
          />
          <div style="display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:4px">
            <label
              class="muted"
              style="display:flex;align-items:center;gap:4px;font-size:11.5px;white-space:nowrap;cursor:pointer"
              title="queue a harness prompt telling the agent the task list changed"
            >
              <input id="todo-notify" type="checkbox" checked /> notify agent
            </label>
            <button
              onclick={saveTodo}
              style="background:var(--ok);border:none;border-radius:6px;color:#fff;padding:4px 12px;cursor:pointer"
            >✓ save tasks</button>
          </div>

          <h3 title="latest report_progress snapshot. The harness asks for one after real activity (time AND output gates); errors show under ⚠ problems">📈 progress</h3>
          <Show
            when={sel()!.latestProgress}
            fallback={<div class="muted">none yet — the harness asks for a report after real activity, and the agent can report_progress anytime</div>}
          >
            {(p) => (
              <div class="card prog">
                <div class="progrow"><b>doing</b><span>{p().doing}</span></div>
                <Show when={p().recent}><div class="progrow"><b>recent</b><span>{p().recent}</span></div></Show>
                <Show when={p().problems}><div class="progrow warn"><b>⚠ problems</b><span>{p().problems}</span></div></Show>
                <Show when={p().next}><div class="progrow"><b>next</b><span>{p().next}</span></div></Show>
                <Show when={p().goalStatus}><div class="progrow"><b>goal</b><span>{p().goalStatus}</span></div></Show>
                <div class="meta muted">{relTime(p().ts)}</div>
              </div>
            )}
          </Show>

          <h3 title="cumulative billed totals · the cached pill counts tokens served from the provider's prompt cache (far cheaper) · context bar turns orange ≥70% and red ≥85% of the model window">📊 runtime</h3>
          <div class="card runcard">
            <div class="statgrid">
              <div class="stat" title="LLM turns taken this session"><span>turns</span><b>{sel()!.stats.turns}</b></div>
              <div class="stat" title="tool calls executed"><span>tools</span><b>{sel()!.stats.toolCalls}</b></div>
              <div class="stat" title="times old turns were summarized to free context"><span>compacted</span><b>{sel()!.stats.compactions ?? 0}</b></div>
            </div>
            <div class="statrow">
              <span class="k">tokens</span>
              <b>{fmtK(sel()!.stats.inputTokens)} in / {fmtK(sel()!.stats.outputTokens)} out</b>
              <Show when={(sel()!.stats.cachedInputTokens ?? 0) > 0}>
                <span
                  class="pill ok"
                  title={`${fmtK(sel()!.stats.cachedInputTokens)} tokens were served from the provider's prompt cache — billed far cheaper than fresh input`}
                >
                  ⚡ {Math.round((sel()!.stats.cachedInputTokens / Math.max(1, sel()!.stats.inputTokens)) * 100)}% cached
                </span>
              </Show>
            </div>
            <Show
              when={sel()!.ctx}
              fallback={
                <div class="statrow">
                  <span class="k">context</span>
                  <span class="muted">no window known for this model yet</span>
                </div>
              }
            >
              {(c) => {
                // find model metadata for actual context window
                const modelMeta = models().find((m) => m.id === sel()!.model);
                const effectiveWindow = c().window || modelMeta?.contextLength || 0;
                const pct = effectiveWindow
                  ? Math.min(999, Math.round((c().usedTokens / effectiveWindow) * 100))
                  : 0;
                const cls =
                  !effectiveWindow ? "" : pct >= 85 ? "crit" : pct >= 70 ? "warn" : "ok";
                return (
                  <div
                    class="ctxblock"
                    title="estimated live context vs the model's real window. Past the window, old turns are summarized into notes (compaction); the compact line below shows where that starts."
                  >
                    <div class="statrow">
                      <span class="k">context</span>
                      <b>~{fmtK(c().usedTokens)} tok</b>
                      <Show when={effectiveWindow}>
                        <span class={`pill ${cls}`}>
                          {pct}% of {fmtK(effectiveWindow)}
                        </span>
                      </Show>
                    </div>
                    <Show when={effectiveWindow}>
                      <div class="bartrack">
                        <div class={`barfill ${cls}`} style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                    </Show>
                    <div class="muted" style="font-size:11px;margin-top:4px">
                      compaction starts around ~{fmtK(c().compactAt)} tok — older turns get summarized, recent ones stay intact
                    </div>
                  </div>
                );
              }}
            </Show>
          </div>

          <h3>🌿 branches <span class="muted" style="text-transform:none;letter-spacing:0">· click to filter the feed</span></h3>
          <For each={branches()}>
            {(b) => (
              <div
                class={"branch-row" + (b.branch === sel()!.branch || b.branch === branchFilter() ? " cur" : "")}
                title={b.branch === branchFilter() ? "click to show all branches again" : `show only ${b.branch}`}
                onclick={() => {
                  const next = branchFilter() === b.branch ? null : b.branch;
                  setBranchFilter(next);
                  if (selected()) loadEvents(selected()!);
                }}
              >
                <span>{b.branch}{b.branch === sel()!.branch ? " (current)" : ""}</span>
                <span>{b.events} events</span>
              </div>
            )}
          </For>

          <h3>⏰ schedule <span class="muted" style="text-transform:none;letter-spacing:0">· cron tasks, all agents · edit in settings</span></h3>
          <Show
            when={tasks().length > 0}
            fallback={<div class="muted">no scheduled tasks — add them in ⚙ settings ("scheduled tasks")</div>}
          >
            <For each={tasks()}>
              {(t) => (
                <div
                  class={"sched-row" + (t.agent === selected() ? " cur" : "")}
                  title={`${oneLine(t.prompt, 200)}\nclick to open #${t.agent}`}
                  onclick={() => select(t.agent)}
                >
                  <div class="sched-top">
                    <b>{t.id}</b>
                    <span class="muted">@{t.agent}</span>
                    <Show when={t.forked}><span title="runs on a forked branch so chatter stays off the main line">⑂</span></Show>
                  </div>
                  <div class="sched-meta mono">
                    {t.schedule} → next {t.next ? relTime(t.next) : "—"}{t.last ? ` · last ${relTime(t.last)}` : " · never ran"}
                  </div>
                  <div class="sched-prompt muted">{oneLine(t.prompt, 90)}</div>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </aside>
    </div>
    </Show>
    <Show when={showNew()}>
      <NewAgentModal
        providers={Object.keys(cfg().providers ?? {})}
        onClose={() => setShowNew(false)}
        onCreated={(id) => { setShowNew(false); refreshAgents(); select(id); }}
      />
    </Show>
    <Show when={showCfg()}>
      <ConfigModal cfg={cfg()} onClose={() => setShowCfg(false)} onSaved={() => { loadCfg(); loadTasks(); }} />
    </Show>
    <Show when={editing()} fallback={null}>
      {(ed) => {
        const idx = () => events().findIndex((e) => e.id === ed().eventId);
        const afterCount = () => Math.max(0, events().length - idx() - 1);
        const [tail, setTail] = createSignal<"summarize" | "discard">(afterCount() > 0 ? "summarize" : "discard");
        return (
          <Modal title="edit prompt — forks the conversation" onClose={() => setEditing(null)}>
            <form
              onsubmit={async (ev) => {
                ev.preventDefault();
                const ta = document.getElementById("edit-text") as HTMLTextAreaElement;
                try {
                  await api(`/api/agents/${selected()}/edit-prompt`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ eventId: ed().eventId, text: ta.value, tail: tail() }),
                  });
                  setEditing(null);
                  refreshAgents();
                  const id = selected();
                  if (id) await select(id);
                } catch (ex) {
                  alert(`edit failed: ${(ex as Error).message}`);
                }
              }}
              style="display:flex;flex-direction:column;gap:10px"
            >
              <textarea id="edit-text" class="mono w100" rows={6} value={ed().text} />
              <Show when={afterCount() > 0}>
                <div>
                  <div style="font-size:12.5px;margin-bottom:4px">
                    {afterCount()} event(s) came after this prompt — what should happen to them on the new branch?
                  </div>
                  <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--fg)">
                    <input type="radio" name="tail" checked={tail() === "summarize"} onchange={() => setTail("summarize")} />
                    summarize them into a note the agent can still read
                  </label>
                  <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--fg)">
                    <input type="radio" name="tail" checked={tail() === "discard"} onchange={() => setTail("discard")} />
                    discard them entirely (clean timeline)
                  </label>
                </div>
              </Show>
              <div style="display:flex;justify-content:flex-end;gap:8px">
                <button type="button" onclick={() => setEditing(null)}>cancel</button>
                <button type="submit" style="background:var(--acc);border:none;border-radius:6px;color:#fff;padding:6px 12px;cursor:pointer">
                  ⑂ fork & resend
                </button>
              </div>
            </form>
          </Modal>
        );
      }}
    </Show>
    </>
  );
}

/* ---------- one chat message row ---------- */
/* ---------- per-tool timeline rendering ---------- */

function ToolRow(props: { e: Ev; res?: Ev }) {
  const e = props.e;
  const res = props.res;
  const d = e.data ?? {};
  const name = String(d.name ?? "tool");
  const out = () => (res ? String(res.data?.result ?? "") : "");

  // per-tool summary line: [icon, label, hint]
  let icon = "⚙";
  let label = name;
  let hint = "";
  let body: any = <div class="mono">{truncate(JSON.stringify(d.args ?? {}, null, 1), 2000)}</div>;

  const argStr = (k: string) => String(d.args?.[k] ?? "");
  const codeBlock = (text: string, max = 1500) => (
    <pre class="mono toolbody">{truncate(text, max)}</pre>
  );
  const resultBlock = (max = 4000) =>
    res ? (
      <>
        {codeBlock(out(), max)}
        <div class="meta">
          {res.data?.durationMs}ms{res.data?.ok === false ? " · FAILED" : ""}
          <CopyBtn text={out()} />
        </div>
      </>
    ) : (
      <div class="meta">waiting for output…</div>
    );

  try {
    switch (name) {
      case "bash": {
        const cmd = argStr("command");
        label = "$ " + oneLine(cmd, 96);
        hint = argStr("timeout_ms") ? `timeout ${Math.round(Number(argStr("timeout_ms")) / 1000)}s` : "";
        body = (
          <>
            {cmd !== label.slice(2) ? codeBlock(cmd, 800) : null}
            {resultBlock(6000)}
          </>
        );
        break;
      }
      case "read_file": {
        label = argStr("path") || "(no path)";
        const bits: string[] = [];
        if (argStr("pattern")) bits.push(`grep /${oneLine(argStr("pattern"), 40)}/`);
        if (Number(d.args?.offset) < 0) bits.push(`last ${-Number(d.args.offset)} lines`);
        else if (d.args?.offset) bits.push(`from L${d.args.offset}`);
        if (d.args?.limit) bits.push(`≤${d.args.limit} lines`);
        hint = bits.join(" · ");
        body = resultBlock(6000);
        break;
      }
      case "write_file": {
        const content = String(d.args?.content ?? "");
        label = argStr("path") || "(no path)";
        hint = `${content.length} bytes`;
        body = (
          <>
            {codeBlock(content)}
            {res ? <div class="meta">{oneLine(out(), 160)}</div> : <div class="meta">writing…</div>}
          </>
        );
        break;
      }
      case "edit_file": {
        label = argStr("path") || "(no path)";
        hint = d.args?.replace_all === true ? "replace all" : "unique spot";
        body = (
          <>
            <pre class="mono toolbody del">{truncate("- " + argStr("old_text"), 900)}</pre>
            <pre class="mono toolbody add">{"+ " + truncate(argStr("new_text"), 900)}</pre>
            {res ? (
              <div class="meta">
                {oneLine(out(), 120)} · {res.data?.durationMs}ms
              </div>
            ) : (
              <div class="meta">applying…</div>
            )}
          </>
        );
        break;
      }
      case "apply_patch": {
        const patchLines = argStr("patch").split("\n").filter((l) => l && !/^---$/.test(l.trim()));
        const files = patchLines
          .map((l) => l.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)?.[1])
          .filter(Boolean) as string[];
        label = files.length ? `${files.length} file${files.length > 1 ? "s" : ""}: ${oneLine(files.join(", "), 80)}` : "patch";
        body = (
          <>
            <pre class="mono toolbody patch">
              {patchLines.map((l) => {
                const cls = l.startsWith("+") ? " add" : l.startsWith("-") ? " del" : /^\*\*\*|^@@/.test(l) ? " meta" : "";
                return <div class={"pline" + cls}>{l.length > 240 ? l.slice(0, 240) + "…" : l}</div>;
              })}
            </pre>
            {res ? <div class="meta">{oneLine(out().split("\n")[0] ?? "", 140)}{res.data?.ok === false ? " · FAILED" : ""}</div> : <div class="meta">validating…</div>}
          </>
        );
        break;
      }
      case "list_dir": {
        label = argStr("path") || ".";
        body = resultBlock(4000);
        break;
      }
      case "read_url": {
        let host = argStr("url");
        try { const u = new URL(host); host = u.host + u.pathname; } catch { /* keep raw */ }
        label = oneLine(host, 70);
        hint = "web";
        body = (
          <>
            <div class="meta">
              <Show
                when={/^https?:/i.test(argStr("url"))}
                fallback={<span class="muted">{oneLine(argStr("url"), 80)}</span>}
              >
                <a href={argStr("url")} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">open ↗</a>
              </Show>
            </div>
            {resultBlock(3000)}
          </>
        );
        break;
      }
      case "load_skill": {
        label = `skill: ${argStr("name")}`;
        const mdBody = out().replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""); // strip frontmatter
        body = res ? (
          <>
            <div class="content" innerHTML={renderMarkdown(mdBody)} />
            <div class="meta">{res.data?.durationMs}ms</div>
          </>
        ) : (
          <div class="meta">loading…</div>
        );
        break;
      }
      case "save_skill": {
        label = `skill: ${argStr("name")}`;
        hint = oneLine(argStr("description"), 60);
        const files = Array.isArray(d.args?.files) ? d.args.files.map((f: any) => f?.name).filter(Boolean) : [];
        body = (
          <>
            {files.length ? <div class="meta">bundled: {files.join(", ")}</div> : null}
            {res ? <div class="meta">{oneLine(out(), 160)} · {res.data?.durationMs}ms</div> : <div class="meta">saving…</div>}
          </>
        );
        break;
      }
    }
  } catch {
    /* fall back to the generic view on anything unexpected */
  }

  return (
    <details
      class={"embed" + (res ? (res.data?.ok === false ? " fail" : " done") : " running")}
      title={`${name}${hint ? " — " + hint : ""}`}
    >
      <summary>
        <b>{icon} {label}</b>
        <Show when={e.data?.actor}>
          <span class="actor">@{String(e.data.actor)}</span>
        </Show>
        <span class="meta">{res ? hint || "" : "running…"}</span>
      </summary>
      {body}
    </details>
  );
}

function MessageRow(props: { e: Ev; prev?: Ev; res?: Ev; onEdit?: () => void; onOption?: (text: string) => void }) {
  const e = props.e;
  const a = authorOf(e);
  const grouped =
    props.prev && props.prev.type === e.type &&
    authorOf(props.prev).name === a.name && // don't group you/harness/scheduler together
    e.session === props.prev.session && e.branch === props.prev.branch;

  // non-chat-looking events become divider lines
  if (e.type === "fork") {
    const d = e.data ?? {};
    return (
      <div class="divider-msg">
        ⑂ forked from {String(d.fromBranch ?? "?")} → {String(d.newBranch ?? e.branch)}
      </div>
    );
  }
  if (e.type === "goal") {
    const d = e.data ?? {};
    const what = d.event === "status" ? `marked ${String(d.status ?? "")}` : oneLine(String(d.text ?? ""), 80);
    return <div class="divider-msg">🎯 goal {String(d.event ?? "")}: {what}</div>;
  }
  if (e.type === "todo") {
    return <div class="divider-msg">✅ tasks updated ({String(e.data?.by ?? "human")})</div>;
  }
  if (e.type === "state") {
    if (e.data.from === e.data.to) return null;
    return (
      <div class={"divider-msg" + (e.data.to === "error" ? " err" : "")}>
        {e.data.from} → {e.data.to}{e.data.reason ? ` — ${e.data.reason}` : ""}
      </div>
    );
  }

  return (
    <div class={"msg" + (grouped ? " grouped" : "") + (e.data?.pending ? " pending" : "")}>
      <Show when={!grouped} fallback={<span style="width:38px" />}>
        <div class="avatar" style={{ background: a.color + "33", border: `1px solid ${a.color}66` }}>{a.icon}</div>
      </Show>
      <div class="msg-body">
        <Show when={!grouped}>
          <div class="msg-head">
            <span class="author" style={{ color: a.color }}>{a.name}</span>
            <Show when={e.data?.actor}>
              <span class="actor">@{String(e.data.actor)}</span>
            </Show>
            <span class="ts">{e.data?.pending ? "pending…" : fmtTs(e.ts)}</span>
            <span class="ts">{e.branch}</span>
            <Show when={props.onEdit}>
              <button
                class="editbtn"
                title="edit this prompt — forks the conversation here (later events are dropped or summarized)"
                onclick={(ev: MouseEvent) => { ev.stopPropagation(); props.onEdit!(); }}
              >✎ edit</button>
            </Show>
          </div>
        </Show>

        <SwitchContent e={e} res={props.res} onOption={props.onOption} />
      </div>
    </div>
  );
}

function SwitchContent(props: { e: Ev; res?: Ev; onOption?: (text: string) => void }) {
  const e = props.e;
  switch (e.type) {
    case "prompt":
      return <div class="content" innerHTML={renderMarkdown(String(e.data.text ?? ""))} />;
    case "message":
      return (
        <>
          <Show when={typeof e.data.reasoning === "string" && e.data.reasoning.trim()}>
            <details class="reasoning">
              <summary>💭 reasoning</summary>
              <div class="mono">{String(e.data.reasoning)}</div>
            </details>
          </Show>
          <div class="content" innerHTML={renderMarkdown(String(e.data.content ?? ""))} />
          <Show when={e.data.interrupted}>
            <div class="interrupted">⚠ interrupted — partial output kept</div>
          </Show>
          <Show when={e.data.final}>
            <div class="msgfoot"><CopyBtn text={String(e.data.content ?? "")} /><span>copy summary</span></div>
          </Show>
        </>
      );
    case "tool_call":
      return <ToolRow e={e} res={props.res} />;
    case "tool_result": {
      // orphan result (its call scrolled past the 300-event window)
      const out = String(e.data.result);
      return (
        <details class={"embed" + (e.data.ok ? "" : " fail")}>
          <summary>
            <span class="meta">{oneLine(out, 120)}</span>
            <CopyBtn text={out} />
          </summary>
          <div class="mono">{truncate(out, 4000)}</div>
          <div class="meta">{e.data.durationMs}ms{e.data.ok ? "" : " · FAILED"}</div>
        </details>
      );
    }
    case "decision": {
      const alts = Array.isArray(e.data?.alternatives) ? (e.data.alternatives as string[]) : [];
      return (
        <details class="embed decision">
          <summary>
            <b>📌 {oneLine(String(e.data?.decision ?? ""), 90)}</b>
            <span class="meta">decision logged</span>
          </summary>
          <div class="content"><b>Why:</b>{String(e.data?.rationale ?? "")}</div>
          <Show when={alts.length}>
            <div class="content muted">Rejected: {alts.join(" / ")}</div>
          </Show>
        </details>
      );
    }
    case "question": {
      const opts = Array.isArray(e.data?.options) ? (e.data.options as string[]) : [];
      return (
        <div class="embed question">
          <div>❓ {String(e.data?.question ?? "")}</div>
          <Show when={opts.length > 0}>
            <div class="qopts">
              <For each={opts}>
                {(o) => (
                  <button
                    class="qopt"
                    onclick={() => {
                      const actor = e.data?.actor;
                      if (actor) {
                        void api(`/api/agents/${encodeURIComponent(String(actor))}/prompt`, {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ text: o, start: true }),
                        }).then(() => flashHint(`→ answered @${String(e.data.actor)}`)).catch(() => flashHint("answer failed"));
                      } else {
                        props.onOption?.(o);
                      }
                    }}
                  >{o}</button>
                )}
              </For>
            </div>
          </Show>
          <div class="meta">the agent is waiting for your reply — answer below or tap an option</div>
        </div>
      );
    }
    case "progress":
      return (
        <div class="embed" style="border-color: var(--ok)">
          <div>📈 {String(e.data.doing ?? "")}</div>
          <Show when={e.data.recent}><div class="meta">{String(e.data.recent)}</div></Show>
          <Show when={e.data.problems}><div class="meta">⚠ {String(e.data.problems)}</div></Show>
          <Show when={e.data.next}><div class="meta">→ {String(e.data.next)}</div></Show>
        </div>
      );
    case "error":
      return <div class="embed fail"><div class="mono">⚠ {String(e.data.message ?? "")}</div></div>;
    default:
      return <div class="content muted">{truncate(JSON.stringify(e.data), 200)}</div>;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + " …" : s;
}

/** "in 5m" / "3m ago" — for schedule next/last columns */
function relTime(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const unit =
    abs < 90_000 ? `${Math.round(abs / 1000)}s`
    : abs < 5_400_000 ? `${Math.round(abs / 60_000)}m`
    : `${(abs / 3_600_000).toFixed(1)}h`;
  return ms >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** compact token counts with k/m/b suffixes: 12345 → "12k", 2.2M → "2.2m" */
function fmtK(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}b`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}m`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** single-line preview with collapsed whitespace */
function oneLine(s: string, n: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return truncate(line, n);
}

/* ---------- copy-to-clipboard button ---------- */
function CopyBtn(props: { text: string }) {
  const [done, setDone] = createSignal(false);
  return (
    <button
      class="copybtn"
      title="copy to clipboard"
      onclick={(e: MouseEvent) => {
        e.stopPropagation(); // don't toggle the enclosing <details>
        navigator.clipboard.writeText(props.text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 900);
        });
      }}
    >{done() ? "✓" : "⧉"}</button>
  );
}

/* ---------- modal shell ---------- */
function Modal(props: { title: string; onClose: () => void; children: any }) {
  return (
    <div class="overlay" onclick={(e: Event) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal">
        <div class="modal-head">
          <b>{props.title}</b>
          <button class="iconbtn" onclick={props.onClose}>✕</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

/* ---------- new agent ---------- */
function NewAgentModal(props: { providers: string[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [dir, setDir] = createSignal("~");
  const [entries, setEntries] = createSignal<string[]>([]);
  const [name, setName] = createSignal("");
  const [provider, setProvider] = createSignal(props.providers[0] ?? "");
  const [model, setModel] = createSignal("");
  const [err, setErr] = createSignal("");

  async function browse(p?: string) {
    const d = await api(`/api/fs${p ? `?path=${encodeURIComponent(p)}` : ""}`);
    setDir(d.path); setEntries(d.entries);
  }
  onMount(() => browse(dir()));

  const create = async (e: Event) => {
    e.preventDefault(); setErr("");
    try {
      const r = await api("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: dir(), id: name(), provider: provider() || undefined, model: model() || undefined }),
      });
      props.onCreated(r.agent.id);
    } catch (ex) { setErr(String((ex as Error).message)); }
  };

  return (
    <Modal title="new agent" onClose={props.onClose}>
      <form onsubmit={create} style="display:flex;flex-direction:column;gap:10px">
        <label>workspace directory
          <div style="display:flex;gap:6px">
            <input type="text" class="w100 mono" value={dir()} oninput={(e) => setDir(e.currentTarget.value)} />
            <button type="button" onclick={() => browse(dir())}>go</button>
            <button type="button" onclick={() => browse("..")}>↑</button>
          </div>
        </label>
        <div class="dirlist">
          <For each={entries()}>{(n) =>
            <div class="direntry" onclick={() => browse(`${dir()}/${n}`.replace(/\/+/g, "/"))}>📁 {n}</div>
          }</For>
        </div>
        <div style="display:flex;gap:10px">
          <label style="flex:1">agent name <input type="text" placeholder="(directory name)" value={name()} oninput={(e) => setName(e.currentTarget.value)} /></label>
          <label>provider
            <select value={provider()} onchange={(e) => setProvider(e.currentTarget.value)}>
              <For each={props.providers}>{(p) => <option>{p}</option>}</For>
            </select>
          </label>
          <label style="flex:1">model <input type="text" placeholder="(provider default)" value={model()} oninput={(e) => setModel(e.currentTarget.value)} /></label>
        </div>
        <Show when={err()}><span style="color:var(--err);font-size:13px">{err()}</span></Show>
        <button type="submit" style="align-self:flex-end">create & start</button>
      </form>
    </Modal>
  );
}

/* ---------- workspace file tree ---------- */

interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
}

function FilesPanel(props: { agentId: string; workspace: string }) {
  // path → lazily fetched child listing ("" = workspace root)
  const [kids, setKids] = createSignal<Map<string, TreeNode[]>>(new Map());
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [preview, setPreview] = createSignal<{
    path: string; content: string; binary?: boolean; truncated?: boolean;
  } | null>(null);
  const [err, setErr] = createSignal("");

  const parseEntries = (parentPath: string, list: any[]): TreeNode[] =>
    list.map((e) => ({
      name: String(e.name),
      path: parentPath ? `${parentPath}/${e.name}` : String(e.name),
      dir: !!e.dir,
      ...(typeof e.size === "number" ? { size: e.size } : {}),
    }));

  async function fetchDir(path: string): Promise<TreeNode[] | null> {
    try {
      const r = await api(
        `/api/agents/${props.agentId}/tree${path ? `?path=${encodeURIComponent(path)}` : ""}`,
      );
      return parseEntries(path, r.entries ?? []);
    } catch (ex) {
      setErr((ex as Error).message);
      return null;
    }
  }

  // reset & load the root whenever a different agent is selected
  createEffect(() => {
    void props.agentId;
    setExpanded(new Set<string>());
    const map = new Map<string, TreeNode[]>();
    setKids(map);
    void fetchDir("").then((rows) => {
      if (rows) setKids(new Map([[ "", rows ]]));
    });
  });

  const toggleDir = async (node: TreeNode) => {
    const next = new Set<string>(expanded());
    if (next.has(node.path)) {
      next.delete(node.path);
      setExpanded(next);
      return;
    }
    next.add(node.path);
    setExpanded(next);
    if (!kids().has(node.path)) {
      const rows = await fetchDir(node.path);
      if (rows) setKids((prev) => new Map(prev).set(node.path, rows));
    }
  };

  const openFile = async (node: TreeNode) => {
    try {
      const r = await api(
        `/api/agents/${props.agentId}/file?path=${encodeURIComponent(node.path)}`,
      );
      setPreview({ path: node.path, content: r.content ?? "", binary: r.binary, truncated: r.truncated });
    } catch (ex) {
      flashHint(`open failed: ${(ex as Error).message}`);
    }
  };

  const row = (node: TreeNode, depth: number): any => (
    <>
      <div
        class={"filerow" + (node.dir ? " isdir" : "")}
        style={`padding-left:${depth * 13 + 8}px`}
        onclick={() => (node.dir ? void toggleDir(node) : void openFile(node))}
        title={node.dir ? `browse ${node.path}` : `preview ${node.path}`}
      >
        <span class="ficon">{node.dir ? (expanded().has(node.path) ? "▾" : "▸") : "·"}</span>
        <span class="fname">{node.name}</span>
        <Show when={!node.dir && node.size !== undefined}>
          <span class="fsize">{fmtK(node.size!)}</span>
        </Show>
      </div>
      <Show when={node.dir && expanded().has(node.path)}>
        <For each={kids().get(node.path) ?? []}>{(child) => row(child, depth + 1)}</For>
      </Show>
    </>
  );

  const wsName = () => props.workspace.split("/").filter(Boolean).pop() ?? props.workspace;

  return (
    <>
      <h3 title="the agent's workspace — lazy-loaded, dotfiles hidden; click a folder to expand, a file to preview">
        🗂 files <span class="muted" style="text-transform:none;letter-spacing:0">· {wsName()}</span>
      </h3>
      <div class="filebox">
        <Show
          when={(kids().get("") ?? []).length > 0}
          fallback={<div class="muted" style="padding:6px">{err() || "empty workspace"}</div>}
        >
          <For each={kids().get("") ?? []}>{(node) => row(node, 0)}</For>
        </Show>
      </div>
      <Show when={preview()}>
        {(pv) => (
          <Modal title={`🗂 ${pv().path}`} onClose={() => setPreview(null)}>
            <pre class="mono" style="max-height:62vh;overflow:auto;white-space:pre-wrap;margin:0">
              {pv().binary ? "(binary file — inspect it from the terminal)" : pv().content}
              {pv().truncated ? "\n\n… truncated (first 100 KB)" : ""}
            </pre>
          </Modal>
        )}
      </Show>
    </>
  );
}

/* ---------- settings / config editor ---------- */
/* ---------- first-run setup wizard ---------- */

type ProviderPreset = {
  key: string;
  label: string;
  url: string;
  /** pre-filled model suggestion — empty means "keep what's typed" */
  model: string;
  hint?: string;
};

/**
 * Known OpenAI-compatible providers, shared by the setup wizard and the
 * settings modal's quick-add. "custom" is a wizard-only pseudo preset that
 * marks the manual path without touching any field.
 */
const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "openrouter",
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-sonnet-4",
    hint: "400+ models behind one key — teapot sends app-attribution headers automatically",
  },
  {
    key: "orcarouter",
    label: "OrcaRouter",
    url: "https://api.orcarouter.ai/v1",
    model: "orcarouter/auto",
    hint: "zero-markup routing gateway — 'orcarouter/auto' grades each prompt and picks the model",
  },
  { key: "openai", label: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  {
    key: "llamacpp",
    label: "llama.cpp server",
    url: "http://localhost:8080/v1",
    model: "",
    hint: "free & local — start it with: llama-server -m ./model.gguf  (any model name works)",
  },
];

/** the wizard shows this extra option for arbitrary OpenAI-compatible endpoints */
const CUSTOM_PRESET: ProviderPreset = {
  key: "custom",
  label: "Custom",
  url: "",
  model: "",
  hint: "any OpenAI-compatible /v1 endpoint — vLLM, LM Studio, llama.cpp, a company gateway… fill the fields below",
};

function SetupWizard(props: { onDone: () => void }) {
  const [preset, setPreset] = createSignal<ProviderPreset>(PROVIDER_PRESETS[0]);
  const [baseUrl, setBaseUrl] = createSignal(PROVIDER_PRESETS[0].url);
  const [apiKey, setApiKey] = createSignal("");
  const [model, setModel] = createSignal(PROVIDER_PRESETS[0].model);
  const [models, setModels] = createSignal<
    { id: string; contextLength?: number; pricing?: { prompt: number; completion: number } }[]
  >([]);
  const [workspace, setWorkspace] = createSignal("~/teapot-workspace");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");

  const pick = (p: ProviderPreset) => {
    setPreset(p);
    // "custom" only marks the manual path — never clobbers typed values
    if (p.key === "custom") return;
    if (p.url) {
      setBaseUrl(p.url);
      if (p.model) setModel(p.model);
    }
  };

  /** live model discovery from whatever endpoint the operator is typing —
   *  same data the main UI's model switcher shows, just pre-config */
  createEffect(() => {
    const url = baseUrl().trim();
    const key = apiKey();
    if (!/^https?:\/\//.test(url)) {
      setModels([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await api(
          `/api/setup/models?baseUrl=${encodeURIComponent(url)}${key ? `&apiKey=${encodeURIComponent(key)}` : ""}`,
        );
        setModels(r.models ?? []);
      } catch {
        setModels([]); // endpoint unreachable / no auth yet — keep typing
      }
    }, 600);
    onCleanup(() => clearTimeout(t));
  });

  /** "ctx 1m · $3/M in · $15/M out" for a model id from the fetched list */
  const specOf = (id: string) => {
    const m = models().find((x) => x.id === id.trim());
    if (!m) return "";
    const parts: string[] = [];
    if (m.contextLength) parts.push(`ctx ${fmtK(m.contextLength)} tok`);
    const price = (p?: number) =>
      p === undefined ? "" : `$${p * 1e6 >= 10 ? Math.round(p * 1e6) : +(p * 1e6).toFixed(1)}/M`;
    if (m.pricing) {
      const pin = price(m.pricing.prompt);
      const pout = price(m.pricing.completion);
      if (pin && pout) parts.push(`${pin} in · ${pout} out`);
      else if (pin || pout) parts.push(price(m.pricing.prompt ?? m.pricing.completion));
    }
    return parts.join(" · ");
  };
  const modelSpec = () => specOf(model());

  const submit = async (e: Event) => {
    e.preventDefault(); setErr(""); setBusy(true);
    try {
      await api("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: baseUrl(),
          apiKey: apiKey() || undefined,
          model: model(),
          workspace: workspace(),
          ...(password() ? { password: password() } : {}),
        }),
      });
      props.onDone();
    } catch (ex) {
      setErr((ex as Error).message); setBusy(false);
    }
  };

  return (
    <div class="overlay" style={{ background: "var(--bg-darkest)" }}>
      <div class="modal" style="max-width:560px">
        <div class="modal-head"><b>🫖 welcome to teapot</b></div>
        <p class="muted" style="margin:0 0 10px;font-size:13px">
          first run — pick an OpenAI-compatible provider and you're done.
          everything below can be changed later in ⚙ settings.
        </p>
        <form onsubmit={submit} style="display:flex;flex-direction:column;gap:12px">
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            {[...PROVIDER_PRESETS, CUSTOM_PRESET].map((p) => (
              <button
                type="button"
                class={"presetbtn" + (preset().key === p.key ? " active" : "")}
                title={p.hint || p.url}
                onclick={() => pick(p)}
              >{p.label}</button>
            ))}
          </div>
          <Show when={preset().hint}>
            <div class="muted" style="font-size:11.5px;margin-top:-6px">{preset().hint}</div>
          </Show>
          <label>base url
            <input
              type="text"
              class="w100 mono"
              list="wiz-preset-urls"
              value={baseUrl()}
              oninput={(e) => setBaseUrl(e.currentTarget.value)}
            />
            <datalist id="wiz-preset-urls">
              {PROVIDER_PRESETS.map((p) => <option value={p.url} />)}
            </datalist>
          </label>
          <label>api key <input type="password" class="w100" value={apiKey()} oninput={(e) => setApiKey(e.currentTarget.value)} placeholder="(local providers may not need one)" /></label>
          <label>default model
            <input
              type="text"
              class="w100 mono"
              list="wiz-model-list"
              value={model()}
              oninput={(e) => setModel(e.currentTarget.value)}
              placeholder={preset().key === "llamacpp" ? "(any name — serves whichever gguf is loaded)" : "(type to filter models from the endpoint)"}
            />
            <datalist id="wiz-model-list">
              {models().map((m) => <option value={m.id} />)}
            </datalist>
          </label>
          <Show
            when={models().length > 0}
            fallback={
              <div class="muted" style="font-size:11.5px;margin-top:-8px">
                models appear here automatically once the endpoint answers GET /models
              </div>
            }
          >
            <div class="muted" style="font-size:11.5px;margin-top:-8px">
              {models().length} models found at this endpoint
              <Show when={modelSpec()}> · <span style="color:var(--fg)">{modelSpec()}</span></Show>
            </div>
          </Show>
          <fieldset>
            <legend>first agent</legend>
            <label>workspace directory
              <input type="text" class="w100 mono" value={workspace()} oninput={(e) => setWorkspace(e.currentTarget.value)} />
            </label>
            <label style="margin-top:4px" title="asks for this password when opening the UI or API from another machine — plain-HTTP LAN traffic is NOT encrypted">protect the API with a password? <input type="password" class="w100" value={password()} oninput={(e) => setPassword(e.currentTarget.value)} placeholder="(optional — LAN traffic is still plain HTTP)" /></label>
          </fieldset>
          <Show when={err()}><span style="color:var(--err);font-size:13px">{err()}</span></Show>
          <button type="submit" disabled={busy()} style="background:var(--acc);border:none;border-radius:8px;color:#fff;padding:9px 14px;font-weight:600;cursor:pointer">
            {busy() ? "saving…" : "finish setup"}
          </button>
        </form>
      </div>
    </div>
  );
}

function ConfigModal(props: { cfg: any; onClose: () => void; onSaved: () => void }) {
  type PRow = { name: string; baseUrl: string; apiKey: string; model: string };
  const [providers, setProviders] = createSignal<PRow[]>(
    Object.entries(props.cfg.providers ?? {}).map(([name, v]: [string, any]) => ({
      name, baseUrl: v.baseUrl ?? "", apiKey: v.apiKey ?? "", model: v.model ?? "",
    })),
  );
  const [defaultProvider, setDefaultProvider] = createSignal(props.cfg.defaultProvider ?? "");
  const [intervalMin, setIntervalMin] = createSignal(Math.round((props.cfg.progressIntervalMs ?? 600000) / 60000));
  const [minChars, setMinChars] = createSignal(props.cfg.progressMinChars ?? 4000);
  const [ctxBudgetK, setCtxBudgetK] = createSignal(Math.round((props.cfg.contextTokenBudget ?? 96000) / 1000));
  const [ctxWinK, setCtxWinK] = createSignal(props.cfg.contextWindowTokens ? Math.round(props.cfg.contextWindowTokens / 1000) : 0);
  const [maxDepth, setMaxDepth] = createSignal(props.cfg.maxSpawnDepth ?? 3);
  const [tasks, setTasks] = createSignal<any[]>((props.cfg.tasks ?? []).map((t: any) => ({ ...t })));
  const [err, setErr] = createSignal("");

  const agentIds = () => (props.cfg.agents ?? []).map((a: any) => a.id);

  const saveProviders = (): Record<string, any> | null => {
    const out: Record<string, any> = {};
    for (const p of providers()) {
      if (!p.name.trim()) { setErr("provider name is required"); return null; }
      if (p.baseUrl && !/^https?:\/\//.test(p.baseUrl)) { setErr(`provider ${p.name}: baseUrl must start with http(s)://`); return null; }
      out[p.name.trim()] = { baseUrl: p.baseUrl, ...(p.apiKey ? { apiKey: p.apiKey } : {}), ...(p.model ? { model: p.model } : {}) };
    }
    return out;
  };

  const save = async (e: Event) => {
    e.preventDefault(); setErr("");
    const providers = saveProviders();
    if (!providers) return;
    const cleanTasks = tasks()
      .filter((t) => t.id?.trim() || t.prompt?.trim())
      .map((t, i) => ({ id: t.id?.trim() || `task-${i + 1}`, agent: t.agent, schedule: t.schedule, prompt: t.prompt, ...(t.forked ? { forked: true } : {}) }));
    for (const t of cleanTasks) {
      if (!t.agent) { setErr(`task "${t.id}": agent is required`); return; }
      if (!t.schedule?.trim()) { setErr(`task "${t.id}": schedule is required`); return; }
    }
    try {
      await api("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providers,
          defaultProvider: defaultProvider() || undefined,
          progressIntervalMs: Math.max(1, intervalMin()) * 60000,
          progressMinChars: Math.max(100, minChars()),
          contextTokenBudget: Math.max(1000, ctxBudgetK()) * 1000,
          ...(ctxWinK() > 0 ? { contextWindowTokens: ctxWinK() * 1000 } : {}),
          maxSpawnDepth: Math.max(0, maxDepth()),
          tasks: cleanTasks,
        }),
      });
      props.onSaved(); props.onClose();
    } catch (ex) { setErr((ex as Error).message); }
  };

  const numInput = (label: string, value: number, oninput: (v: number) => void, hint?: string) => (
    <label title={hint}>{label}
      <input type="number" min="0" value={value} oninput={(e) => oninput(Number(e.currentTarget.value))} />
    </label>
  );

  return (
    <Modal title="settings" onClose={props.onClose}>
      <form onsubmit={save} style="display:flex;flex-direction:column;gap:14px">
        <fieldset>
          <legend>providers</legend>
          <For each={providers()}>
            {(p, i) => (
              <div class="cfgrow">
                <input class="cfgname" placeholder="name" value={p.name} oninput={(e) => setProviders(providers().map((x, j) => (j === i() ? { ...x, name: e.currentTarget.value } : x)))} />
                <input placeholder="https://…/v1" value={p.baseUrl} oninput={(e) => setProviders(providers().map((x, j) => (j === i() ? { ...x, baseUrl: e.currentTarget.value } : x)))} />
                <input placeholder="api key" type="password" value={p.apiKey} oninput={(e) => setProviders(providers().map((x, j) => (j === i() ? { ...x, apiKey: e.currentTarget.value } : x)))} />
                <input placeholder="default model" value={p.model} oninput={(e) => setProviders(providers().map((x, j) => (j === i() ? { ...x, model: e.currentTarget.value } : x)))} />
                <button type="button" class="danger" title="remove provider" onclick={() => setProviders(providers().filter((_, j) => j !== i()))}>✕</button>
              </div>
            )}
          </For>
          <button type="button" onclick={() => setProviders([...providers(), { name: "", baseUrl: "", apiKey: "", model: "" }])}>+ add custom</button>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            <span class="muted" style="font-size:11.5px">quick-add:</span>
            <For each={PROVIDER_PRESETS}>
              {(p) => (
                <button
                  type="button"
                  title={`fill a ${p.label} row — ${p.url}${p.model ? ` (model: ${p.model})` : ""}`}
                  onclick={() => {
                    // re-click = update the existing entry instead of duplicating
                    const rest = providers().filter((x) => x.name !== p.key);
                    setProviders([...rest, { name: p.key, baseUrl: p.url, apiKey: "", model: p.model }]);
                    if (!defaultProvider()) setDefaultProvider(p.key);
                  }}
                >+ {p.label}</button>
              )}
            </For>
          </div>
          <div><label style="display:flex;align-items:center;gap:6px;margin-top:6px" title="agents without an explicit provider use this one">
            default provider
            <select
              value={defaultProvider()}
              onchange={(e) => setDefaultProvider(e.currentTarget.value)}
            >
              <option value="">(none — first provider wins)</option>
              <For each={[...new Set(providers().map((p) => p.name.trim()).filter(Boolean))]}>
                {(n) => <option value={n}>{n}</option>}
              </For>
            </select>
          </label></div>
        </fieldset>

        <fieldset>
          <legend>agent runtime</legend>
          <div class="cfggrid">
            {numInput("progress interval (min)", intervalMin(), (v) => setIntervalMin(v), "how often the harness asks for a progress report")}
            {numInput("progress min chars", minChars(), (v) => setMinChars(v), "progress prompts wait for this much real output")}
            {numInput("compact budget (k tok)", ctxBudgetK(), (v) => setCtxBudgetK(v), "auto-compact when estimated context exceeds this")}
            {numInput("context window (k tok)", ctxWinK(), (v) => setCtxWinK(v), "model's real window — 0/blank hides the % gauge")}
            {numInput("max spawn depth", maxDepth(), (v) => setMaxDepth(v), "sub-agent nesting limit (0 = no spawning)")}
          </div>
        </fieldset>

        <fieldset>
          <legend>scheduled tasks</legend>
          <Show when={tasks().length > 0}>
            <For each={tasks()}>
              {(t, i) => (
                <div class="cfgcol">
                  <div class="cfgrow">
                    <input placeholder="id" value={t.id} oninput={(e) => setTasks(tasks().map((x, j) => (j === i() ? { ...x, id: e.currentTarget.value } : x)))} />
                    <input placeholder="agent id" value={t.agent} oninput={(e) => setTasks(tasks().map((x, j) => (j === i() ? { ...x, agent: e.currentTarget.value } : x)))} />
                    <input placeholder="every 30m / cron" value={t.schedule} oninput={(e) => setTasks(tasks().map((x, j) => (j === i() ? { ...x, schedule: e.currentTarget.value } : x)))} />
                    <label style="display:flex;gap:3px;align-items:center;white-space:nowrap;color:var(--dim);font-size:11px">
                      <input type="checkbox" checked={!!t.forked} onchange={(e) => setTasks(tasks().map((x, j) => (j === i() ? { ...x, forked: e.currentTarget.checked } : x)))} />fork
                    </label>
                    <button type="button" class="danger" onclick={() => setTasks(tasks().filter((_, j) => j !== i()))}>✕</button>
                  </div>
                  <textarea rows={2} placeholder="prompt to send" value={t.prompt} oninput={(e) => setTasks(tasks().map((x, j) => (j === i() ? { ...x, prompt: e.currentTarget.value } : x)))} />
                </div>
              )}
            </For>
          </Show>
          <button type="button" onclick={() => setTasks([...tasks(), { id: "", agent: agentIds()[0] ?? "", schedule: "every 30m", prompt: "" }])}>+ add task</button>
        </fieldset>

        <fieldset>
          <legend>agents (read-only — edit config file or use +)</legend>
          <For each={props.cfg.agents ?? []}>
            {(a: any) => (
              <div class="cfgrow">
                <b>{a.id}</b><span class="muted">{a.workspace}</span>
                <Show when={a.parent}><span class="muted">🧩 sub of @{a.parent}</span></Show>
              </div>
            )}
          </For>
        </fieldset>

        <Show when={err()}><span style="color:var(--err);font-size:13px">{err()}</span></Show>
        <button type="submit" style="align-self:flex-end;background:var(--acc);border:none;border-radius:6px;color:#fff;padding:6px 14px;cursor:pointer">save settings</button>
      </form>
    </Modal>
  );
}
