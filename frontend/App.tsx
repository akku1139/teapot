import { createSignal, onMount, onCleanup, For, Show, createMemo, createEffect } from "solid-js";
import { renderMarkdown } from "./md";
import "@xterm/xterm/css/xterm.css";

/* ---------- types ---------- */
interface Agent {
  id: string; status: string; statusReason: string; workspace: string;
  session: string; branch: string; goal: { status: string; text: string };
  latestProgress: any; stats: any; model: string; provider?: string;
  pendingPrompts?: number;
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
};
const HARNESS_AUTH = { name: "harness", icon: "📣", color: "#3ba55d" };

/** author for an event — tool rows are named after the tool itself */
const authorOf = (e: Ev) => {
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
  "state", "error", "fork", "goal",
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
  const [branches, setBranches] = createSignal<any[]>([]);
  const [metrics, setMetrics] = createSignal<any>(null);
  const [draft, setDraft] = createSignal("");
  // persisted: "0" means the user explicitly turned auto-start off
  const [autoStart, setAutoStart] = createSignal(localStorage.getItem("teapot.autostart") !== "0");
  const setAutoStartPersist = (v: boolean) => {
    setAutoStart(v);
    localStorage.setItem("teapot.autostart", v ? "1" : "0");
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
  // model switcher state
  const [modelProvider, setModelProvider] = createSignal("");
  const [modelDraft, setModelDraft] = createSignal("");
  const [models, setModels] = createSignal<string[]>([]);
  const providerList = () => Object.keys(cfg().providers ?? {});
  async function loadModels(prov: string) {
    if (!prov) return;
    try {
      const r = await api(`/api/models?provider=${encodeURIComponent(prov)}`);
      setModels(r.models ?? []);
    } catch { setModels([]); }
  }
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
    return events().filter((e) => FEED_TYPES.has(e.type) && !(e.type === "tool_result" && consumed.has(e.id)));
  });
  const loadCfg = () => api("/api/config").then(setCfg).catch(() => {});

  const sel = createMemo(() => agents().find((a) => a.id === selected()));
  // prompt being edited → edit-prompt fork dialog
  const [editing, setEditing] = createSignal<{ eventId: string; text: string } | null>(null);

  const refreshAgents = () => api("/api/agents").then((d) => setAgents(d.agents)).catch(() => {});
  const refreshMetrics = () => api("/api/metrics").then(setMetrics).catch(() => {});

  // scheduled (cron) tasks — shown in the right panel so "what runs when" is legible
  const [tasks, setTasks] = createSignal<any[]>([]);
  const loadTasks = () => api("/api/tasks").then((d) => setTasks(d.tasks)).catch(() => {});
  const agentTasks = (id: string | null) => tasks().filter((t) => t.agent === id);

  // null = show everything; otherwise only the chosen branch's events
  const [branchFilter, setBranchFilter] = createSignal<string | null>(null);
  async function loadEvents(id: string) {
    try {
      const bf = branchFilter();
      const [ev, br] = await Promise.all([
        api(`/api/agents/${id}/events?limit=300${bf ? `&branch=${encodeURIComponent(bf)}` : ""}`),
        api(`/api/agents/${id}/branches`),
      ]);
      setEvents(ev.events);
      setBranches(br.branches);
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
          const before = events().length;
          const fetchStartedAt = Date.now();
          await loadEvents(selected()!);
          if (events().length !== before) {
            // keep the bubble only if THIS agent streamed a delta after the
            // fetch started (i.e. the bubble shows something newer than
            // everything persisted). Otherwise it must go — otherwise a
            // stale "thinking…"/duplicate bubble outlives an idle agent.
            const stillStreaming = lastDelta?.id === selected() && lastDelta.at >= fetchStartedAt;
            if (!stillStreaming) setLive(null);
            if (nearBottom()) scrollBottom(true);
            else setMissed(missed() + (events().length - before));
          }
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
      const list = agents();
      if (list.length === 0) return;
      e.preventDefault();
      const idx = list.findIndex((a) => a.id === selected());
      const next = e.key === "ArrowDown" ? Math.min(idx + 1, list.length - 1) : Math.max(idx - 1, 0);
      if (next !== idx) select(list[next].id);
    }
  });

  /* ---------- human terminal (bottom drawer, xterm.js over WS) ---------- */
  const [termOpen, setTermOpen] = createSignal(localStorage.getItem("teapot.term") === "1");
  const toggleTerm = () => {
    const next = !termOpen();
    setTermOpen(next);
    localStorage.setItem("teapot.term", next ? "1" : "0");
  };
  let termHost: HTMLDivElement | null = null;
  let xterm: any = null;
  let fitAddon: any = null;
  let termWs: WebSocket | null = null;
  let ro: ResizeObserver | null = null;
  let lastResize = { cols: 0, rows: 0 };
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  function closeTerm() {
    ro?.disconnect();
    ro = null;
    termWs?.close();
    termWs = null;
    xterm?.dispose();
    xterm = null;
    fitAddon = null;
  }
  function openTerm(agentId: string) {
    closeTerm();
    if (!termHost) return;
    Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(
      ([{ Terminal }, { FitAddon }]) => {
        const t = new Terminal({
          cursorBlink: true,
          fontSize: 12.5,
          fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
          theme: { background: "#0d0e12", foreground: "#dcdee4" },
        });
        const f = new FitAddon();
        t.loadAddon(f);
        t.open(termHost!);
        f.fit();
        xterm = t;
        fitAddon = f;
        const proto = location.protocol === "https:" ? "wss://" : "ws://";
        const w = new WebSocket(`${proto}${location.host}/api/agents/${agentId}/term${wsTokenQuery()}`);
        termWs = w;
        w.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.kind === "data") t.write(msg.data);
          else if (msg.kind === "exit") t.write(`\r\n\x1b[2m[terminal exited ${msg.code ?? ""}]\x1b[0m\r\n`);
        };
        t.onData((d) => {
          if (w.readyState === WebSocket.OPEN) w.send(JSON.stringify({ kind: "input", data: d }));
        });
        const pushResize = () => {
          try { f.fit(); } catch { /* host hidden */ }
          const { cols, rows } = t;
          if ((cols !== lastResize.cols || rows !== lastResize.rows) && w.readyState === WebSocket.OPEN) {
            lastResize = { cols, rows };
            w.send(JSON.stringify({ kind: "resize", cols, rows }));
          }
        };
        ro = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(pushResize, 300); // debounce: stty injection is visible
        });
        ro.observe(termHost!);
        setTimeout(pushResize, 50);
      },
    );
  }
  createEffect(() => {
    const id = selected();
    const open = termOpen();
    if (!open || !id) closeTerm();
    else requestAnimationFrame(() => id && openTerm(id));
  });
  onCleanup(closeTerm);

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
    connectWs();
    const mi = setInterval(() => {
      refreshMetrics();
      loadTasks();
    }, 30_000);
    onCleanup(() => clearInterval(mi));
  });

  const [flash, setFlash] = createSignal("");
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const flashHint = (msg: string) => {
    setFlash(msg);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlash(""), 3200);
  };

  const SLASH_COMMANDS = [
    { cmd: "/start", desc: "start working toward the goal" },
    { cmd: "/stop", desc: "interrupt the running agent" },
    { cmd: "/fork", desc: "branch the conversation here" },
    { cmd: "/goal", desc: "/goal <text> — set goal & notify the agent" },
  ];
  // popup shows while typing the first token of a command
  const filteredCmds = () => {
    const d = draft();
    if (!d.startsWith("/") || d.includes(" ") || d.includes("\n")) return [];
    return SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(d.slice(1).toLowerCase()));
  };

  const send = async (e: Event) => {
    e.preventDefault();
    const id = selected();
    const text = draft().trim();
    if (!id || !text) return;

    // slash commands are client-side operations
    if (text.startsWith("/")) {
      const sp = text.indexOf(" ");
      const name = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
      const arg = sp === -1 ? "" : text.slice(sp + 1).trim();
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
        else if (name === "goal") {
          if (!arg) { flashHint("usage: /goal <text>"); return; }
          await post("/goal", { text: arg, notify: true });
          flashHint("goal saved & notification queued");
        } else {
          flashHint(`unknown command "${name}" — /start /stop /fork /goal`);
          return;
        }
        setDraft("");
      } catch (ex) {
        flashHint(`/${name} failed: ${(ex as Error).message}`);
      }
      return;
    }

    setDraft("");
    try {
      await api(`/api/agents/${id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, start: autoStart() }),
      });
    } catch (ex) {
      setDraft(text); // never eat the user's message on a failed send
      console.error("send failed:", ex);
    }
  };

  const act = (path: string) =>
    () => selected() && api(`/api/agents/${selected()}${path}`, { method: "POST" }).then(refreshAgents);

  const setGoal = async (e: Event) => {
    e.preventDefault();
    const input = document.getElementById("goal-input") as HTMLInputElement;
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
    <div class={"layout" + (showRight() ? "" : " right-hidden")}>
      {/* ---------- sidebar ---------- */}
      <nav class="sidebar">
        <h1>🫖 teapot
          <span class={"conn" + (connected() ? " ok" : "")} title={connected() ? "live (websocket)" : "reconnecting…"} />
          <span style="float:right;display:flex;gap:4px">
            <button class="iconbtn" title="new agent" onclick={() => { loadCfg(); setShowNew(true); }}>＋</button>
            <button class="iconbtn" title="settings" onclick={() => { loadCfg(); setShowCfg(true); }}>⚙</button>
          </span>
        </h1>
        <div class="agent-list">
          <For each={agents()}>
            {(a) => (
              <div class={"agent-item" + (a.id === selected() ? " sel" : "")} onclick={() => select(a.id)}>
                <span class={`dot ${a.status}`} />
                <span>{a.id}</span>
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

          <div class="feed" onscroll={() => { const nb = nearBottom(); if (nb && missed()) setMissed(0); setAtBottom(nb); }}>
            <Show when={chatEvents().length > 0} fallback={
              <div style="display:grid;place-items:center;height:100%" class="muted">no events yet — say something or press ▶ start</div>
            }>
              <For each={chatEvents()}>
                {(e, i) => (
                  <MessageRow
                    e={e}
                    prev={chatEvents()[i() - 1]}
                    res={pairInfo().resFor.get(e.id)}
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
                      when={live()!.text}
                      fallback={<div class="content muted">thinking…</div>}
                    >
                      <div class="content">{live()!.text}<span class="cursor">▍</span></div>
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

          <Show when={termOpen() && sel()}>
            <div class="termdrawer">
              <div class="termbar">
                <span>⌨ terminal — <span class="mono">{sel()!.workspace}</span></span>
                <button class="iconbtn" title="close terminal (t)" onclick={toggleTerm}>✕</button>
              </div>
              <div class="termhost" ref={(el) => (termHost = el)} />
            </div>
          </Show>

          <div class="composer">
            <Show when={filteredCmds().length > 0}>
              <div class="cmds">
                <For each={filteredCmds()}>
                  {(c) => (
                    <div class="cmdrow" title={c.desc} onclick={() => setDraft(c.cmd + " ")}>
                      <b>{c.cmd}</b>
                      <span class="muted">{c.desc}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <form onsubmit={send}>
              <textarea
                rows={1}
                placeholder={`message #${sel()!.id} — / for commands`}
                value={draft()}
                oninput={(e) => setDraft(e.currentTarget.value)}
                onkeydown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(e);
                  }
                }}
              />
              <label
                title="when unchecked, sending only queues the prompt without waking an idle agent"
              >
                <input
                  type="checkbox"
                  checked={autoStart()}
                  onchange={(e) => setAutoStartPersist(e.currentTarget.checked)}
                />
                start if idle
              </label>
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
          <h3>🎛 session</h3>
          <div class="card sesscard">
            <div class="sessrow"><span class="k">agent</span><b>{sel()!.id}</b><span class={`badge ${sel()!.status}`}>{sel()!.status}</span></div>
            <div class="sessrow"><span class="k">workspace</span><span class="mono ellip" title={sel()!.workspace}>{sel()!.workspace}</span></div>
            <div class="sessrow"><span class="k">session</span><span class="mono">{sel()!.session}/{sel()!.branch}</span></div>
          </div>

          <h3>🧦 model</h3>
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
                <For each={models()}>{(m) => <option value={m} />}</For>
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
                      body: JSON.stringify({ provider: modelProvider(), model: modelDraft().trim() || undefined }),
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
            <div class="meta">current: {sel()!.model}<Show when={models().length}> · {models().length} models loaded</Show></div>
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
          </div>

          <h3>🎯 goal <span class={`badge ${sel()!.goal.status === "done" ? "done" : ""}`}>{sel()!.goal.status}</span></h3>
          <form onsubmit={setGoal} style="display:flex;gap:4px;margin-bottom:6px">
            <input id="goal-input" type="text" placeholder="set new goal…" style="flex:1;background:var(--bg-darkest);border:none;border-radius:6px;padding:6px 8px;color:var(--fg);font:inherit" />
            <label
              class="muted"
              style="display:flex;align-items:center;gap:3px;font-size:11px;white-space:nowrap;cursor:pointer"
              title="queue a harness prompt telling the agent about the new goal at its next turn boundary"
            >
              <input id="goal-notify" type="checkbox" checked /> notify
            </label>
            <button type="submit" style="background:var(--acc);border:none;border-radius:6px;color:#fff;padding:0 10px;cursor:pointer">✓</button>
          </form>
          <div class="card">{sel()!.goal.text || "no goal set — the agent has nothing to auto-continue toward"}</div>
          <div class="muted" style="font-size:11px;margin-top:4px">
            stored with the session · the model reads it via get_goal() ·
            <Show when={sel()!.goal.text && sel()!.goal.status === "active"}> auto-continue keeps it working until this is done</Show>
            <Show when={!sel()!.goal.text}> set one and tick ▶ start to begin</Show>
          </div>

          <h3>📈 progress</h3>
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

          <h3>📊 runtime</h3>
          <div class="card muted">
            turns {sel()!.stats.turns} · tools {sel()!.stats.toolCalls} · compacted {sel()!.stats.compactions ?? 0}
            {"\n"}tokens in/out {sel()!.stats.inputTokens}/{sel()!.stats.outputTokens}
            <Show when={sel()!.ctx}>
              {(c) => (
                <>
                  {"\n"}context ~{fmtK(c().usedTokens)} tok
                  <Show when={c().window}> · {Math.min(999, Math.round((c().usedTokens / c().window) * 100))}% of {fmtK(c().window)}</Show>
                  {"\n"}compaction at ~{fmtK(c().compactAt)} tok (older turns summarized)
                </>
              )}
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
                  if (selected()) await select(selected());
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
              <a href={argStr("url")} target="_blank" rel="noopener noreferrer">open ↗</a>
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
        <span class="meta">{res ? hint || "" : "running…"}</span>
      </summary>
      {body}
    </details>
  );
}

function MessageRow(props: { e: Ev; prev?: Ev; res?: Ev; onEdit?: () => void }) {
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
  if (e.type === "state") {
    if (e.data.from === e.data.to) return null;
    return (
      <div class={"divider-msg" + (e.data.to === "error" ? " err" : "")}>
        {e.data.from} → {e.data.to}{e.data.reason ? ` — ${e.data.reason}` : ""}
      </div>
    );
  }

  return (
    <div class={"msg" + (grouped ? " grouped" : "")}>
      <Show when={!grouped} fallback={<span style="width:38px" />}>
        <div class="avatar" style={{ background: a.color + "33", border: `1px solid ${a.color}66` }}>{a.icon}</div>
      </Show>
      <div class="msg-body">
        <Show when={!grouped}>
          <div class="msg-head">
            <span class="author" style={{ color: a.color }}>{a.name}</span>
            <span class="ts">{fmtTs(e.ts)}</span>
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

        <SwitchContent e={e} res={props.res} />
      </div>
    </div>
  );
}

function SwitchContent(props: { e: Ev; res?: Ev }) {
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

/** compact token counts: 12345 → "12k", 980 → "980" */
function fmtK(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
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

/* ---------- settings / config editor ---------- */
function ConfigModal(props: { cfg: any; onClose: () => void; onSaved: () => void }) {
  const [provText, setProvText] = createSignal(
    JSON.stringify(Object.fromEntries(Object.entries(props.cfg.providers ?? {}).map(([k, v]: [string, any]) => [k, { baseUrl: v.baseUrl, apiKey: v.apiKey ?? "", model: v.model ?? "" }])), null, 2),
  );
  const [defaultProvider, setDefaultProvider] = createSignal(props.cfg.defaultProvider ?? Object.keys(props.cfg.providers ?? {})[0] ?? "");
  const [intervalMin, setIntervalMin] = createSignal(Math.round((props.cfg.progressIntervalMs ?? 600000) / 60000));
  const [tasksText, setTasksText] = createSignal(JSON.stringify(props.cfg.tasks ?? [], null, 2));
  const [err, setErr] = createSignal("");

  const save = async (e: Event) => {
    e.preventDefault(); setErr("");
    let providers, tasks;
    try { providers = JSON.parse(provText()); } catch { return setErr("providers: invalid JSON"); }
    try { tasks = JSON.parse(tasksText()); } catch { return setErr("tasks: invalid JSON"); }
    try {
      await api("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providers, defaultProvider: defaultProvider(),
          progressIntervalMs: Math.max(1, intervalMin()) * 60000,
          tasks,
        }),
      });
      props.onSaved(); props.onClose();
    } catch (ex) { setErr(String((ex as Error).message)); }
  };

  return (
    <Modal title="settings" onClose={props.onClose}>
      <form onsubmit={save} style="display:flex;flex-direction:column;gap:10px">
        <label>providers ({props.cfg.configPath})
          <textarea rows={8} class="mono w100" value={provText()} oninput={(e) => setProvText(e.currentTarget.value)} />
        </label>
        <div style="display:flex;gap:10px">
          <label style="flex:1">default provider <input type="text" value={defaultProvider()} oninput={(e) => setDefaultProvider(e.currentTarget.value)} /></label>
          <label>progress interval (min) <input type="number" min="1" style="width:90px" value={intervalMin()} oninput={(e) => setIntervalMin(Number(e.currentTarget.value))} /></label>
        </div>
        <label>scheduled tasks (JSON array)
          <textarea rows={7} class="mono w100" value={tasksText()} oninput={(e) => setTasksText(e.currentTarget.value)} />
        </label>
        <Show when={err()}><span style="color:var(--err);font-size:13px">{err()}</span></Show>
        <button type="submit" style="align-self:flex-end">save</button>
      </form>
    </Modal>
  );
}
