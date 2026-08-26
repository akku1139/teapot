import { createSignal, onMount, onCleanup, For, Show, createMemo, createEffect } from "solid-js";
import { renderMarkdown } from "./md";

/* Rendered-markdown cache: old messages were re-parsing their whole body on
 * EVERY prepend/refresh pass (scrolling back through a long session parsed
 * the same text over and over — visibly heavy). Event content is immutable,
 * so a small LRU keyed by the source string makes repeat renders free. */
const mdCache = new Map<string, string>();
function renderMarkdownCached(src: string): string {
  const hit = mdCache.get(src);
  if (hit !== undefined) return hit;
  const html = renderMarkdown(src);
  mdCache.set(src, html);
  if (mdCache.size > 500) mdCache.delete(mdCache.keys().next().value!);
  return html;
}
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

declare const __APP_VERSION__: string;

/* ---------- types ---------- */
interface Agent {
  id: string; status: string; statusReason: string; workspace: string;
  session: string; branch: string; goal: { status: string; text: string; verify?: string; audit?: { verdict: "approved" | "changes-required"; feedback: string; at: string } };
  workspaceMissing?: boolean;
  latestProgress: any; stats: any; model: string; provider?: string;
  pendingPrompts?: number;
  todo?: string;
  parent?: string;
  autoContinue?: boolean;
  autoCompact?: boolean;
  ctx?: { usedTokens: number; compactAt: number; window: number; compactAtIsManual?: boolean; compacting?: string };
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
  "state", "error", "fork", "goal", "todo", "question", "decision", "compaction",
  "system_note",
]);
// system_note rows never RENDER, but two of them drive pending-echo state:
// prompt-delivered flips the echo to "sent" and must ALSO refresh the feed so
// the logged prompt row replaces the echo right away (otherwise the "sent ✓"
// echo lingered until some unrelated event happened to refresh the timeline)
const NOTE_FEED_TYPES = new Set(["system_note"]);
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
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not json */ }
    const detail =
      (body && typeof body === "object" && "error" in body ? String((body as any).error) : "") ||
      `${path}: HTTP ${res.status}`;
    // carry the full payload (e.g. a 409's `current` file content) to callers
    throw Object.assign(new Error(detail), { payload: body });
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
  // per-session unsent prompt drafts — switching agents preserves what each
  // one was typing instead of showing the previous session's text
  const drafts = new Map<string, string>();
  const [draft, setDraft] = createSignal(drafts.get(selected() ?? "") ?? "");
  const saveDraft = (v: string) => {
    setDraft(v);
    const id = selected();
    if (id) {
      if (v) drafts.set(id, v);
      else drafts.delete(id); // cleared input → nothing to preserve
    }
  };
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
    const active = themeAuto()
      ? sysPrefersLight()
        ? sysLightTheme()
        : sysDarkTheme()
      : fixedTheme();
    document.documentElement.dataset.theme = active;
    // light/dark appearance for components that ship their own palettes
    // (e.g. shiki dual-theme code blocks)
    document.documentElement.dataset.appearance =
      THEMES.find((t) => t.key === active)?.mode ?? "dark";
  });
  // model switcher state
  const [modelProvider, setModelProvider] = createSignal("");
  const [modelDraft, setModelDraft] = createSignal("");
  const [models, setModels] = createSignal<
    { id: string; contextLength?: number; pricing?: { prompt: number; completion: number }; modalities?: { input: string[]; output: string[] } }[]
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
  /** 📄🖼️→📄 style badge for a model's input/output modalities */
  const modalityBadge = (m?: { modalities?: { input: string[]; output: string[] } }): string => {
    const icon: Record<string, string> = {
      text: "📄", image: "🖼️", audio: "🔊", video: "🎬", file: "📎",
    };
    const side = (list?: string[]) =>
      (list ?? ["text"]).map((k) => icon[k] ?? k).join("");
    if (!m?.modalities) return "";
    return `${side(m.modalities.input)} → ${side(m.modalities.output)}`;
  };
  const modelSpec = () => {
    const id = modelDraft().trim() || sel()?.model || "";
    if (!id) return "";
    const m = models().find((x) => x.id === id);
    if (!m) return "";
    const parts: string[] = [];
    const badge = modalityBadge(m);
    if (badge && badge !== "📄 → 📄") parts.push(badge); // text-only is the default — no noise
    if (m.contextLength) parts.push(`ctx ${fmtK(m.contextLength)} tok`);
    const price = (p?: number) =>
      p === undefined ? "" : `${p * 1e6 >= 10 ? Math.round(p * 1e6) : +(p * 1e6).toFixed(1)}/M`;
    if (m.pricing) {
      const pin = price(m.pricing.prompt);
      const pout = price(m.pricing.completion);
      if (pin && pout) parts.push(`${pin} in · ${pout} out`);
      else if (pin || pout) parts.push(price(m.pricing.prompt ?? m.pricing.completion));
    }
    return parts.join(" · ");
  };
  // Keep the switcher aligned with the selected session. Keyed on STRINGS,
  // not on sel() identity: this used to re-run (and re-fetch /api/models!)
  // on every poll in which the agent's snapshot object changed — visibly
  // rebuilding the whole 🧦 model section = the "right panel flashes" bug.
  createEffect(() => {
    const id = selected();
    const a = agents().find((x) => x.id === id);
    const prov = a?.provider || cfg().defaultProvider || providerList()[0] || "";
    if (!a) return;
    if (modelProvider() !== prov) {
      setModelProvider(prov);
      loadModels(prov);
    }
    if (modelDraft()) setModelDraft(""); // clear stale draft on switch
  });
  // autoscroll: follow the tail only while the reader is already at the bottom
  const MAX_COMPOSER_H = 360; // ~15 lines expanded (was ~8 lines / 160px)
  const [composerMaximized, setComposerMaximized] = createSignal(false);
  const [atBottom, setAtBottom] = createSignal(true);
  const [missed, setMissed] = createSignal(0);
  // live compaction progress for the selected session ("summarizing 2138…")
  const [compacting, setCompacting] = createSignal<{ phase: string; summarized?: number } | null>(null);
  // the live bubble is carrying a compaction summarizer stream (prefixed by
  // the harness) rather than a normal assistant reply — render it differently
  const liveIsCompact = () => liveText().startsWith("[compact] ");
  const liveBody = () => (liveIsCompact() ? liveText().slice("[compact] ".length) : liveText());
  // a summarizer's streamed output is shown in the live bubble; clear it when
  // the pass ends so a stale "[compact] …" bubble can't outlive it
  createEffect(() => {
    if (!compacting()) setLive((l) => (l?.text.startsWith("[compact] ") ? null : l));
  });
  // ONE live buffer PER AGENT. The old single slot was clobbered by every
  // session switch (setLive(null) on select) and by the feed refresh's
  // stillStreaming heuristic — a streaming reply visibly blinked out and
  // came back, or vanished entirely after visiting another session.
  const [liveByAgent, setLiveByAgent] = createSignal<Map<string, { text: string; reasoning: string; at: number }>>(new Map());
  const live = () => {
    const id = selected();
    return id ? liveByAgent().get(id) ?? null : null;
  };
  const setLive = (patch: { text: string; reasoning: string } | null | ((cur: { text: string; reasoning: string } | null) => { text: string; reasoning: string } | null)) => {
    const id = selected();
    if (!id) return;
    setLiveByAgent((prev) => {
      const m = new Map(prev);
      const next = typeof patch === "function" ? patch(prev.get(id) ?? null) : patch;
      if (next) m.set(id, { ...next, at: Date.now() });
      else m.delete(id);
      return m;
    });
  };
  // markdown-rendered live body, throttled so per-chunk deltas don't re-parse
  // the whole (growing) text on every single WS message
  const [liveText, setLiveText] = createSignal("");
  // when the CURRENT thinking stretch started (reasoning arriving while text
  // is still empty) — powers the 💭 thinking elapsed-time readout
  const [thinkStartedAt, setThinkStartedAt] = createSignal(0);
  const liveStartedAt = () => thinkStartedAt();
  // reasoning renders from the SAME throttle tick — binding it raw re-painted
  // the (often huge) thinking block on every single chunk
  const [liveReasoning, setLiveReasoning] = createSignal("");
  let liveRenderTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const l = live();
    if (!l) {
      clearTimeout(liveRenderTimer);
      liveRenderTimer = undefined;
      setLiveText("");
      setLiveReasoning("");
      return;
    }
    if (liveRenderTimer) return; // a render is already scheduled
    liveRenderTimer = setTimeout(() => {
      liveRenderTimer = undefined;
      setLiveText(live()?.text ?? "");
      setLiveReasoning(live()?.reasoning ?? "");
      // adaptive throttle: the WHOLE text re-parses each tick, so stretch the
      // interval as it grows — long streams were re-rendering every 60ms and
      // bogging Firefox down
    }, (live()?.text.length ?? 0) > 20_000 ? 250 : (live()?.text.length ?? 0) > 6_000 ? 120 : 60);
  });
  onCleanup(() => clearTimeout(liveRenderTimer));

  // auto-scroll the feed while live output streams and we're at the bottom.
  // The old version double-checked nearBottom() inside the rAF — but the live
  // bubble has ALREADY grown by then, so the unscrolled distance exceeded the
  // threshold, "user scrolled away" was falsely detected, and follow mode
  // jittered on/off with every chunk (worse with a tall composer eating into
  // the viewport). atBottom() is only flipped by real user scrolling, so it is
  // the signal to trust here; nearBottom() would just re-measure mid-growth.
  createEffect(() => {
    // reasoning-only streams (💭 thinking, no text yet) must follow too —
    // keying the effect on liveText() alone left the feed parked while the
    // reasoning details block kept growing
    const txt = liveText();
    const rsn = live()?.reasoning ?? "";
    if (!txt && !rsn) return;
    if (!atBottom()) return;
    // wait for the DOM to paint the new text
    requestAnimationFrame(() => {
      if (atBottom()) scrollBottom(true);
    });
  });
  // Browsers pause requestAnimationFrame while a tab is hidden, so scroll
  // follow-ups for updates arriving in a background tab are silently dropped
  // — coming back showed a stale bottom line even though "follow" mode was
  // on. Re-sync once on return: jump to the tail iff the reader was still
  // following when they left. Re-armed on every session switch.
  createEffect(() => {
    const id = selected();
    if (!id) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      requestAnimationFrame(() => {
        if (nearBottom()) {
          setAtBottom(true);
          setMissed(0);
          scrollBottom(true);
        }
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisible));
  });
  const sel = createMemo(() => agents().find((a) => a.id === selected()));
  // prompt being edited → edit-prompt fork dialog
  const [editing, setEditing] = createSignal<{ eventId: string; text: string } | null>(null);
  // ask_user calls that already have their tool_result in the log — used to
  // disable the option buttons (answering twice sent duplicate prompts)
  const answeredIds = createMemo(() => {
    const set = new Set<string>();
    for (const e of events()) {
      if (e.type === "tool_result" && e.data?.name === "ask_user") set.add(String(e.data.callId));
    }
    return set;
  });
  // optimistic echoes of prompts we just sent but haven't seen in the log yet
  const [pendingMsgs, setPendingMsgs] = createSignal<
    { id: string; text: string; at: number; promptId?: string; sent?: boolean; images?: string[] }[]
  >([]);

  /* ---------- notification center (in-app only; push later) ---------- */
  type Notif = {
    id: string;
    agentId: string;
    kind: "progress" | "finish" | "question" | "error";
    title: string;
    body: string;
    at: number;
    read: boolean;
    /** source event id — clicking the notification scrolls to this row */
    eventId?: string;
  };
  const [notifs, setNotifs] = createSignal<Notif[]>([]);
  // hide 👻 ghost sessions (workspace directory missing on disk) — a toggle,
  // because they still hold history the operator may need
  const [hideGhosts, setHideGhosts] = createSignal(
    localStorage.getItem("teapot.hideGhosts") === "1",
  );
  const [showNotifs, setShowNotifs] = createSignal(false);
  const unreadCount = () => notifs().filter((n) => !n.read).length;
  /** mark all notifications from ONE session read — fired when the operator
   *  is following the timeline tail (they are, by definition, looking at the
   *  newest content those notifications point to) */
  const markSessionRead = (agentId: string) => {
    setNotifs((list) => {
      let changed = false;
      const next = list.map((n) => {
        if (n.read || n.agentId !== agentId) return n;
        changed = true;
        return { ...n, read: true };
      });
      return changed ? next : list; // avoid identity churn on no-op runs
    });
  };
  /** unread for one agent INCLUDING its whole sub-tree (subs, sub-subs…) */
  const subtreeUnread = (agentId: string): number => {
    let total = notifs().filter((n) => !n.read && n.agentId === agentId).length;
    for (const child of agents()) {
      if (child.parent === agentId)
        total += subtreeUnread(child.id);
    }
    return total;
  };
  let notifSeq = 0;
  const addNotif = (n: Omit<Notif, "id" | "at" | "read">) => {
    setNotifs((list) =>
      [{ ...n, id: `n${++notifSeq}`, at: Date.now(), read: false }, ...list].slice(0, 50),
    );
  };
  /** events worth telling the operator about, even on another session/tab */
  const maybeNotify = (agentId: string, ev: any) => {
    const who = agents().find((a) => a.id === agentId)?.id ?? agentId;
    const eid = typeof ev.id === "string" ? ev.id : undefined;
    if (ev.type === "message" && ev.data?.final === true) {
      addNotif({
        agentId,
        kind: "finish",
        title: `${who} finished`,
        body: String(ev.data.content ?? "").slice(0, 300),
        eventId: eid,
      });
    } else if (ev.type === "question") {
      addNotif({
        agentId,
        kind: "question",
        title: `${who} asks a question`,
        body: String(ev.data.question ?? "").slice(0, 300),
        eventId: eid,
      });
    } else if (ev.type === "error") {
      addNotif({
        agentId,
        kind: "error",
        title: `${who} hit an error`,
        body: String(ev.data.message ?? "").slice(0, 300),
        eventId: eid,
      });
    } else if (ev.type === "progress") {
      addNotif({
        agentId,
        kind: "progress",
        title: `${who}: ${String(ev.data.doing ?? "progress")}`.slice(0, 120),
        body: [ev.data.recent && `recent: ${ev.data.recent}`, ev.data.next && `next: ${ev.data.next}`]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 300),
        eventId: eid,
      });
    }
  };
  /** jump the timeline to a specific event row (used by notification clicks) */
  const jumpToEvent = (eventId: string) => {
    const el = document.querySelector<HTMLElement>(`[data-eid="${eventId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("flash-target");
      setTimeout(() => el.classList.remove("flash-target"), 1600);
    }
  };

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
  // A question is ANSWERED only when a real operator reply arrived AFTER it —
  // a user prompt logged later than the question event. The tool_result that
  // pairs with the question is written immediately when the question is SHOWN
  // (it parks the loop), so its mere existence never means "answered".
  const answeredQuestionIds = createMemo(() => {
    const set = new Set<string>();
    let lastQuestionAt = -1;
    let lastUserPromptAt = -1;
    for (const e of events()) {
      if (e.type === "question") lastQuestionAt = e.seq;
      else if (e.type === "prompt" && e.data?.source === "user") lastUserPromptAt = e.seq;
      else if (
        e.type === "system_note" &&
        (e.data as any)?.event === "prompt-delivered"
      )
        lastUserPromptAt = Math.max(lastUserPromptAt, e.seq);
    }
    // any user reply after the latest open question closes ALL earlier
    // questions of this session (the loop resumes on the first reply)
    if (lastQuestionAt >= 0 && lastUserPromptAt > lastQuestionAt) {
      for (const e of events())
        if (e.type === "question" && e.seq <= lastUserPromptAt)
          set.add(String((e.data as any)?.callId ?? ""));
    }
    return set;
  });
  const chatEvents = createMemo(() => {
    const { consumed } = pairInfo();
    // Reasoning-only assistant turns (content empty, only 💭 reasoning) used
    // to render as their own agent bubble between every pair of tool rows,
    // which also broke "consecutive bash" grouping. They now ride along with
    // the tool run: a reasoning-only turn is dropped when the nearest visible
    // row before it is a tool event — its thinking belongs to that action.
    const lastVisibleBefore = new Map<string, string>();
    let lastKind = "";
    for (const e of events()) {
      (e as Ev & { _prevKind?: string })._prevKind = lastKind;
      if (!FEED_TYPES.has(e.type)) continue;
      const d = e.data ?? {};
      const isCarrier =
        e.type === "message" &&
        String(d.content ?? "").trim() === "" &&
        String(d.reasoning ?? "").trim() !== "";
      if (!isCarrier) lastKind = e.type === "tool_result" ? "tool" : e.type;
    }
    const real = events().filter((e) => {
      if (!FEED_TYPES.has(e.type)) return false;
      // report_progress calls are fully rendered by the progress embed below
      // (the timeline's 📈 row + the right panel's snapshot) — the tool-call
      // row would just repeat the same content a third time
      // report_progress / ask_user calls are fully rendered by their own
      // embeds (📈 progress / ❓ question) — the tool rows would just repeat
      // the same content a second time. ask_user also shows "answered"
      // state via its embed, so the raw rows add nothing.
      const metaToolName =
        e.type === "tool_call" || e.type === "tool_result" ? String(e.data?.name ?? "") : "";
      if (metaToolName === "report_progress") return false;
      if (metaToolName === "ask_user") return false;
      // paired tool results live inside their call's merged row
      if (e.type === "tool_result") return !consumed.has(e.id);
      // tool-call carrier turns have no visible payload — the ToolRow below
      // already tells that story; an empty agent bubble is just noise
      if (e.type === "message") {
        const content = String(e.data?.content ?? "");
        // reasoning-only turn right after a tool result: the next tool row's
        // collapsible reasoning covers that thinking; a standalone bubble here
        // broke "consecutive bash" grouping (prismrv-root-7fb7533b)
        if (
          content.trim() === "" &&
          String(e.data?.reasoning ?? "").trim() !== "" &&
          (e as Ev & { _prevKind?: string })._prevKind === "tool"
        )
          return false;
        // a requested progress report is already shown by its progress embed —
        // the log keeps the message (restores need it) but the feed must not
        if (e.data?.progressEcho) return false;
        // sanitize()'s request-only placeholder leaked into old logs as an
        // "assistant said (tool call)" message; the tool rows tell that story
        if (!e.data?.final && content.trim() === "(tool call)") return false;
        return (
          content.trim() !== "" ||
          String(e.data?.reasoning ?? "").trim() !== "" ||
          !!e.data?.final
        );
      }
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
        expanded.push({ ...e, type: kind, data: { ...d?.data, actor: d?.sub } });
      } else expanded.push(e);
    }
    // DEDUPE: models often end a report_progress / record_decision turn by
    // repeating the very same content as an ordinary assistant message. When a
    // message follows its embed event (progress/decision) with essentially
    // identical text, drop the message — the embed already shows it (rendered).
    const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const deduped: Ev[] = [];
    for (let i = 0; i < expanded.length; i++) {
      const e = expanded[i]!;
      if (
        e.type === "message" &&
        e.data?.role === "assistant"
      ) {
        const prev = expanded[i - 1];
        const body = norm(e.data.content);
        if (prev?.type === "progress") {
          const p = prev.data;
          const same =
            body.includes(norm(p.doing)) ||
            (!!p.recent && body.includes(norm(p.recent)));
          if (same && body.length <= Math.max(200, norm(p.doing).length * 3)) continue;
        }
        if (prev?.type === "decision") {
          const d = prev.data;
          // the decision line is the identity — models echo it verbatim or as
          // a heading; rationale alone is too weak a signal to dedupe on
          const dec = norm(d.decision);
          if (dec && body.includes(dec) && body.length <= Math.max(300, dec.length * 3)) continue;
        }
      }
      deduped.push(e);
    }
    // append optimistic echoes. An echo lives from SEND until its text enters
    // an LLM call payload — signalled by the prompt-delivered system_note
    // (same promptId). The LOGGED prompt row appears much earlier (at enqueue
    // time), so "drop when logged" made the pending indicator flash for ~120ms
    // and vanish while the message was still queued for the model.
    //
    // When delivery happens, the logged prompt row represents the message and
    // the echo is dropped — matched by promptId so nothing duplicates.
    const deliveredIds = new Set<string>();
    const loggedUserPrompts = new Set<string>();
    for (const e of deduped) {
      const pid = (e.data as any)?.promptId;
      if (!pid) continue;
      if (e.type === "prompt" && e.data?.source === "user") loggedUserPrompts.add(String(pid));
      if (e.type === "system_note" && (e.data as any)?.event === "prompt-delivered")
        deliveredIds.add(String(pid));
    }
    const pend = pendingMsgs().filter((p) => {
      if (!p.promptId) return true;
      // delivered AND its log row exists → the log row owns the display now
      if (deliveredIds.has(p.promptId) && loggedUserPrompts.has(p.promptId)) return false;
      return true;
    });
    const echoes: Ev[] = pend.map((p) => echoEv(p));
    return [...deduped, ...echoes];
  });
  // Reference-stable echo rows: chatEvents re-runs on EVERY event burst, and
  // rebuilding the echo objects each time handed Solid's <For> a brand-new
  // reference — remounting the pending row (and, with the tail-anchor race,
  // letting it flash to the top of the viewport). Cache by id; only the
  // pending→sent flip builds a new object.
  const echoCache = new Map<string, Ev>();
  function echoEv(p: { id: string; text: string; at: number; promptId?: string; sent?: boolean; images?: string[] }): Ev {
    const key = `${p.id}:${p.sent ? "s" : "p"}`;
    const hit = echoCache.get(key);
    if (hit) return hit;
    if (echoCache.size > 64) echoCache.clear();
    const ev: Ev = {
      id: p.id,
      // sort AFTER every logged event so the echo sits at the timeline's very
      // bottom until the log catches up (same sentinel as before)
      seq: Number.MAX_SAFE_INTEGER,
      ts: new Date(p.at).toISOString(),
      session: sel()?.session ?? "",
      branch: sel()?.branch ?? "br0",
      parent: null,
      type: "prompt",
      data: {
        source: "user",
        text: p.text,
        pending: !p.sent,
        ...(p.images?.length ? { images: p.images } : {}),
        ...(p.promptId ? { promptId: p.promptId } : {}),
      },
    };
    echoCache.set(key, ev);
    return ev;
  }
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
  // false = rendered checklist (default), true = raw markdown editor
  const [todoViewMode, setTodoViewMode] = createSignal(false);
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

  const refreshAgents = () =>
    api("/api/agents")
      .then((d) =>
        setAgents((prev) => {
          // Reference-stabilize snapshots: the server re-serializes every
          // agent on each poll, and new object identities made Solid re-run
          // EVERY expression bound to sel()*.x (the "whole panel flashes"
          // effect). Reuse the previous object when the snapshot is equal,
          // so unchanged panels skip their fine-grained updates entirely.
          const prevById = new Map(prev.map((a) => [a.id, a]));
          return (d.agents ?? []).map((a: Agent) => {
            const p = prevById.get(a.id);
            return p && JSON.stringify(p) === JSON.stringify(a) ? p : a;
          });
        }),
      )
      .catch(() => {});
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
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsedSubs(next);
    localStorage.setItem("teapot.collapsed", JSON.stringify([...next]));
  };
  const treeRows = createMemo(() => {
    // 👻 toggle: drop ghost sessions (workspace missing on disk) from the
    // sidebar tree entirely — they are noise once you know about them
    const list = hideGhosts() ? agents().filter((a) => !a.workspaceMissing) : agents();
    const byParent = new Map<string, Agent[]>();
    const roots: Agent[] = [];
    for (const a of list) {
      const isSub = a.parent && list.some((p) => p.id === a.parent);
      if (isSub) {
        // newest sub first — freshly spawned agents are what you want to see
        if (!byParent.has(a.parent!)) byParent.set(a.parent!, []);
        byParent.get(a.parent!)!.unshift(a);
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
  // evCache keys are scoped per session: raw ids (e1, e2…) are only unique
  // WITHIN one log, so a cross-session key collision made stabilize() return
  // another session's row — the "teapot-b3c520e0 shows teapot-3's timeline" bug.
  function cacheKey(ev: { id: string }): string {
    return `${selected() ?? "?"}:${ev.id}`;
  }
  function stabilize(list: Ev[]): Ev[] {
    const out: Ev[] = Array.from({ length: list.length });
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      const k = cacheKey(e);
      const known = evCache.get(k);
      out[i] = known ?? e;
      if (!known) {
        evCache.set(k, e);
        if (evCache.size > 6000) {
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
  // Generation token guarding every async timeline fetch. Switching sessions
  // bumps it; responses that come back after a switch belong to a dead view
  // and must NOT touch events/scroll (they used to overwrite the freshly
  // loaded timeline with the PREVIOUS session's rows).
  let feedGeneration = 0;
  // /branches is fork-only data: skip refetching within one generation
  let lastBranchesGen = -1;

  /** merge fetched page into state by id, seq-ascending, refs stabilized */
  function mergeEvents(incoming: Ev[]): void {
    setEvents((prev) => {
      const map = new Map<string, Ev>();
      for (const e of prev) map.set(e.id, e);
      for (const e of stabilize(incoming)) if (!map.has(e.id)) map.set(e.id, e);
      return [...map.values()].sort((a, b) => a.seq - b.seq);
    });
  }

  // After the initial page lands, the feed may not even fill the viewport
  // (a fresh session shows only the last ~dozen rows). scrollTop can never
  // reach the "at top" trigger then, so older pages were unreachable. Keep
  // pulling until the feed overflows or history is exhausted.
  async function backfillUntilScrollable(): Promise<void> {
    const id = selected();
    if (!id || olderDone() || loadingOlder()) return;
    // EVERYTHING is already loaded → no older history exists at all. Exit
    // before touching the server (a fresh session with a short log lands
    // here immediately — no probing, no loop).
    if (events().length >= eventsTotal()) {
      setOlderDone(true);
      return;
    }
    // Only trust measurements from a LAID-OUT feed. Hidden/unmounted feeds
    // report scrollHeight 0 and would look "never full", causing pointless
    // page pulls; if we cannot measure, we do not guess.
    const measurable = () => {
      const f = feedEl();
      return f && f.clientHeight > 0 ? f : null;
    };
    let guard = 0;
    while (guard++ < 20 && !olderDone() && selected() === id) {
      const f = measurable();
      if (f && f.scrollHeight > f.clientHeight + 40) return; // scrollable now
      if (events().length >= eventsTotal()) {
        setOlderDone(true);
        return;
      }
      const before = events().length;
      await loadOlder();
      // empty page (or fully deduped) means history is exhausted — loadOlder
      // has set olderDone itself in the empty-page case
      if (events().length === before) return;
      // prepending grows the content ABOVE the viewport; keep the reader
      // pinned to the tail while we backfill, or follow mode silently died
      // here and "new messages appear at the top of my view" was the result
      if (atBottom() && selected() === id) scrollBottom(true);
    }
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
      // still the same session AND still anchored on the same oldest row?
      // (a plain selected() check can't be fooled by same-session tail
      // refreshes, which never touch the head of the list)
      if (selected() !== id || events()[0]?.id !== oldest.id) return;
      mergeEvents(page);
      // keep the viewport anchored to the same content after prepending
      requestAnimationFrame(() => {
        if (selected() === id) {
          const el = feedEl();
          if (el) el.scrollTop = prevTop + (el.scrollHeight - prevH);
        }
      });
    } catch { /* transient — user can scroll up again */ }
    finally { setLoadingOlder(false); }
  }

  async function loadEvents(id: string) {
    // DON'T bump the generation here. Bumping made two racing loads for the
    // SAME session invalidate each other: select() → loadEvents (gen N) and a
    // WS-triggered refresh (gen N+1) could resolve in either order, and the
    // loser was dropped — if the WS one landed first, the select's own fetch
    // was discarded AFTER the session had been cleared, leaving an EMPTY
    // timeline until some later event happened to trigger another refresh.
    // The generation only needs to move on actual session SWITCHES.
    const genAtStart = feedGeneration;
    try {
      const bf = branchFilter();
      // /branches only changes on fork — fetch it on session switch, not on
      // every tail refresh (each call re-reads the log server-side otherwise)
      const needsBranches = genAtStart !== lastBranchesGen || !branches().length;
      const [ev, br, sk] = await Promise.all([
        api(`/api/agents/${id}/events?limit=300${bf ? `&branch=${encodeURIComponent(bf)}` : ""}`),
        needsBranches
          ? api(`/api/agents/${id}/branches`)
          : Promise.resolve({ branches: branches() }),
        api(`/api/agents/${id}/skills`).catch(() => ({ skills: [] })),
      ]);
      if (needsBranches) lastBranchesGen = genAtStart;
      // stale iff a DIFFERENT session is now selected or a switch happened
      // while we were in flight — same-session refreshes must not drop us
      if (genAtStart !== feedGeneration || selected() !== id) return; // stale view
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
  /** slack for "am I at the bottom" — must cover the composer's own growth:
   * a multi-line input (up to 160px) shrinks the feed viewport between frames,
   * and a fixed 80px threshold reads that as "user scrolled away" mid-stream */
  function bottomSlack() {
    const c = document.querySelector<HTMLTextAreaElement>(".composer textarea");
    return 80 + Math.min(Math.max((c?.scrollHeight ?? 0) - (c?.clientHeight ?? 0), 0), 160);
  }
  function nearBottom() {
    const f = feedEl();
    if (!f) return true;
    return f.scrollHeight - f.scrollTop - f.clientHeight < bottomSlack();
  }
  function scrollBottom(force = false) {
    const f = feedEl();
    if (f && (force || atBottom())) {
      f.scrollTop = f.scrollHeight;
      setMissed(0);
    }
  }

  // Per-session timeline snapshots: switching back to a recently viewed
  // session restores its last-known rows INSTANTLY, then loadEvents refreshes
  // in the background. Without this, every switch cleared the feed and
  // re-fetched (a visible blank flash + full round trip).
  const timelineCache = new Map<string, { events: Ev[]; total: number; at: number }>();
  const TIMELINE_CACHE_MAX = 6;

  async function select(id: string, push = true) {
    const prevId = selected();
    const prevEvents = events();
    const prevTotal = eventsTotal();
    // bump FIRST so any in-flight fetch for the previous session lands on a
    // dead generation and is dropped instead of overwriting this one's rows
    feedGeneration++;
    if (prevId !== id) {
      // remember what the outgoing session looked like so returning is instant
      if (prevId && prevEvents.length) {
        timelineCache.set(prevId, { events: prevEvents, total: prevTotal, at: Date.now() });
        if (timelineCache.size > TIMELINE_CACHE_MAX) {
          const oldest = [...timelineCache.entries()].sort((x, y) => x[1].at - y[1].at)[0];
          if (oldest) timelineCache.delete(oldest[0]);
        }
      }
      // drop the previous session's timeline immediately — otherwise it stays
      // visible (or bleeds into the merge) until this session's fetch lands,
      // which read as "the old conversation showing up in the new session"
      setEvents([]);
      evCache.clear(); // event ids are per-log (e1, e2…) — never share across sessions
      // NOTE: live buffers are per-agent — leaving a session must NOT drop its
      // streaming bubble; the map keeps every session's stream independently.
      setCompacting(null);
      setMissed(0);
      // follow mode must NOT leak across sessions: leaving it false showed
      // "jump to present" on a brand-new/empty timeline whose feed had never
      // been scrolled (the pill only disappears once a real scroll lands)
      setAtBottom(true);
      userScrolledUp = false;
      lastScrollGap = undefined;
    }
    setSelected(id);
    saveDraft(drafts.get(id) ?? ""); // restore THIS session's unsent draft
    setBranchFilter(null);
    setOlderDone(false);
    setLoadingOlder(false);
    setPendingMsgs([]);
    localStorage.setItem("teapot.session", id);
    navigate(id, push);
    // HYDRATE from cache first: rows paint immediately (no blank flash), and
    // loadEvents below merges in whatever happened since. Cached events are
    // re-stabilized into evCache so reference identity survives the switch.
    const cached = timelineCache.get(id);
    if (cached?.events.length) {
      // stabilize() re-registers every row under THIS session's scoped keys
      stabilize(cached.events);
      setEvents(stabilize(cached.events));
      setEventsTotal(cached.total);
      requestAnimationFrame(() => {
        if (selected() === id) scrollBottom(true);
      });
    }
    // lazy sessions sit in "stopped" until touched — clicking loads them
    api(`/api/agents/${id}/load`, { method: "POST" }).then(refreshAgents).catch(() => {});
    await loadEvents(id);
    if (selected() !== id) return; // another switch won while we were loading
    // the freshly fetched snapshot is authoritative: a compaction may be
    // mid-flight on this session (missed bus events while another tab/agent
    // was selected) — seed the banner from ctx.compacting
    setCompacting(
      sel()?.ctx?.compacting ? { phase: String(sel()!.ctx!.compacting) } : null,
    );
    requestAnimationFrame(() => {
      if (selected() === id) scrollBottom(true);
    });
    // the first page may not fill the viewport — pull older pages until it
    // does (or history runs out), so infinite scroll is always reachable
    void backfillUntilScrollable();
  }

  /* ---------- realtime over WebSocket (auto-reconnect) ---------- */
  const [connected, setConnected] = createSignal(false);
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => ws?.close());
  let pendingRefresh = false;
  // the visibilitychange listener is registered ONCE below (outside
  // connectWs) — a reconnect used to add another copy each time, leaking
  // closures and timers with every reconnect cycle
  let onTabVisible: (() => void) | null = null;
  document.addEventListener("visibilitychange", () => onTabVisible?.());
  onCleanup(() => { onTabVisible = null; });
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
    // (live buffers are keyed per agent in liveByAgent — see the App body)
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.kind === "ping" || msg.kind === "pong") return;
      if (msg.kind === "llm-delta") {
        // update THIS agent's buffer only — other sessions keep streaming in
        // the background and their bubble must survive session switches
        setLiveByAgent((prev) => {
          const m = new Map(prev);
          m.set(msg.agentId, { text: msg.text ?? "", reasoning: msg.reasoning ?? "", at: Date.now() });
          return m;
        });
        // thinking-timer bookkeeping (selected session only): start the clock
        // when reasoning arrives with no text yet; reset once real text flows
        if (msg.agentId === selected()) {
          const r = String(msg.reasoning ?? "");
          const t = String(msg.text ?? "");
          if (r && !t) {
            if (!thinkStartedAt()) setThinkStartedAt(Date.now());
          } else if (t || (!r && thinkStartedAt())) {
            setThinkStartedAt(0);
          }
        }
        return;
      }
      if (msg.kind === "compaction-progress") {
        if (msg.agentId !== selected()) return;
        if (msg.phase === "done") setCompacting(null);
        else setCompacting({ phase: msg.phase, summarized: msg.summarized });
        // the phase banner rides on top of the feed — no refresh needed until
        // the compaction event itself lands
        return;
      }
      // agent-update now carries the fresh snapshot: apply it directly —
      // no GET /api/agents round-trip per event
      if (msg.kind === "agent-update" && msg.snapshot) {
        setAgents((prev) => {
          const i = prev.findIndex((a) => a.id === msg.snapshot.id);
          const next = msg.snapshot;
          if (i === -1) return [...prev, next];
          // content-equal → keep the OLD object: a new identity for unchanged
          // data re-ran every expression bound to that agent and was the last
          // source of the rare right-panel flash
          const cur = prev[i]!;
          const same =
            JSON.stringify(cur) === JSON.stringify(next);
          if (same) return prev;
          return prev.map((a, j) => (j === i ? next : a));
        });
        return; // snapshot IS the update; no feed refresh needed for it alone
      }
      if (msg.kind === "event") {
        const et = msg.event?.type;
        const ed = msg.event?.data ?? {};
        // a prompt-delivered note means the text ENTERED an LLM call payload —
        // flip the matching pending echo to "sent"; a prompt-cancelled note
        // drops the echo. BOTH fall through so the feed refresh below picks up
        // the logged prompt row in the same pass (the old early-returns made
        // the "sent ✓" echo linger until some unrelated event refreshed).
        if (et === "system_note" && ed.event === "prompt-delivered" && msg.agentId === selected()) {
          // delivery = the message now belongs to the log row. REMOVE the echo
          // from the list (the display filter alone kept it forever, and any
          // filter regression resurfaced it as a duplicate row).
          setPendingMsgs((list) => list.filter((p) => p.promptId !== ed.promptId));
        } else if (et === "system_note" && ed.event === "prompt-cancelled" && msg.agentId === selected()) {
          setPendingMsgs((list) => list.filter((p) => p.promptId !== ed.promptId));
        }
        if (FEED_IRRELEVANT.has(et) && !NOTE_FEED_TYPES.has(et)) return;
        // notify the operator about notable moments from ANY session — that's
        // the point of the notification center (progress / finish / question /
        // error), even when the timeline isn't being watched
        maybeNotify(msg.agentId, msg.event);
        // only the affected session's feed needs reloading — other sessions'
        // timelines are fetched on switch, not eagerly
        if (msg.event?.agent !== selected()) return;
      }
      // hidden tab: defer feed work until the tab is visible again — layout
      // is paused anyway, so fetching + re-rendering now is pure waste. The
      // single shared timer collapses the backlog into ONE refresh on return.
      if (document.visibilityState === "hidden") {
        pendingRefresh = true;
        return;
      }
      if (timer) return;
      // tool results land here one by one; a 400ms debounce made each bash
      // completion feel lost ("switch away and back shows it") — the fetch
      // itself is mtime-cached and cheap, so tighten the cadence instead
      timer = setTimeout(runFeedRefresh, 120);
    };
    pendingRefresh = false;
    const runFeedRefresh = async () => {
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
            // The bubble is stale ONLY when a persisted assistant message now
            // covers what it was showing. Time-based heuristics (delta after
            // fetch start) raced the stream's natural pauses and cleared a
            // LIVE bubble mid-reply — the "output flashes, then disappears"
            // bug. Compare content instead: drop the buffer only when the
            // log caught up with it (or the agent went idle with nothing new).
            const buf = live();
            if (buf) {
              const lastMsg = [...events()].reverse().find((e) => e.type === "message" && e.data?.role === "assistant");
              const covered =
                (lastMsg &&
                  (String(lastMsg.data.content ?? "") === buf.text ||
                   String(lastMsg.data.reasoning ?? "") === buf.reasoning)) ||
                sel()?.status === "idle";
              if (covered) setLive(null);
            }
            // trust atBottom() (flipped only by real user scrolling). The old
            // nearBottom() re-check measured AFTER new rows (state events like
            // idle→running, tool rows…) had already grown the feed — the
            // unscrolled gap exceeded the slack, follow was falsely dropped,
            // and the view jumped away right when a round kicked off.
            if (atBottom()) {
              scrollBottom(true);
              // following the tail means the operator has seen this session's
              // newest content — its notifications count as read
              markSessionRead(selected()!);
            } else {
              setMissed(missed() + Math.max(0, eventsTotal() - beforeTotal));
            }
          }
          // NOTE: don't drop pending echoes when the log's prompt event
          // appears — logging happens at ENQUEUE time, long before the text
          // reaches an LLM payload. The echo must survive until the matching
          // prompt-delivered note flips it to "sent ✓" (and it is then
          // removed only after the turn actually consumed it).
        }
    };
    onTabVisible = () => {
      if (document.visibilityState === "visible" && pendingRefresh) {
        pendingRefresh = false;
        // refresh IMMEDIATELY on return — the old 150ms delay made every
        // homecoming show a stale tail until the next beat
        void runFeedRefresh();
      }
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
    const base = a
      ? `${a.status === "running" ? "▶ " : a.status === "error" ? "⚠ " : ""}${a.id} · teapot`
      : "teapot";
    // unread notification count in the tab title — "(2) linux · teapot"
    document.title = unreadCount() > 0 ? `(${unreadCount()}) ${base}` : base;
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
    const focused = focusedPane();
    // snapshot BEFORE any setter runs — the setters below are plain signals,
    // so reading through the accessor after a partial update gave the swap
    // logic stale values and the click landed on the wrong pane (v0.19.6
    // "tab switching doesn't work" regression)
    const mineIdx = focused === 0 ? paneL() : paneR();
    const otherIdx = focused === 0 ? paneR() : paneL();
    const setMine = (v: number) => (focused === 0 ? setPaneL(v) : setPaneR(v));
    const setOther = (v: number) => (focused === 0 ? setPaneR(v) : setPaneL(v));
    if (otherIdx === i) {
      // it's in the other pane — swap so both stay visible
      setOther(mineIdx);
      setMine(i);
      return;
    }
    if (mineIdx !== i) setMine(i);
  }

  const addFromSelected = () => addTab();

  function addTab(agentId?: string) {
    const who = agentId ?? selected();
    if (!who) return;
    const perAgent = termTabs().filter((t) => t.agentId === who).length;
    if (perAgent >= 10) {
      flashHint(`max 10 shells per agent (${who}) — that's already a lot`);
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
      // only clear when this pane actually owns a session — replaceChildren()
      // on every mount pass used to detach a session element the OTHER pass
      // had just re-attached, which is how tabs went blank
      const owned = [...liveTerms.values()].some((t) => t.el.parentElement === host);
      if (owned) host.replaceChildren();
      return;
    }
    const s = ensureSession(tab, host);
    // Each session element must live in EXACTLY one pane. Session elements
    // are absolutely positioned, so a previous tab's terminal stayed stacked
    // underneath and showed through a freshly opened (empty) shell — the
    // "switching tabs kept showing the old tab's content" bug.
    for (const [key, other] of liveTerms) {
      if (key !== tab.key && other.el.parentElement === host) other.el.remove();
    }
    // make sure the terminal element really lives in THIS pane right now —
    // switching tabs moved DOM nodes behind Solid's back, so verify instead
    // of assuming; then refit so xterm re-measures into the (new) box
    requestAnimationFrame(() => {
      if (s.el.parentElement !== host) host.appendChild(s.el);
      try { s.fit(); } catch { /* hidden */ }
      if (focusedPane() === (idx === 0 ? 0 : 1)) {
        try { s.term.focus(); } catch { /* hidden */ }
      }
    });
  }

  // (re)mount both panes whenever any layout input changes — tabs, pane
  // assignment, split mode, drawer height. This effect was accidentally lost
  // in an earlier refactor, so after reopening the drawer (or switching
  // tabs) nothing re-attached live sessions and the pane stayed "no shell".
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
      // the selected agent has no tab YET (other agents own all tabs).
      // The old code tried focusTab(findIndex→-1) and silently did nothing,
      // leaving the pane stuck on "no shell here" or another agent's shell.
      addTab(id);
    } else {
      // its tab exists — focus it in the active pane
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
    if (next) {
      // seed the second pane with a DIFFERENT tab than the left pane shows —
      // the old findIndex picked index 0 whenever paneL() wasn't 0 (or -1
      // when it was), so split often opened with BOTH panes on one shell or
      // an empty right side despite other tabs existing
      const candidates = termTabs().map((_, i) => i).filter((i) => i !== paneL());
      if (paneR() < 0 || paneR() === paneL() || paneR() >= termTabs().length) {
        setPaneR(candidates[0] ?? -1);
      }
    }
    requestAnimationFrame(() => { mountPane(0); if (splitView()) mountPane(1); });
  };

  onCleanup(disposeAllTerms);

  // legacy single-host refs kept for pane mounting
  const setPaneHost = (idx: number) => (el: HTMLDivElement) => {
    paneHosts[idx] = el;
    // The drawer is conditionally mounted (<Show when={termOpen()}>). On
    // reopen the refs arrive fresh, but nothing re-ran mountPane — so live
    // sessions stayed detached and the pane showed "no shell here". Mount
    // right here; also refit after the drawer finishes animating in.
    if (el) requestAnimationFrame(() => {
      mountPane(idx);
      if (splitView()) mountPane(1);
      setTimeout(() => mountPane(idx), 200);
    });
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
  // oxlint-disable-next-line no-unused-vars
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
    // NOTE: the arg is capture group TWO — group numbering was misread as [3]
    // before, so argPart was ALWAYS empty. Every "/goal <text>" then looked
    // like a bare command: the completion popup stayed open and Enter (with
    // cmdIdx set) replaced the draft with "/goal ", silently eating the text.
    const argPart = (m[2] ?? "").trim();
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
  // oxlint-disable-next-line no-unassigned-vars
  let composerEl: HTMLTextAreaElement | undefined;
  const autosizeComposer = () => {
    if (!composerEl) return;
    // Suppress scroll-event processing while we resize the input: the
    // relayout fires a feed onscroll whose nearBottom() result flips with
    // every keystroke at the boundary, blinking the jump pill per character.
    // The flag also keeps follow mode pinned through the relayout.
    suppressScrollEval = true;
    const wasFollowing = atBottom();
    composerEl.style.height = "auto";
    composerEl.style.height = composerMaximized()
      ? "" // CSS takes over: .composer.maximized textarea fills the column
      : `${Math.min(composerEl.scrollHeight, MAX_COMPOSER_H)}px`;
    requestAnimationFrame(() => {
      const f = feedEl();
      if (wasFollowing && f) f.scrollTop = f.scrollHeight;
      suppressScrollEval = false;
    });
  };
  let suppressScrollEval = false;
  // user-scroll lock state (see the feed onscroll handler)
  let userScrolledUp = false;
  let lastScrollGap: number | undefined;
  createEffect(() => {
    draft(); // re-run on typing AND after send() clears the draft
    autosizeComposer();
  });

  /** post a raw prompt (used by composer AND question-option taps) */
  // image attachments staged for the next prompt (data URLs; capped count)
  const [pendingImages, setPendingImages] = createSignal<{ url: string; name: string }[]>([]);
  const addImages = (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    for (const f of list) {
      if (f.size > 8_000_000) {
        flashHint(`"${f.name}" is over 8 MB — skipped`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setPendingImages((prev) =>
          [...prev, { url: String(reader.result), name: f.name }].slice(0, 4),
        );
      };
      reader.readAsDataURL(f);
    }
  };
  const sendText = async (text: string, targetId?: string) => {
    const id = targetId ?? selected();
    if (!id) return;
    const images = pendingImages();
    try {
      const r = await api(`/api/agents/${id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, start: true, ...(images.length ? { images } : {}) }),
      });
      // optimistic echo — replaced by the logged event once the feed catches up.
      // promptId links it to the later prompt-delivered note (real LLM payload).
      setPendingMsgs((l) => [
        ...l,
        {
          id: `@p${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          text,
          at: Date.now(),
          promptId: (r as any).promptId,
          ...(images.length ? { images: images.map((i) => i.url) } : {}),
        },
      ]);
      setPendingImages([]);
      // scroll to bottom after our message appears. The composer is shrinking
      // (autosize) in the same frame — wait two frames so the scroll target is
      // computed against the SETTLED layout, not the still-expanded input.
      requestAnimationFrame(() => requestAnimationFrame(() => scrollBottom(true)));
    } catch (ex) {
      saveDraft(text); // never eat the user's message on a failed send
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
          refreshAgents(); saveDraft("");
        } else if (knownAgent) {
          if (!arg) { flashHint(`usage: @${name} <message>`); return; }
          await api(`/api/agents/${encodeURIComponent(name)}/prompt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: arg, start: true }),
          });
          flashHint(`→ delivered to @${name}`);
          saveDraft("");
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
      if (name === "goal" && !arg) { saveDraft("/goal "); return; } // keep typing
      if (name === "skill" && !arg) { saveDraft("/skill "); return; }
      saveDraft("");
      try {
        await executeSlash(name, arg);
      } catch (ex) {
        // a failed command must not eat the operator's input — sendText
        // already restores its draft on failure; commands now do too
        saveDraft(draft() ? `${text}\n${draft()}` : text);
        throw ex;
      }
      return;
    }

    saveDraft("");
    await sendText(text);
    // sending from a maximized composer restores the normal view — the whole
    // point of maximize is composing long text, and staying maximized after
    // send hid the timeline for no reason
    if (composerMaximized()) setComposerMaximized(false);
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

  // The right panel's scroll position used to reset whenever a control button
  // (▶ start / ■ stop / goal save…) refreshed the agents: content inside was
  // rebuilt and the browser clamped scrollTop. Keep the offset and restore it
  // on every repaint triggered by an agents update.
  let rightbarEl: HTMLDivElement | undefined;
  let rightbarTop = 0;
  createEffect(() => {
    agents(); // re-arm on every agents update (incl. start/stop refreshes)
    // double rAF: the first frame applies Solid's DOM writes, the second
    // measures/restores AFTER layout settles — restoring too early let the
    // browser clamp scrollTop to the OLD height and the panel visibly jumped
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!rightbarEl) return;
        const target = Math.min(rightbarTop, rightbarEl.scrollHeight);
        if (Math.abs(rightbarEl.scrollTop - target) > 1) rightbarEl.scrollTop = target;
      });
    });
  });
  const act = (path: string) =>
    () => selected() && api(`/api/agents/${selected()}${path}`, { method: "POST" }).then(refreshAgents);

  // Goal input as SIGNALS (not uncontrolled DOM): the right panel re-renders
  // on every agent snapshot, and status flips / <Show> boundary crossings
  // rebuilt the form subtree — silently wiping half-typed goals mid-input.
  const [goalDraft, setGoalDraft] = createSignal("");
  const [goalVerifyDraft, setGoalVerifyDraft] = createSignal("");
  const [goalDirty, setGoalDirty] = createSignal(false);
  const [goalNotify, setGoalNotify] = createSignal(true);
  let goalSeededFor = "";
  createEffect(() => {
    const id = selected();
    if (!id) return;
    const g = sel()?.goal;
    if (id !== goalSeededFor) {
      goalSeededFor = id; // session switch → seed from the server copy
      setGoalDirty(false);
      setGoalDraft("");
      setGoalVerifyDraft("");
      void g; // goal text itself stays in the read-only card above the form
    }
  });
  const setGoal = async (e: Event) => {
    e.preventDefault();
    if (!selected() || !goalDraft().trim()) return;
    try {
      await api(`/api/agents/${selected()}/goal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: goalDraft(),
          notify: goalNotify(),
          // only send when non-empty — an empty box must not wipe a contract
          ...(goalVerifyDraft().trim() ? { verify: goalVerifyDraft() } : {}),
        }),
      });
      setGoalDraft("");
      setGoalVerifyDraft("");
      setGoalDirty(false);
      refreshAgents();
    } catch (ex) {
      // keep the draft on failure — a wiped form AND an error hint was the
      // worst possible outcome for a long goal text
      flashHint(`goal save failed: ${(ex as Error).message}`);
    }
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
                <span
                  class={a.workspaceMissing ? " ghost" : ""}
                  title={a.workspaceMissing ? `workspace not found on disk (${a.workspace}) — it will be created when this session runs` : undefined}
                >{a.id}</span>
                {a.workspaceMissing ? <span class="ghosttag" title="workspace missing">👻</span> : null}
                <Show when={subtreeUnread(a.id) > 0}>
                  <span class="notifbadge" title={`${subtreeUnread(a.id)} unread notification${subtreeUnread(a.id) > 1 ? "s" : ""} (including sub-agents)`}>
                    🔔{subtreeUnread(a.id)}
                  </span>
                </Show>
                {/* collapsed tree: surface how many subs are still working so a
                    busy parent doesn't look idle with its subtree hidden */}
                <Show when={collapsedSubs().has(a.id)}>
                  {(() => {
                    const kids = agents().filter((x) => x.parent === a.id);
                    const running = kids.filter((k) => k.status === "running" || k.status === "waiting").length;
                    return kids.length > 0 ? (
                      <span
                        class={"subcount" + (running > 0 ? " live" : "")}
                        title={`${kids.length} sub-agent${kids.length > 1 ? "s" : ""} (${running} active)`}
                      >
                        🧩 {kids.length}{running > 0 ? ` · ▶${running}` : ""}
                      </span>
                    ) : null;
                  })()}
                </Show>
                <Show when={a.parent}><span class="subtag">🧩</span></Show>
                <Show when={agentTasks(a.id).length > 0}>
                  <span class="mini-cron" title={agentTasks(a.id).map((t) => `${t.id}: ${t.schedule}`).join("\n")}>⏰</span>
                </Show>
                <Show when={a.goal.status === "done"}><span title="goal done">✓</span></Show>
              </div>
            )}
          </For>
        </div>
        <div class="sidebar-footer">
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
          {/* row 1: buttons (incl. notification bell) — row 2: branding + live dot */}
          <div class="footer-row" style="justify-content:flex-end">
            <button
              class={"iconbtn notifbtn" + (unreadCount() > 0 ? " has-unread" : "")}
              title={unreadCount() > 0 ? `${unreadCount()} unread notifications` : "notifications"}
              onclick={(e: MouseEvent) => {
                e.stopPropagation();
                setShowNotifs(!showNotifs());
                if (!showNotifs()) setNotifs((l) => l.map((n) => ({ ...n, read: true })));
              }}
            >
              🔔<Show when={unreadCount() > 0}><i class="notifdot">{unreadCount()}</i></Show>
            </button>
            <IconBtn
              icon="👻"
              active={hideGhosts()}
              title={hideGhosts() ? "show ghost sessions again (👻 workspace missing on disk)" : "hide ghost sessions (👻 — their workspace directory no longer exists)"}
              onClick={(e) => {
                e.stopPropagation();
                const next = !hideGhosts();
                setHideGhosts(next);
                localStorage.setItem("teapot.hideGhosts", next ? "1" : "0");
                // keep the selection valid when the current session gets hidden
                if (next && selected() && sel()?.workspaceMissing) {
                  const firstVisible = agents().find((a) => !a.workspaceMissing);
                  if (firstVisible) select(firstVisible.id);
                }
              }}
            />
            <IconBtn icon="＋" title="new agent" onClick={() => { loadCfg(); setShowNew(true); }} />
            <IconBtn icon="🎨" title="themes" onClick={() => setShowThemes(!showThemes())} />
            <IconBtn icon="⚙" title="settings" onClick={() => { loadCfg(); setShowCfg(true); }} />
          </div>
          <div class="brand-row">
            <div class="brand">
              🫖 teapot <span class="version">v{__APP_VERSION__}</span>
              <span class={"conn" + (connected() ? " ok" : "")} title={connected() ? "live (websocket)" : "reconnecting…"} />
            </div>
          </div>
          <div class="metrics">
            <Show when={metrics()}>
              master rss {metrics().rssMb}MB · heap {metrics().heapUsedMb}MB<br />
              load1 {metrics().loadavg1} · up {Math.floor(metrics().uptimeSec / 60)}m
            </Show>
          </div>
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
              <span
                class="badge queued"
                title={`${sel()!.pendingPrompts ?? 0} message${(sel()!.pendingPrompts ?? 0) > 1 ? "s" : ""} from you waiting in the queue. They will be handed to the model at its next turn boundary — the timeline shows them as "pending (queued)…" until then, and each can be withdrawn with ✕ cancel while it's still queued.`}
              >
                ⏳ {sel()!.pendingPrompts} of yours queued
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
              <IconBtn icon="⌨" title="terminal (t)" onClick={toggleTerm} />
              <IconBtn icon="▤" title="toggle details panel (d)" onClick={toggleRight} />
            </span>
          </header>

          <div class="feed" onscroll={(e) => {
            if (suppressScrollEval) return; // programmatic resize, not user
            const el = e.currentTarget;
            const nb = nearBottom();
            // USER-SCROLL LOCK: while streaming, new content grows the feed and
            // fires scroll events whose nearBottom() still reads true (the
            // growth hasn't been laid out yet) — atBottom flipped back on, the
            // follow effect yanked the reader down mid-scroll, and the view
            // fought the user ("ガタガタ"). An upward scroll of >24px from the
            // bottom locks follow off until the reader returns to the tail.
            const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (!nb && lastScrollGap !== undefined && gap > lastScrollGap + 8 && gap > 24) {
              userScrolledUp = true;
            } else if (nb) {
              userScrolledUp = false;
            }
            lastScrollGap = gap;
            if (userScrolledUp && !nb) {
              setAtBottom(false);
              return; // locked: don't re-evaluate follow mode until back at tail
            }
            if (nb && missed()) setMissed(0);
            setAtBottom(nb);
            // reached the top → pull the next older page (infinite scroll up)
            if (el.scrollTop <= 4 && selected() && !loadingOlder() && !olderDone() && events().length > 0) {
              void loadOlder();
            }
          }}>
            <Show when={compacting()}>
              {(c) => (
                <div class="divider-msg compacting" title="the harness is compressing old turns into notes so work can continue within the context window">
                  🗜 {c().phase === "harvesting" ? "saving durable lessons…" : `summarizing ${c().summarized ? fmtK(c().summarized!) + " " : ""}older messages…`}
                </div>
              )}
            </Show>
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
                    answeredIds={answeredQuestionIds()}
                    agentActive={sel()?.status === "running" || sel()?.status === "waiting"}
                    onResize={() => { if (atBottom()) requestAnimationFrame(() => scrollBottom(true)); }}
                    onCancel={
                      e.data?.pending && e.data?.promptId && e.data?.sent !== true
                        ? () => {
                            const pid = String(e.data.promptId);
                            api(`/api/agents/${selected()}/prompt/cancel`, {
                              method: "POST",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({ promptId: pid }),
                            })
                              .then((r: any) => {
                                // put the text back WITHOUT clobbering what
                                // the user has typed since sending it
                                const back = String(r.text ?? "");
                                saveDraft(draft() ? `${back}\n\n${draft()}` : back);
                                setPendingMsgs((list) => list.filter((p) => p.promptId !== pid));
                                flashHint("message withdrawn — draft restored");
                              })
                              .catch(() => flashHint("withdraw failed — it may have already been sent"));
                          }
                        : undefined
                    }
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
                    <Show when={liveReasoning()}>
                      <details class="reasoning" open>
                        <summary>
                          💭 thinking <ThinkingTimer startedAt={liveStartedAt()} />
                        </summary>
                        {/* ref + scroll-follow: the thinking block grows from the
                            bottom; keep its tail visible while it streams. The
                            effect only scrolls THIS div — never the feed itself —
                            so the two follow loops can't fight each other. */}
                        <div
                          class="mono thinkscroll"
                          ref={(el) => {
                            createEffect(() => {
                              liveReasoning(); // re-run on every throttled tick
                              if (atBottom()) el.scrollTop = el.scrollHeight;
                            });
                          }}
                        >
                          {liveReasoning()}
                        </div>
                      </details>
                    </Show>
                    <Show
                      when={liveText()}
                      fallback={<div class="content muted">thinking…</div>}
                    >
                      <Show when={liveIsCompact()} fallback={<div class="content" innerHTML={renderMarkdown(liveText() + "▍")} />}>
                        <div class="muted" style="font-size:11.5px;margin-bottom:4px">🗜 summarizing older context…</div>
                        <div class="content" innerHTML={renderMarkdown(liveBody() + "▍")} />
                      </Show>
                    </Show>
                  </div>
                </div>
              </Show>
            </Show>
          </div>

          <Show when={termOpen()}>
            <div class="termdrawer" style={{ height: `${termHeight()}px`, "--termh": `${termHeight()}px` } as any}>
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
                  <IconBtn icon="＋" title="new shell in this workspace" onClick={addFromSelected} />
                </div>
                <div style="display:flex;gap:4px;align-items:center">
                  <span class="muted mono" style="flex:1;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    {activeTab() ? agents().find((a) => a.id === activeTab()!.agentId)?.workspace.split("/").filter(Boolean).pop() : sel()?.workspace}
                  </span>
                  <IconBtn icon="◫" title={splitView() ? "single pane" : "split panes (50/50)"} onClick={toggleSplit} />
                  <IconBtn icon="▾" title="hide the terminal (shells keep running; reopen with t) — close individual shells with their ✕ tab buttons" onClick={toggleTerm} />
                </div>
              </div>
              <div class="termbody" classList={{ split: splitView() }}>
                <div class="termpane" classList={{ focused: focusedPane() === 0 }} onpointerdown={() => setFocusedPane(0)} ref={setPaneHost(0)}>
                  <Show when={paneL() < 0 || paneL() >= termTabs().length}>
                    <div class="termempty muted">no shell here — ＋ opens one, tabs fill the focused pane</div>
                  </Show>
                </div>
                <Show when={splitView()}>
                  <div class="termsplit" />
                  <div class="termpane" classList={{ focused: focusedPane() === 1 }} onpointerdown={() => setFocusedPane(1)} ref={setPaneHost(1)}>
                    <Show when={paneR() < 0 || paneR() >= termTabs().length}>
                      <div class="termempty muted">no shell here — click a tab or ＋ to add</div>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
          </Show>

          <div class={"composer" + (composerMaximized() ? " maximized" : "")}>
            <Show when={!atBottom() || missed() > 0}>
              <button class="jump" onclick={() => scrollBottom(true)}>
                ↓ {missed() > 0 ? `${missed()} new message${missed() > 1 ? "s" : ""}` : "jump to present"}
              </button>
            </Show>
            <Show when={suggestions().length > 0}>
              <div class="cmds">
                <For each={suggestions()}>
                  {(s, i) => (
                    <div
                      class={"cmdrow" + (i() === cmdIdx() ? " active" : "")}
                      title={s.title}
                      onclick={() => { saveDraft(s.insert); setCmdIdx(-1); }}
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
                    <div class="cmdrow" title={m.label} onclick={() => { saveDraft(`@${m.key} `); setCmdIdx(-1); }}>
                      <b>@{m.key}</b>
                      <span class="muted">{m.label}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <form onsubmit={send}>
              {/* staged image chips — clicking ✕ unstages before send */}
              <Show when={pendingImages().length > 0}>
                <div class="imgstage">
                  <For each={pendingImages()}>
                    {(im, i) => (
                      <span class="imgchip" title={im.name}>
                        <img src={im.url} alt={im.name} />
                        <button
                          type="button"
                          class="imgx"
                          title="remove"
                          onclick={() => setPendingImages((l) => l.filter((_, j) => j !== i()))}
                        >✕</button>
                      </span>
                    )}
                  </For>
                  <span class="muted" style="font-size:11px;align-self:center">
                    {pendingImages().length} image{pendingImages().length > 1 ? "s" : ""} attached
                  </span>
                </div>
              </Show>
              <textarea
                ref={composerEl}
                rows={1}
                placeholder={`message #${sel()!.id} — / for commands · paste or 📎 to attach images`}
                value={draft()}
                onpaste={(e) => {
                  // screenshots land on the clipboard as files — stage them
                  const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
                  if (imgs.length) {
                    e.preventDefault();
                    addImages(imgs);
                  }
                }}
                oninput={(e) => {
                  saveDraft(e.currentTarget.value);
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
                    saveDraft(sugg[cmdIdx()]!.insert);
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
              <button
                type="button"
                class="iconbtn maxbtn"
                title={composerMaximized() ? "restore composer (hide timeline)" : "maximize composer — hide the timeline and fill the main column"}
                onclick={() => {
                  const next = !composerMaximized();
                  setComposerMaximized(next);
                  // re-run autosize under the new regime, then keep the feed
                  // pinned / restored correctly across the relayout
                  requestAnimationFrame(() => autosizeComposer());
                }}
              >{composerMaximized() ? "⤡" : "⤢"}</button>
              <IconBtn
                icon="📎"
                title="attach images (or paste them straight into the box)"
                onClick={() => document.getElementById("composer-file")?.click()}
              />
              <Show when={pendingImages().length}>
                <span class="muted" style="font-size:11.5px;white-space:nowrap">🖼 {pendingImages().length}</span>
              </Show>
              <button type="submit">send</button>
              {/* hidden input lives here so the 📎 button can trigger it */}
              <input
                id="composer-file"
                type="file"
                accept="image/*"
                multiple
                style="display:none"
                onchange={(e) => {
                  if (e.currentTarget.files?.length) addImages(e.currentTarget.files);
                  e.currentTarget.value = ""; // allow re-selecting the same file
                }}
              />
            </form>
            <div class="hint">
              {flash() ||
                "enter send · shift+enter newline · ↑↓ sessions · / commands & focus · t terminal · d panel · esc interrupt · messages sent while the agent works queue up and land at the next turn boundary"}
            </div>
          </div>
        </Show>
      </section>

      {/* ---------- right bar ---------- */}
      <aside
        class={"rightbar" + (showRight() ? " open" : "")}
        ref={rightbarEl}
        onscroll={(e) => { rightbarTop = (e.currentTarget as HTMLDivElement).scrollTop; }}
      >
        <Show when={sel()}>
          <h3 title="identity + storage locations for this agent">🎛 session</h3>
          <div class="card sesscard">
            <div class="sessrow"><span class="k">agent</span><b>{sel()!.id}</b><span class={`badge ${sel()!.status}`}>{sel()!.status}</span></div>
            <div class="sessrow"><span class="k">workspace</span><span class="mono ellip" title={sel()!.workspace}>{sel()!.workspace}</span></div>
            <div class="sessrow"><span class="k">session</span><span class="mono">{sel()!.session}/{sel()!.branch}</span></div>
          </div>

          {/* keyed by agent id: Solid re-runs the JSX expression on every
              snapshot update, but <Show keyed> + primitive props keep the
              FilesPanel subtree from re-rendering unless the agent changes */}
          <Show when={sel()!.id} keyed fallback={null}>
            {(aid) => (
              <FilesPanel agentId={aid} workspace={sel()!.workspace} />
            )}
          </Show>

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
            {/* ONE persistent button: swapping ▶ start / ■ stop via <Show> destroyed
                and recreated the node on every idle→running transition, which
                visibly reflowed the panel (width jump + row wrap). Toggling
                class/text keeps the same element, so layout never moves. */}
            <button
              class={sel()!.status === "running" ? "danger" : "runbtn"}
              title={
                sel()!.status === "running"
                  ? "interrupt: aborts the current LLM call; the running tool finishes first"
                  : "run toward the goal (starts the loop)"
              }
              onclick={sel()!.status === "running" ? act("/stop") : act("/start")}
            >{sel()!.status === "running" ? "■ stop" : "▶ start"}</button>
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
            <Show
              when={!!sel()!.goal.text.trim()}
              fallback={<span class="badge" title="no goal set yet">no goal</span>}
            >
              <span class={`badge ${sel()!.goal.status === "active" ? "running" : sel()!.goal.status}`}>{sel()!.goal.status}</span>
            </Show>
          </h3>
          <div class="statrow" style="margin-bottom:6px">
            <span class="k">status</span>
            <For each={["active", "done", "paused"] as const}>
              {(s) => (
                <button
                  // an EMPTY goal must not light up "▶ working": fresh
                  // sessions store status:"active" by default, which made a
                  // brand-new timeline look like the agent was already on it
                  class={"goalstate" + (!!sel()!.goal.text.trim() && sel()!.goal.status === s ? ` on ${s}` : "")}
                  disabled={!!sel()!.goal.text.trim() && sel()!.goal.status === s}
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
            <Show when={sel()!.goal.verify}>
              <div class="card verifycard" title="verification contract — finish(goalComplete=true) is audited against these requirements by an independent reviewer before the goal counts as done">
                <div class="vtitle">🔍 verification contract</div>
                <div class="content" innerHTML={renderMarkdown(String(sel()!.goal.verify))} />
              </div>
            </Show>
            <Show when={sel()!.goal.audit}>
              {(a) => (
                <div class={"card auditcard " + (a().verdict === "approved" ? "ok" : "warn")}>
                  <div class="vtitle">
                    {a().verdict === "approved" ? "✅ audit: approved" : "⚠ audit: changes required"}
                    <span class="meta muted" style="margin-left:auto">{relTime(a().at)}</span>
                  </div>
                  <div class="content" innerHTML={renderMarkdown(a().feedback)} />
                </div>
              )}
            </Show>
          </Show>
          <div class="muted" style="font-size:11px;margin-top:4px">
            stored with the session · the agent reads it via get_goal() · auto-continue loops while status is "working" and stops when marked done
          </div>
          <form onsubmit={setGoal} style="display:flex;flex-direction:column;gap:6px;margin-top:8px;margin-bottom:6px">
            <textarea
              id="goal-input"
              rows={3}
              placeholder="set new goal…"
              value={goalDraft()}
              oninput={(e) => { setGoalDraft(e.currentTarget.value); setGoalDirty(true); }}
              style="background:var(--bg-darkest);border:none;border-radius:6px;padding:6px 8px;color:var(--fg);font:inherit;width:100%;resize:vertical"
            />
            <textarea
              id="goal-verify-input"
              rows={2}
              placeholder="verification contract (optional) — e.g. 'npm test passes; endpoint documented'. finish(goalComplete=true) is then audited against this."
              title="pi-goal-x-style verification contract — an independent reviewer checks the agent's finish against these requirements"
              value={goalVerifyDraft()}
              oninput={(e) => { setGoalVerifyDraft(e.currentTarget.value); setGoalDirty(true); }}
              style="background:var(--bg-darkest);border:1px solid var(--bg-light);border-radius:6px;padding:6px 8px;color:var(--fg);font:inherit;font-size:12.5px;width:100%;resize:vertical"
            />
            <div style="display:flex;justify-content:flex-end;align-items:center;gap:10px">
              <label
                class="muted"
                style="display:flex;align-items:center;gap:4px;font-size:11.5px;white-space:nowrap;cursor:pointer"
                title="queue a harness prompt telling the agent about the new goal at its next turn boundary"
              >
                <input id="goal-notify" type="checkbox" checked={goalNotify()} onchange={(e) => setGoalNotify(e.currentTarget.checked)} /> notify agent
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
          <Show
            when={todoViewMode()}
            fallback={
              /* rendered checklist — the default view; markdown + real checkboxes */
              <div class="content mdpreview" style="max-height:40vh;padding:8px 10px" innerHTML={renderMarkdownCached(todoDraft())} />
            }
          >
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
          </Show>
          <div style="display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:4px">
            <IconBtn
              icon={todoViewMode() ? "👁" : "✎"}
              title={todoViewMode() ? "rendered checklist" : "edit markdown"}
              onClick={() => setTodoViewMode(!todoViewMode())}
            />
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
                <div class="progrow"><b>doing</b><span class="content inline-md" innerHTML={renderMarkdownCached(p().doing)} /></div>
                <Show when={p().recent}><div class="progrow"><b>recent</b><span class="content inline-md" innerHTML={renderMarkdownCached(p().recent)} /></div></Show>
                <Show when={p().problems}><div class="progrow warn"><b>⚠ problems</b><span class="content inline-md" innerHTML={renderMarkdownCached(p().problems)} /></div></Show>
                <Show when={p().next}><div class="progrow"><b>next</b><span class="content inline-md" innerHTML={renderMarkdownCached(p().next)} /></div></Show>
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
                  ⚡ {(Math.round((sel()!.stats.cachedInputTokens / Math.max(1, sel()!.stats.inputTokens)) * 1000) / 10)}% cached
                </span>
              </Show>
            </div>
            {/* session cost estimate — only when the provider publishes pricing
                (OpenRouter does; local endpoints usually don't) */}
            <Show when={(sel()!.stats.costUsd ?? 0) > 0}>
              <div
                class="statrow"
                title={`≈ ${(sel()!.stats.costUsd ?? 0).toFixed(4)} this session, from the model's USD/token pricing and per-turn usage. Cached input is estimated at ~10% of the prompt rate; treat as an approximation, not an invoice.`}
              >
                <span class="k">cost</span>
                <b>${costFmt(sel()!.stats.costUsd ?? 0)}</b>
              </div>
            </Show>
            <Show
              when={sel()!.ctx}
              keyed
              fallback={
                <div class="statrow">
                  <span class="k">context</span>
                  <span class="muted">no window known for this model yet</span>
                </div>
              }
            >
              {(c) => {
                // ALL derived values are memos: this callback used to run ONCE
                // (unkeyed <Show> builds its children a single time), freezing
                // pct/bar/labels at the first snapshot — the gauge then showed
                // "0% of 1m" forever while the token count itself kept updating
                // (that count is a JSX expression, so it stayed reactive).
                const ctxVals = createMemo(() => {
                  const cv = c;
                  const modelMeta = models().find((m) => m.id === sel()!.model);
                  const effectiveWindow = cv.window || modelMeta?.contextLength || 0;
                  // one decimal place — 0.4% vs 0% matters on million-token windows
                  const pct = effectiveWindow
                    ? Math.min(999, (cv.usedTokens / effectiveWindow) * 100)
                    : 0;
                  return {
                    usedTokens: cv.usedTokens,
                    compactAt: cv.compactAt,
                    compacting: cv.compacting,
                    window: cv.window,
                    effectiveWindow,
                    pct,
                    cls:
                      !effectiveWindow ? "" : pct >= 85 ? "crit" : pct >= 70 ? "warn" : "ok",
                    derivedBudget: effectiveWindow ? Math.round(effectiveWindow * 0.75) : 0,
                    usingDerived: cv.compactAtIsManual !== true,
                  };
                });
                const v = () => ctxVals();
                const fmtPct = (x: number) => {
                  const r = Math.round(x * 10) / 10;
                  return Number.isInteger(r) ? String(r) : r.toFixed(1);
                };
                return (
                  <div
                    class="ctxblock"
                    title="estimated live context vs the model's real window. Past the window, old turns are summarized into notes (compaction); the compact line below shows where that starts."
                  >
                    <div class="statrow">
                      <span class="k">context</span>
                      <b>~{fmtK(v().usedTokens)} tok</b>
                      <Show when={v().effectiveWindow}>
                        <span class={`pill ${v().cls}`}>
                          {fmtPct(v().pct)}% of {fmtK(v().effectiveWindow)}
                        </span>
                      </Show>
                    </div>
                    <Show when={v().effectiveWindow}>
                      <div class="bartrack">
                        <div class={`barfill ${v().cls}`} style={{ width: `${Math.min(100, v().pct)}%` }} />
                      </div>
                    </Show>
                    <div class="statrow" style="margin-top:4px">
                      <span class="k">compact</span>
                      <b>{fmtK(v().usingDerived ? v().derivedBudget : v().compactAt)} tok</b>
                      <span class="muted" style="font-size:11px;color:var(--dim)">
                        {v().usingDerived ? ` (75% of window)` : ` (manual override)`}
                      </span>
                    </div>
                    <Show when={v().effectiveWindow}>
                      <div class="bartrack" style="margin-top:4px">
                        <div class={`barfill ${v().cls}`} style={{ width: `${Math.min(100, Math.round((v().usedTokens / v().derivedBudget) * 100))}%` }} />
                      </div>
                    </Show>
                    <Show when={compacting() || v().compacting}>
                      <div class="statrow" title="a compaction pass is running right now — the summarizer's output streams in the timeline">
                        <span class="k">🗜</span>
                        <b>compacting…</b>
                        <span class="muted" style="font-size:11px;color:var(--acc)">
                          {compacting()?.phase ?? String(v().compacting)}
                        </span>
                      </div>
                    </Show>
                    <div class="ctrlrow" style="margin-top:6px">
                      <label title="when on, older turns are automatically summarized when context exceeds the budget">
                        <input
                          type="checkbox"
                          checked={sel()!.autoCompact !== false}
                          onchange={(e) => {
                            if (!selected()) return;
                            api(`/api/agents/${selected()}/auto-compact`, {
                              method: "POST",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({ value: e.currentTarget.checked }),
                            }).then(refreshAgents);
                          }}
                        />
                        auto-compact
                      </label>
                      <span class="muted" style="font-size:11.5px">summarizes old turns when budget exceeded</span>
                    </div>
                    <div class="muted" style="font-size:11px;margin-top:4px">
                      compaction starts around ~{fmtK(v().compactAt)} tok — older turns get summarized, recent ones stay intact
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
    <Show when={showNotifs()}>
      {/* notification center — pops from the sidebar footer, bottom-left */}
      {/* click-outside closer: an invisible full-screen layer under the panel */}
      <div class="notifbackdrop" onclick={() => setShowNotifs(false)} />
      <div class="notifpanel">
        <div class="notifhead">
          notifications
          <span style="display:flex;gap:8px;align-items:center">
            <Show when={notifs().length > 0}>
              <button class="editbtn" onclick={() => setNotifs([])}>clear all</button>
            </Show>
            <button class="iconbtn" title="close notifications" onclick={() => setShowNotifs(false)}>✕</button>
          </span>
        </div>
        <Show
          when={notifs().length > 0}
          fallback={<div class="muted" style="padding:10px">nothing yet — progress, finishes, questions and errors will land here</div>}
        >
          <div class="notiflist">
            <For each={notifs()}>
              {(n) => (
                <div
                  class={"notifitem " + n.kind + (n.read ? " read" : "")}
                  title={`from ${n.agentId}`}
                  onclick={() => {
                    // mark THIS one read, jump to its agent and scroll the
                    // timeline to the exact message that raised it
                    setNotifs((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
                    if (selected() !== n.agentId && agents().some((a) => a.id === n.agentId)) select(n.agentId);
                    setShowNotifs(false);
                    if (n.eventId)
                      // wait for the timeline swap before scrolling
                      setTimeout(() => jumpToEvent(n.eventId!), selected() !== n.agentId ? 350 : 60);
                  }}
                >
                  <div class="nhead">
                    <span class="nicon">{n.kind === "finish" ? "✅" : n.kind === "question" ? "❓" : n.kind === "error" ? "⚠️" : "📈"}</span>
                    <span class="ntitle">{n.title}</span>
                    <span class="meta muted">{relTime(new Date(n.at).toISOString())}</span>
                    <button
                      class="iconbtn nreadbtn"
                      title={n.read ? "already read" : "mark as read"}
                      onclick={(e: MouseEvent) => {
                        e.stopPropagation();
                        setNotifs((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
                      }}
                    >{n.read ? "✓" : "○"}</button>
                  </div>
                  <Show when={n.body}>
                    <div class="nbody">{truncate(n.body, 160)}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
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
/* ---------- live elapsed-time ticker for a still-running bash call ---------- */
function BashElapsed(props: { startedAt: string; inline?: boolean; timeoutMs?: number }) {
  const start = new Date(props.startedAt).getTime();
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    // 500ms tick is plenty for a seconds readout and stops with the row
    const t = setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => clearInterval(t));
  });
  const s = () => Math.max(0, (now() - start) / 1000);
  const txt = () =>
    s() < 60 ? `${s().toFixed(1)}s` : `${Math.floor(s() / 60)}m ${Math.round(s() % 60)}s`;
  // inline: compact form for the folded summary ("running… 1m 26s")
  if (props.inline) {
    return (
      <span class="bashelapsed">
        running… {txt()}
        {props.timeoutMs ? ` · timeout ${Math.round(props.timeoutMs / 1000)}s` : ""}
      </span>
    );
  }  return <span class="bashelapsed">{txt()} elapsed</span>;
}

/** Live elapsed-seconds readout for the current thinking stretch. */
function ThinkingTimer(props: { startedAt: number }) {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => clearInterval(t));
  });
  const s = () => Math.max(0, (now() - props.startedAt) / 1000);
  return (
    <span class="thinktimer">
      {s() < 60 ? `${s().toFixed(0)}s` : `${Math.floor(s() / 60)}m ${Math.round(s() % 60)}s`}
    </span>
  );
}

/* ---------- per-tool timeline rendering ---------- */

function ToolRow(props: { e: Ev; res?: Ev; agentActive?: boolean; onResize?: () => void }) {
  const e = props.e;
  const res = props.res;
  // STALE-RUN GUARD: if the agent is no longer running, an unpaired tool_call
  // cannot still be in flight (its result event was missed — e.g. logged while
  // the tab was hidden). Rendering it forever as "running…" was exactly that:
  // switching sessions and back "fixed" it because that reloaded the log.
  const staleDone = !props.agentActive && !res;
  const d = e.data ?? {};
  const name = String(d.name ?? "tool");
  const out = () => (res ? String(res.data?.result ?? "") : "");

  // per-tool summary line: [icon, label, hint]
  let icon = "⚙";
  let label = name;
  let hint: string | null = "";
  let body: any = <div class="mono">{truncate(JSON.stringify(d.args ?? {}, null, 1), 2000)}</div>;

  const argStr = (k: string) => String(d.args?.[k] ?? "");
  // best-effort "what was run" text per tool: bash→the command, others→path/args
  const cmdText = () => {
    if (name === "bash") return argStr("command");
    return argStr("path") || JSON.stringify(d.args ?? {}, null, 1);
  };
  // effective timeout for live elapsed display — tools with defaults that the
  // model omitted (wait_children: 5 min) still show their real cap
  const effTimeout = () => {
    if (name === "bash") return Number(argStr("timeout_ms")) || undefined;
    if (name === "wait_children") return Number(argStr("timeout_ms")) || 300_000;
    return Number(argStr("timeout_ms")) || undefined;
  };
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
        const isBg = d.args?.background === true;
        // background jobs return INSTANTLY (the shell keeps running) — a plain
        // "$ cmd · 12ms" row read as "finished immediately" and the job was
        // forgotten. Give them their own identity + the job id for bash_output.
        const bgJob = isBg ? (String(out()).match(/job (bg\d+)/)?.[1] ?? "") : "";
        label = (isBg ? "⏳ " : "$ ") + oneLine(cmd, 96);
        const timeoutHint = argStr("timeout_ms") ? ` · timeout ${Math.round(Number(argStr("timeout_ms")) / 1000)}s` : "";
        hint = res
          ? isBg
            ? `background job${bgJob ? ` ${bgJob}` : ""}${timeoutHint}`
            : `${res.data?.durationMs ?? "?"}ms${timeoutHint}`
          : null; // live elapsed renders in the summary (below)
        body = (
          <>
            {isBg ? (
              <div class="meta bgjob-note">
                runs in background — poll with <b>bash_output(job_id=&quot;{bgJob || "?"}&quot;)</b>
                {bgJob ? <> · kill with <b>action="kill"</b></> : null}
              </div>
            ) : null}
            {cmd !== label.slice(isBg ? 2 : 2) ? codeBlock(cmd, 800) : null}
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
        hint = `${fmtK(content.length)} bytes`;
        // content was rendered UNTRUNCATED — a few big write_file calls (the
        // 100KB+ ones real sessions accumulate) made those chats take seconds
        // to open and chew CPU on every prepend while scrolling back
        body = (
          <>
            {codeBlock(content, 1500)}
            {content.length > 1500 ? <div class="meta muted">{fmtK(content.length)} bytes — open it from 🗂 files for the full view</div> : null}
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
        // huge patches rendered one <div> PER LINE with no cap — multi-thousand-
        // line patches froze the feed. Show the head; the rest is noise here.
        const MAX_PATCH_LINES = 60;
        const shown = patchLines.slice(0, MAX_PATCH_LINES);
        body = (
          <>
            <pre class="mono toolbody patch">
              {shown.map((l) => {
                const cls = l.startsWith("+") ? " add" : l.startsWith("-") ? " del" : /^\*\*\*|^@@/.test(l) ? " meta" : "";
                return <div class={"pline" + cls}>{l.length > 240 ? l.slice(0, 240) + "…" : l}</div>;
              })}
              {patchLines.length > MAX_PATCH_LINES ? <div class="pline meta">… {patchLines.length - MAX_PATCH_LINES} more lines</div> : null}
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
      case "bash_output": {
        // reading vs killing reads differently at a glance
        const action = argStr("action") || "read";
        const jobId = argStr("job_id") || "(?)";
        label = `bash_output ${jobId}`;
        hint = action;
        body = resultBlock(4000);
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
      class={"embed" + (res ? (res.data?.ok === false ? " fail" : " done") : staleDone ? " done" : " running")}
      title={`${name}${hint ? " — " + hint : ""}`}
      onToggle={(ev: ToggleEvent) => {
        // expanding/collapsing changes the feed height; while following, the
        // bottom line must stay pinned instead of drifting out of view
        if ((ev.target as HTMLDetailsElement).open) props.onResize?.();
      }}
    >
      <summary>
        <b>{icon} {label}</b>
        <Show when={e.data?.actor}>
          <span class="actor">@{String(e.data.actor)}</span>
        </Show>
        <span class="meta">
          {res
            ? hint || ""
            : staleDone
              ? "(result missed)"
              : name === "bash" || effTimeout()
                ? // any tool with a timeout shows live elapsed + its cap
                  <BashElapsed startedAt={e.ts} inline timeoutMs={effTimeout()} /> // visible while folded
                : "running…"}
        </span>
        {/* dedicated copy buttons: the generic header "copy" copied "" on tool
            rows (rawOf only knows prompts/messages) — now the command that ran
            and its output each have their own button */}
        <span class="toolcopy">
          <CopyBtn text={cmdText()} label="⧉ cmd" title={`copy the ${name} arguments`} />
          <Show when={res}>
            <CopyBtn text={out()} label="⧉ out" title="copy this tool's full output" />
          </Show>
        </span>
      </summary>
      {body}
    </details>
  );
}

/** The un-rendered source text of a chat row — what "copy raw" should give. */
function rawOf(e: Ev): string {
  const d = e.data ?? {};
  if (e.type === "prompt") return String(d.text ?? "");
  if (e.type === "message") {
    // include reasoning when present, separated, so nothing is lost
    const r = typeof d.reasoning === "string" && d.reasoning.trim()
      ? `<reasoning>\n${d.reasoning}\n</reasoning>\n\n`
      : "";
    return `${r}${String(d.content ?? "")}`;
  }
  if (e.type === "tool_call") {
    // the header copy button used to sit on tool rows too and copied ""
    // (rawOf only knew prompts/messages) — tool rows get dedicated
    // command/output buttons inside ToolRow instead, so nothing here
    return "";
  }
  return "";
}

function MessageRow(props: { e: Ev; prev?: Ev; res?: Ev; onEdit?: () => void; onCancel?: () => void; onOption?: (text: string) => void; answeredIds?: Set<string>; agentActive?: boolean; onResize?: () => void }) {
  const e = props.e;
  const a = authorOf(e);
  // Group consecutive rows from the same ACTOR. The actor for tool events is
  // THE AGENT (they are its actions) — keying by tool name broke grouping as
  // soon as two different tools ran back to back (bash→read_file→bash).
  const actorKey = (ev: Ev): string => {
    const d = ev.data ?? {};
    if (ev.data?.actor) return `sub:${String(ev.data.actor)}`;
    if (ev.type === "tool_call" || ev.type === "tool_result") return "agent-tools";
    if (ev.type === "prompt") return `src:${String(d.source ?? "user")}`;
    return `type:${ev.type}`;
  };
  const grouped =
    props.prev &&
    actorKey(props.prev) === actorKey(e) &&
    authorOf(props.prev).name === a.name &&
    e.session === props.prev.session &&
    e.branch === props.prev.branch;

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
  // system_note MUST resolve here (before the .msg wrapper): the wrapper
  // always renders an avatar + empty body, so notes handled only inside
  // SwitchContent appeared as mysterious EMPTY rows on the timeline.
  // Most notes are log-only; these few earn a visible divider/embed row.
  if (e.type === "system_note") {
    const ev = String(e.data?.event ?? "");
    if (ev === "runaway-detected") {
      return (
        <div class="embed fail" title={`${e.data?.failures} consecutive tool failures hit the configured limit (${e.data?.limit})`}>
          <div class="mono">🛑 runaway: {String(e.data?.failures)} tool failures in a row (limit {String(e.data?.limit)})</div>
          <div class="meta">last: {String(e.data?.lastTool)} — {String(e.data?.lastError ?? "").slice(0, 200)}</div>
        </div>
      );
    }
    if (ev === "error-retry") {
      return (
        <div class="embed warn-embed" title="a round-fatal API error occurred; auto-retry is waiting, then a fresh round starts (onError: retry)">
          <div class="mono">↻ API error — retrying (attempt {String(e.data?.attempt)}) in {Math.round(Number(e.data?.waitMs) / 1000)}s…</div>
        </div>
      );
    }
    if (ev === "background-exit") {
      const failed = e.data?.failed === true;
      const secs = Math.round(Number(e.data?.durationMs ?? 0) / 1000);
      return (
        <div class={"divider-msg" + (failed ? " err" : "")} title={String(e.data?.cmd ?? "")}>
          {(failed ? "⚠ background job " : "✓ background job ") +
            String(e.data?.jobId ?? "?") + " " +
            (failed ? `FAILED (exit ${String(e.data?.code ?? "?")})` : `finished (${secs}s)`)}
        </div>
      );
    }
    if (ev === "context-compacted") {
      return (
        <div class="divider-msg">
          🗜 compacted: {String(e.data?.tokensBefore ?? "?")} → {String(e.data?.tokensAfter ?? "?")} tok ({String(e.data?.mode ?? "")})
        </div>
      );
    }
    return null; // log-only notes (prompt-delivered, llm-retry, …)
  }

  return (
    <div
      class={"msg" + (grouped ? " grouped" : "") + (e.data?.pending ? " pending" : "")}
      data-eid={e.id}
    >
      {/* grouped rows keep the same geometry as the row that started the
          run — same avatar slot, but EMPTY (no faded ghost icon): a column of
          faint 🧩s read as separate "sub messages" instead of continuation
          lines. Hover still shows time+branch via the title. */}
      <div
        class={"avatar avghost" + (grouped ? " ghosted" : "")}
        style={{ background: grouped ? "transparent" : a.color + "33", border: grouped ? "1px solid transparent" : `1px solid ${a.color}66` }}
        title={grouped ? `${fmtTs(e.ts)} · ${e.branch}` : undefined}
      >
        {grouped ? "" : a.icon}
      </div>
      <div class="msg-body">
        {grouped && <span class="grouptime" title={`${fmtTs(e.ts)} · ${e.branch}`} />}
        <Show when={!grouped}>
          <div class="msg-head">
            <span class="author" style={{ color: a.color }}>{a.name}</span>
            <Show when={e.data?.actor}>
              <span class="actor">@{String(e.data.actor)}</span>
            </Show>
            <span class="ts">{e.data?.pending ? "queued…" : fmtTs(e.ts)}</span>
            <span class="ts">{e.branch}</span>
            <Show when={props.onCancel}>
              <button
                class="editbtn"
                title="withdraw this message — it has not reached the model yet; the text goes back to the input box"
                onclick={(ev: MouseEvent) => { ev.stopPropagation(); props.onCancel!(); }}
              >✕ cancel</button>
            </Show>
            {/* tool rows have no copyable message body — their command/output
                buttons live inside ToolRow; rendering the header button anyway
                produced a "copy" that silently copied the empty string */}
            <Show when={e.type !== "tool_call"}>
              <CopyBtn text={rawOf(e)} label="⧉ copy" title="copy the RAW text of this message (no markdown rendering)" />
            </Show>
            <Show when={props.onEdit}>
              <button
                class="editbtn"
                title="edit this prompt — forks the conversation here (later events are dropped or summarized)"
                onclick={(ev: MouseEvent) => { ev.stopPropagation(); props.onEdit!(); }}
              >✎ edit</button>
            </Show>
          </div>
        </Show>

        <SwitchContent e={e} res={props.res} onOption={props.onOption} answeredIds={props.answeredIds} agentActive={props.agentActive} onResize={props.onResize} />
      </div>
    </div>
  );
}

/**
 * Free-text answer row under an ask_user embed. The agent's reply arrives as
 * a regular user prompt, so this just routes through onOption — but it lets
 * the operator answer with something that wasn't among the offered options.
 */
function FreeTextAnswer(props: { answered: boolean; onOption?: (t: string) => void }) {
  const [val, setVal] = createSignal("");
  const submit = () => {
    const t = val().trim();
    if (!t || props.answered) return;
    setVal("");
    props.onOption?.(t);
  };
  return (
    <div class="qfree">
      <input
        type="text"
        placeholder={props.answered ? "answered" : "or type your own answer…"}
        disabled={props.answered}
        value={val()}
        oninput={(e) => setVal(e.currentTarget.value)}
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === "Enter") { e.preventDefault(); submit(); }
        }}
      />
      <button disabled={props.answered || !val().trim()} onclick={submit}>reply</button>
    </div>
  );
}

function SwitchContent(props: { e: Ev; res?: Ev; onOption?: (text: string) => void; answeredIds?: Set<string>; agentActive?: boolean; onResize?: () => void }) {
  const e = props.e;
  switch (e.type) {
    case "prompt": {
      // image attachments render as thumbnails under the text (logged events
      // carry data.images; optimistic echoes carry data.pending images array)
      const imgs: string[] = e.data?.images ?? [];
      return (
        <>
          <div class="content" innerHTML={renderMarkdownCached(String(e.data.text ?? ""))} />
          <Show when={imgs.length}>
            <div class="promptimgs">
              <For each={imgs}>{(src) => <img src={src} class="promptimg" alt="attachment" />}</For>
            </div>
          </Show>
        </>
      );
    }
    case "message":
      return (
        <>
          <Show when={typeof e.data.reasoning === "string" && e.data.reasoning.trim()}>
            <details class="reasoning">
              <summary>💭 reasoning{String(e.data.reasoning).length > 4000 ? ` (${fmtK(String(e.data.reasoning).length)} — truncated)` : ""}</summary>
              <div class="mono">{truncate(String(e.data.reasoning), 8000)}</div>
            </details>
          </Show>
          <div class="content" innerHTML={renderMarkdownCached(String(e.data.content ?? ""))} />
          <Show when={e.data.interrupted}>
            <div class="interrupted">⚠ interrupted — partial output kept</div>
          </Show>
          <Show when={e.data.final}>
            <div class="msgfoot"><CopyBtn text={String(e.data.content ?? "")} /><span>copy summary</span></div>
          </Show>
        </>
      );
    case "tool_call":
      return <ToolRow e={e} res={props.res} agentActive={props.agentActive} onResize={props.onResize} />;
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
            <b>📌 <span class="content inline-md" innerHTML={renderMarkdownCached(String(e.data?.decision ?? ""))} /></b>
            <span class="meta">decision logged</span>
          </summary>
          {/* model-written markdown, same as progress bodies */}
          <div class="content" innerHTML={renderMarkdownCached(String(e.data?.rationale ?? ""))} />
          <Show when={alts.length}>
            <div class="content muted">Rejected: {alts.join(" / ")}</div>
          </Show>
        </details>
      );
    }
    case "question": {
      const opts = Array.isArray(e.data?.options) ? (e.data.options as string[]) : [];
      // a question is ANSWERED once its tool_result exists in the log (ask_user
      // parks the loop; the reply lands as a user prompt and the tool_result
      // closes the call). Answered questions keep their options visible but
      // disabled — tapping them twice used to send duplicate prompts.
      const callId = e.data?.callId ? String(e.data.callId) : "";
      const answered = props.answeredIds?.has(callId) ?? false;
      return (
        <div class={"embed question" + (answered ? " answered" : "")}>
          <div>❓ {String(e.data?.question ?? "")}</div>
          <Show when={answered}>
            <div class="meta" style="color:var(--ok)">✓ answered — continuing below</div>
          </Show>
          <Show when={opts.length > 0}>
            <div class="qopts">
              <For each={opts}>
                {(o) => (
                  <button
                    class="qopt"
                    disabled={answered}
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
          <FreeTextAnswer answered={answered} onOption={props.onOption} />
        </div>
      );
    }
    case "progress":
      return (
        <div class="embed" style="border-color: var(--ok)">
          {/* progress bodies are model-written markdown — render them, don't
              dump raw text (structured fields keep their labels) */}
          <div>📈 <div class="content inline-md" innerHTML={renderMarkdownCached(String(e.data.doing ?? ""))} /></div>
          <Show when={e.data.goalStatus}><div class="progrow"><b>goal</b><span>{String(e.data.goalStatus)}</span></div></Show>
          <Show when={e.data.recent}><div class="progrow"><b>recent</b><span class="content inline-md" innerHTML={renderMarkdownCached(String(e.data.recent))} /></div></Show>
          <Show when={e.data.problems}><div class="progrow warn"><b>⚠ problems</b><span class="content inline-md" innerHTML={renderMarkdownCached(String(e.data.problems))} /></div></Show>
          <Show when={e.data.next}><div class="progrow"><b>next</b><span class="content inline-md" innerHTML={renderMarkdownCached(String(e.data.next))} /></div></Show>
        </div>
      );
    case "error":
      return <div class="embed fail"><div class="mono">⚠ {String(e.data.message ?? "")}</div></div>;
    case "compaction":
      return (
        <details class="embed compaction">
          <summary>
            <b>🗜 context compacted</b>
            <span class="meta">
              {String(e.data.mode ?? "")} · {fmtK(Number(e.data.tokensBefore ?? 0))} → {fmtK(Number(e.data.tokensAfter ?? 0))} tok
              {" · "}{e.data.summarized ? `${e.data.summarized} summarized` : `${e.data.dropped} dropped`}
            </span>
          </summary>
          <Show when={e.data.summary}>
            <div class="vtitle" style="margin-top:6px">what the agent kept</div>
            <div class="content" innerHTML={renderMarkdownCached(String(e.data.summary))} />
          </Show>
        </details>
      );
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

/** session cost in USD: cents below $1, whole dollars above — no noise */
function costFmt(usd: number): string {
  if (usd >= 100) return Math.round(usd).toLocaleString();
  if (usd >= 10) return usd.toFixed(1);
  if (usd >= 1) return usd.toFixed(2);
  if (usd >= 0.01) return usd.toFixed(3);
  return usd.toFixed(4);
}

/** single-line preview with collapsed whitespace */
function oneLine(s: string, n: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return truncate(line, n);
}

/* ---------- copy-to-clipboard button ---------- */
/** Centered icon button — the shared home for emoji-glyph buttons. Emoji
 *  baselines sit off-center in plain text buttons, so every icon button
 *  should render through this (inline-flex centers the glyph properly). */
function IconBtn(props: {
  icon: string;
  title: string;
  onClick?: (e: MouseEvent) => void;
  active?: boolean;
  class?: string;
  style?: string;
}) {
  return (
    <button
      type="button"
      class={"iconbtn" + (props.active ? " active" : "") + (props.class ? " " + props.class : "")}
      title={props.title}
      onclick={props.onClick}
      style={props.style}
    >
      <span class="iconbtn-glyph">{props.icon}</span>
    </button>
  );
}

function CopyBtn(props: { text: string; label?: string; title?: string }) {
  const [done, setDone] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const copy = (e: MouseEvent) => {
    e.preventDefault(); // <summary> buttons must not toggle the details row
    e.stopPropagation();
    const text = props.text ?? "";
    if (!text) {
      setFailed(true); // nothing to copy — say so instead of a silent no-op
      setTimeout(() => setFailed(false), 1200);
      return;
    }
    // clipboard API needs focus + secure context; fall back to the ancient
    // execCommand path when it rejects (background tab, permission denial)
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setDone(true);
        setTimeout(() => setDone(false), 900);
      })
      .catch(() => {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
          setDone(true);
          setTimeout(() => setDone(false), 900);
        } catch {
          setFailed(true);
          setTimeout(() => setFailed(false), 1200);
        }
      });
  };
  return (
    <button
      class="copybtn"
      title={props.title ?? "copy to clipboard"}
      onclick={copy}
    >{done() ? "✓" : failed() ? "✗" : props.label ?? "⧉"}</button>
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

  // The server resolves each requested path (absolute + ~ expansion) and
  // returns the RESOLVED path as d.path plus its parent. Keep those in state:
  // the old ↑ button sent a bare "..", which the server resolved against ITS
  // cwd — so going up never worked from the picker.
  async function browse(p?: string) {
    const d = await api(`/api/fs?path=${encodeURIComponent(p ?? dir())}`);
    setDir(d.path);
    setParent(d.parent ?? "");
    setEntries(d.entries ?? []);
  }
  onMount(() => browse(dir()));
  const [parent, setParent] = createSignal("");

  const create = async (e: Event) => {
    e.preventDefault(); setErr("");
    try {
      const r = await api("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // start: false → the agent stays lazy/stopped; the first prompt (or
        // ▶ start) kicks off the loop, so no API call fires on an empty agent
        body: JSON.stringify({ workspace: dir(), id: name(), provider: provider() || undefined, model: model() || undefined, start: false }),
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
            <button type="button" title="parent directory" onclick={() => parent() ? browse(parent()) : browse("..")}>↑</button>
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
        <button type="submit" style="align-self:flex-end">create</button>
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
  ignored?: boolean;
}

type MediaKind = "image" | "video" | "audio";
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]);
function ficon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const mk = mediaKindOf(name);
  if (mk === "image") return "🖼";
  if (mk === "video") return "🎬";
  if (mk === "audio") return "🎵";
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return "🟦";
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return "🟨";
  if (ext === "json" || ext === "jsonc") return "🧾";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "📝";
  if (ext === "css" || ext === "scss" || ext === "less") return "🎨";
  if (ext === "html" || ext === "htm" || ext === "svg") return "🌐";
  if (["py", "pyi"].includes(ext)) return "🐍";
  if (ext === "rs") return "🦀";
  if (ext === "go") return "🐹";
  if (ext === "java" || ext === "kt" || ext === "kts") return "☕";
  if (ext === "rb") return "💎";
  if (ext === "php") return "🐘";
  if (ext === "c" || ext === "h" || ext === "cpp" || ext === "hpp" || ext === "cc") return "🧩";
  if (ext === "sh" || ext === "bash" || ext === "zsh" || ext === "fish") return "🐚";
  if (ext === "sql") return "🗄";
  if (ext === "yml" || ext === "yaml" || ext === "toml" || ext === "ini" || ext === "conf") return "⚙";
  if (ext === "lock") return "🔒";
  if (name === "Dockerfile" || ext === "dockerfile") return "🐳";
  if (ext === "zip" || ext === "gz" || ext === "tar" || ext === "tgz" || ext === "bz2") return "📦";
  if (ext === "pdf") return "📕";
  if (ext === "txt" || ext === "log") return "📄";
  return "·";
}

function mediaKindOf(path: string): MediaKind | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
}

function FilesPanel(props: { agentId: string; workspace: string }) {
  // path → lazily fetched child listing ("" = workspace root)
  const [kids, setKids] = createSignal<Map<string, TreeNode[]>>(new Map());
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [preview, setPreview] = createSignal<{
    path: string; content: string; binary?: boolean; truncated?: boolean;
  } | null>(null);
  const [err, setErr] = createSignal("");
  // gitignored files: "dim" (default) | "hide" | "show"
  const [ignoreMode, setIgnoreMode] = createSignal(
    localStorage.getItem("teapot.ignoreMode") ?? "dim",
  );
  const cycleIgnoreMode = () => {
    const order = ["dim", "hide", "show"] as const;
    const next = order[(order.indexOf(ignoreMode() as any) + 1) % 3];
    setIgnoreMode(next);
    localStorage.setItem("teapot.ignoreMode", next);
  };
  /** filter helper per current mode */
  // "hide" removes ignored entries entirely — INCLUDING ignored directories
  // (node_modules/, dist/…). The old `!n.dir` exception kept ignored dirs
  // visible, which read as the toggle being broken. Expanding a hidden dir is
  // still possible via 🙈→👁 if ever needed.
  const ignoreFilter = (n: TreeNode) => (ignoreMode() === "hide" ? !n.ignored : true);
  // show dotfiles — also persisted; toggling refetches the open dirs
  const [showHidden, setShowHidden] = createSignal(
    localStorage.getItem("teapot.showHidden") === "1",
  );
  const toggleHidden = () => {
    const next = !showHidden();
    // Fetch FIRST with the new flag, then flip the signal and patch the map
    // in place — flipping before the fetch landed left the tree showing its
    // old rows under a new filter (or nothing at all while in flight), which
    // collapsed .filebox and visibly reflowed the whole right panel.
    const targets = ["", ...expanded()];
    void Promise.all(targets.map(async (p) => ({ p, rows: await fetchDirWith(p, next) })))
      .then((results) => {
        setShowHidden(next);
        localStorage.setItem("teapot.showHidden", next ? "1" : "0");
        setKids((prev) => {
          const m = new Map(prev);
          for (const { p, rows } of results) if (rows) m.set(p, rows);
          return m;
        });
      });
  };

  const parseEntries = (parentPath: string, list: any[]): TreeNode[] =>
    list.map((e) => ({
      name: String(e.name),
      path: parentPath ? `${parentPath}/${e.name}` : String(e.name),
      dir: !!e.dir,
      ...(typeof e.size === "number" ? { size: e.size } : {}),
      ...(e.ignored ? { ignored: true } : {}),
    }));

  async function fetchDir(path: string): Promise<TreeNode[] | null> {
    return fetchDirWith(path, showHidden());
  }

  /** same, but with an explicit dotfiles flag (used by the toggle's pre-fetch) */
  async function fetchDirWith(path: string, hidden: boolean): Promise<TreeNode[] | null> {
    try {
      const qs = new URLSearchParams();
      if (path) qs.set("path", path);
      if (hidden) qs.set("hidden", "1");
      const r = await api(
        `/api/agents/${props.agentId}/tree?${qs.toString()}`,
      );
      return parseEntries(path, r.entries ?? []);
    } catch (ex) {
      setErr((ex as Error).message);
      return null;
    }
  }

  // reset & load the root whenever a DIFFERENT agent is selected. The guard
  // matters: agent snapshots update on every poll/event burst, and without it
  // each update cleared + re-fetched the whole tree (visible flicker and a
  // pointless /tree request per snapshot).
  let kidsFor = "";
  createEffect(() => {
    const id = props.agentId;
    if (id === kidsFor) return; // same agent — keep the loaded tree as-is
    kidsFor = id;
    setExpanded(new Set<string>());
    const map = new Map<string, TreeNode[]>();
    setKids(map);
    void fetchDir("").then((rows) => {
      if (rows && kidsFor === id) setKids(new Map([[ "", rows ]]));
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

  const [hlHtml, setHlHtml] = createSignal("");
  const [hlPending, setHlPending] = createSignal(false);
  // view mode: "code" (shiki) · "edit" (textarea + save) · "md" (rendered)
  const [viewMode, setViewMode] = createSignal<"code" | "edit" | "md" | "media">("code");
  const [editBuf, setEditBuf] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const isMd = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
  let hlRun = 0;
  const startHighlighting = async (p: { path: string; content: string; truncated?: boolean }) => {
    const run = ++hlRun;
    setHlHtml("");
    setHlPending(true);
    try {
      const { highlightChunks } = await import("./shiki");
      for await (const chunk of highlightChunks(p.path, p.content)) {
        if (hlRun !== run) return;
        setHlHtml((prev) => prev + chunk);
      }
    } catch {
      if (hlRun === run) setHlHtml(""); // give up → plain fallback
    } finally {
      if (hlRun === run) setHlPending(false);
    }
  };
  onCleanup(() => { hlRun++; });

  const [media, setMedia] = createSignal<{ path: string; kind: MediaKind } | null>(null);

  const openFileWith = async (
    node: TreeNode,
    mode: "code" | "edit" | "md",
  ) => {
    // media files stream from the raw endpoint instead of text preview
    const mk = mediaKindOf(node.path);
    if (mk) {
      setPreview({ path: node.path, content: "", binary: true });
      setMedia({ path: node.path, kind: mk });
      setViewMode("media");
      return;
    }
    try {
      const r = await api(
        `/api/agents/${props.agentId}/file?path=${encodeURIComponent(node.path)}`,
      );
      setMedia(null);
      setPreview({ path: node.path, content: r.content ?? "", binary: r.binary, truncated: r.truncated });
      setEditBuf(r.content ?? "");
      setViewMode(r.binary ? "code" : mode);
      if (!r.binary && mode !== "md") {
        startHighlighting({ path: node.path, content: r.content ?? "", truncated: r.truncated });
      }
    } catch (ex) {
      flashHint(`open failed: ${(ex as Error).message}`);
    }
  };

  /** PUT the edited buffer back; on conflict offer to load the disk version */
  const saveFile = async () => {
    const pv = preview();
    if (!pv || saving()) return;
    setSaving(true);
    try {
      await api(`/api/agents/${props.agentId}/file?path=${encodeURIComponent(pv.path)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: editBuf(), baseContent: pv.content }),
      });
      setPreview({ ...pv, content: editBuf() }); // new baseline for future conflicts
      flashHint(`saved ${pv.path}`);
    } catch (ex) {
      const raw = (ex as { payload?: unknown }).payload;
      const conflict =
        raw && typeof raw === "object" && (raw as any).error === "file changed on disk"
          ? (raw as { current?: string })
          : null;
      if (conflict?.current !== undefined) {
        // offer the fresh disk content instead of throwing away the save
        const take = confirm(
          "This file changed on disk since you opened it.\n" +
            "OK = load the disk version into the editor (your edits are discarded)\n" +
            "Cancel = keep editing your copy",
        );
        if (take) {
          setEditBuf(conflict.current!);
          setPreview({ ...pv, content: conflict.current! });
          flashHint("loaded the current file from disk");
        } else {
          flashHint("kept your edits — use Save As via bash to force-write");
        }
      } else {
        flashHint(`save failed: ${(ex as Error).message}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const isEditable = (pv: { binary?: boolean; truncated?: boolean }) =>
    !pv.binary && !pv.truncated;

  const row = (node: TreeNode, depth: number): any => (
    <>
      <div
        class={
          "filerow" + (node.dir ? " isdir" : "") +
          (node.ignored && ignoreMode() === "dim" ? " gitignored" : "")
        }
        style={`padding-left:${depth * 13 + 8}px`}
        onclick={() => (node.dir ? void toggleDir(node) : void openFileWith(node, "code"))}
        title={node.dir ? `browse ${node.path}` : `preview ${node.path}`}
      >
        <span class="ficon">{node.dir ? (expanded().has(node.path) ? "▾" : "▸") : ficon(node.name)}</span>
        <span class="fname">{node.name}</span>
        <Show when={!node.dir && node.size !== undefined}>
          <span class="fsize">{fmtK(node.size!)}</span>
        </Show>
      </div>
      <Show when={node.dir && expanded().has(node.path)}>
        <For each={(kids().get(node.path) ?? []).filter(ignoreFilter)}>{(child) => row(child, depth + 1)}</For>
      </Show>
    </>
  );

  const wsName = () => props.workspace.split("/").filter(Boolean).pop() ?? props.workspace;

  return (
    <>
      <h3 style="display:flex;align-items:center;gap:6px" title="the agent's workspace — lazy-loaded, dotfiles hidden; click a folder to expand, a file to preview">
        🗂 files <span class="muted" style="text-transform:none;letter-spacing:0">· {wsName()}</span>
        <IconBtn
          class="filetoggle"
          style="margin-left:auto"
          icon={ignoreMode() === "hide" ? "🙈" : ignoreMode() === "dim" ? "👁" : "✨"}
          title={`gitignored files: ${ignoreMode()} — click to cycle (dim → hidden → shown)`}
          onClick={cycleIgnoreMode}
        />
        <IconBtn
          class="filetoggle"
          icon={showHidden() ? "◉." : "○."}
          title={showHidden() ? "dotfiles shown — click to hide" : "dotfiles hidden — click to show"}
          onClick={toggleHidden}
        />
      </h3>
      <div class="filebox">
        <Show
          when={(kids().get("") ?? []).length > 0}
          fallback={<div class="muted" style="padding:6px">{err() || "empty workspace"}</div>}
        >
          <For each={(kids().get("") ?? []).filter(ignoreFilter)}>
            {(node) => row(node, 0)}
          </For>
        </Show>
      </div>
      <Show when={preview()}>
        {(pv) => (
          <Modal title={`🗂 ${pv().path}`} onClose={() => { hlRun++; setPreview(null); setMedia(null); }}>
            <Show
              when={media()}
              fallback={
                <>
                  <div class="filetoolbar">
                    <Show when={isMd(pv().path) && !pv().binary}>
                      <button class={viewMode() === "md" ? "on" : ""} onclick={() => setViewMode("md")} title="rendered markdown">👁 preview</button>
                    </Show>
                    <button class={viewMode() === "code" ? "on" : ""} onclick={() => { setViewMode("code"); if (!hlHtml()) startHighlighting({ path: pv().path, content: pv().content, truncated: pv().truncated }); }} title="syntax-highlighted source">{"</>"} code</button>
                    <Show when={isEditable(pv())}>
                      <button class={viewMode() === "edit" ? "on" : ""} onclick={() => setViewMode("edit")} title="edit and save back to the workspace">✎ edit</button>
                    </Show>
                  </div>
                  <Show
                    when={!pv().binary}
                    fallback={
                      <div class="mono" style="margin:0;color:var(--dim)">
                        (binary file — inspect it from the terminal)
                      </div>
                    }
                  >
                    <Show when={viewMode() === "edit"} fallback={
                      <Show when={viewMode() === "md" && isMd(pv().path)} fallback={
                        <CodePreview
                          path={pv().path}
                          content={pv().content}
                          html={hlHtml()}
                          pending={hlPending()}
                          truncated={!!pv().truncated}
                        />
                      }>
                        <div class="content mdpreview" innerHTML={renderMarkdown(pv().content)} />
                      </Show>
                    }>
                      <div class="fileeditor">
                        <textarea
                          class="mono"
                          value={editBuf()}
                          oninput={(e) => setEditBuf(e.currentTarget.value)}
                          spellcheck={false}
                        />
                        <div class="filerow-actions">
                          <span class="muted">{fmtK(editBuf().length)} bytes</span>
                          <button class="savebtn" disabled={saving() || editBuf() === pv().content} onclick={() => void saveFile()}>
                            {saving() ? "saving…" : "💾 save"}
                          </button>
                        </div>
                      </div>
                    </Show>
                  </Show>
                </>
              }
            >
              {/* media preview: stream raw bytes with native controls */}
              <div class="mediapreview">
                <Show when={media()!.kind === "image"} fallback={
                  <Show when={media()!.kind === "video"} fallback={
                    <audio controls src={`/api/agents/${props.agentId}/raw?path=${encodeURIComponent(media()!.path)}`} />
                  }>
                    <video controls src={`/api/agents/${props.agentId}/raw?path=${encodeURIComponent(media()!.path)}`} />
                  </Show>
                }>
                  <img src={`/api/agents/${props.agentId}/raw?path=${encodeURIComponent(media()!.path)}`} alt={media()!.path.split("/").pop()} />
                </Show>
                <div class="meta muted">{media()!.kind} preview</div>
              </div>
            </Show>
          </Modal>
        )}
      </Show>
    </>
  );
}

/* ---------- highlighted file preview body ---------- */

/**
 * Receives rendered shiki chunks as they stream in (`html` grows per chunk);
 * shows a lightweight loading hint until the first chunk lands.
 */
function CodePreview(props: { path: string; content: string; html: string; pending: boolean; truncated: boolean }) {
  return (
    <>
      <Show
        when={props.html}
        fallback={
          props.pending ? (
            <div class="muted" style="padding:8px;font-size:12px">
              ✨ highlighting {props.path.split("/").pop()}…
            </div>
          ) : (
            <pre class="mono" style="max-height:62vh;overflow:auto;white-space:pre-wrap;margin:0">
              {props.content}
            </pre>
          )
        }
      >
        {/* shiki emits its own <pre class="shiki"><code>…</code></pre>; content is shiki-generated HTML */}
        <div class="filepreview" innerHTML={props.html} />
      </Show>
      <Show when={props.truncated}>
        <div class="muted" style="padding-top:6px;font-size:11.5px">… truncated (first 100 KB)</div>
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
    { id: string; contextLength?: number; pricing?: { prompt: number; completion: number }; modalities?: { input: string[]; output: string[] } }[]
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
  // empty input = DERIVED budget (75% of each model's window) — the old UI
  // always showed 96 and saved it back on every settings save, silently
  // turning every agent into "manual override" at a fixed 96k that fit
  // neither 32k local models nor 1M-context ones. Null means "not set".
  const [ctxBudgetK, setCtxBudgetK] = createSignal<number | null>(
    props.cfg.contextTokenBudget != null ? Math.round(props.cfg.contextTokenBudget / 1000) : null,
  );
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
          ...(ctxBudgetK() != null ? { contextTokenBudget: Math.max(1, ctxBudgetK()!) * 1000 } : {}),
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
            <label title="auto-compact threshold in k tokens. Leave EMPTY to derive per model (75% of its context window) — recommended, since models differ wildly in window size. Set only to force an absolute cap across all models.">
              compact budget (k tok)
              <input
                type="number"
                min="0"
                placeholder="(derive: 75% of window)"
                value={ctxBudgetK() ?? ""}
                oninput={(e) => setCtxBudgetK(e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
              />
            </label>
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
