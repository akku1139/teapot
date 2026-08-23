import { createSignal, onMount, onCleanup, For, Show, createMemo, createEffect } from "solid-js";
import { renderMarkdown } from "./md";
import "@xterm/xterm/css/xterm.css";

/* ---------- types ---------- */
interface Agent {
  id: string; status: string; statusReason: string; workspace: string;
  session: string; branch: string; goal: { status: string; text: string };
  latestProgress: any; stats: any; model: string; provider?: string;
  pendingPrompts?: number;
}
interface Ev {
  id: string; seq: number; ts: string; session: string; branch: string;
  type: string; parent: string | null; data: any;
}

const AUTHORS: Record<string, { name: string; icon: string; color: string }> = {
  prompt: { name: "you", icon: "🟧", color: "#faa81a" },
  user: { name: "you", icon: "🟧", color: "#faa81a" },
  message: { name: "agent", icon: "🫖", color: "#5865f2" },
  tool_call: { name: "tool", icon: "🔧", color: "#3ba0c9" },
  progress: { name: "progress", icon: "📈", color: "#3ba55d" },
};
const authorOf = (e: Ev) => AUTHORS[e.type] ?? { name: e.type, icon: "•", color: "#9298a5" };

// state/error/fork/goal render as dividers or embeds inside the feed
const CHAT_TYPES = new Set([
  "user", "message", "prompt", "tool_call", "tool_result", "progress",
  "state", "error", "fork", "goal",
]);
const isChat = (e: Ev) => CHAT_TYPES.has(e.type);
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
  const [autoStart, setAutoStart] = createSignal(true);
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
  const chatEvents = createMemo(() => events().filter(isChat));
  const loadCfg = () => api("/api/config").then(setCfg).catch(() => {});

  const sel = createMemo(() => agents().find((a) => a.id === selected()));

  const refreshAgents = () => api("/api/agents").then((d) => setAgents(d.agents)).catch(() => {});
  const refreshMetrics = () => api("/api/metrics").then(setMetrics).catch(() => {});

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
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.kind === "ping" || msg.kind === "pong") return;
      if (msg.kind === "llm-delta") {
        if (msg.agentId === selected()) setLive({ text: msg.text ?? "", reasoning: msg.reasoning ?? "" });
        return;
      }
      if (timer) return;
      timer = setTimeout(async () => {
        timer = null;
        await refreshAgents();
        await refreshMetrics();
        if (selected()) {
          const before = events().length;
          await loadEvents(selected()!);
          if (events().length !== before) {
            setLive(null); // a persisted event landed — live bubble is now history
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
      document.querySelector<HTMLInputElement>(".composer input[type=text]")?.focus();
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
    connectWs();
    const mi = setInterval(refreshMetrics, 30_000);
    onCleanup(() => clearInterval(mi));
  });

  const send = async (e: Event) => {
    e.preventDefault();
    const id = selected();
    const text = draft().trim();
    if (!id || !text) return;
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
    if (!selected() || !input.value.trim()) return;
    await api(`/api/agents/${selected()}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: input.value }),
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
                {(e, i) => <MessageRow e={e} prev={chatEvents()[i() - 1]} />}
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
            <form onsubmit={send}>
              <input
                type="text"
                placeholder={`message #${sel()!.id}`}
                value={draft()}
                oninput={(e) => setDraft(e.currentTarget.value)}
              />
              <label>
                <input type="checkbox" checked={autoStart()} onchange={(e) => setAutoStart(e.currentTarget.checked)} />
                auto-start
              </label>
              <button type="submit">send</button>
            </form>
            <div class="hint">
              enter send · ↑↓ sessions · / focus · t terminal · d panel · esc interrupt ·
              messages sent while the agent works are queued and delivered at the next turn boundary
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
            <button onclick={act("/start")} title="run toward the goal (starts the loop)">▶ start</button>
            <button onclick={act("/stop")} title="interrupt: aborts the current LLM call; the running tool finishes first">■ stop</button>
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
            <button type="submit" style="background:var(--acc);border:none;border-radius:6px;color:#fff;padding:0 10px;cursor:pointer">✓</button>
          </form>
          <div class="card">{sel()!.goal.text || "no goal set"}</div>

          <h3>📈 progress</h3>
          <Show when={sel()!.latestProgress} fallback={<div class="muted">none yet</div>}>
            <div class="card">{sel()!.latestProgress.doing}{"\n"}{sel()!.latestProgress.recent ?? ""}
              {"\n"}<span class="muted">{sel()!.latestProgress.ts}</span></div>
          </Show>

          <h3>📊 runtime</h3>
          <div class="card muted">turns {sel()!.stats.turns} · tools {sel()!.stats.toolCalls} · compacted {sel()!.stats.compactions ?? 0}
            {"\n"}tokens in/out {sel()!.stats.inputTokens}/{sel()!.stats.outputTokens}</div>

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
      <ConfigModal cfg={cfg()} onClose={() => setShowCfg(false)} onSaved={loadCfg} />
    </Show>
    </>
  );
}

/* ---------- one chat message row ---------- */
function MessageRow(props: { e: Ev; prev?: Ev }) {
  const e = props.e;
  const a = authorOf(e);
  const grouped =
    props.prev && props.prev.type === e.type &&
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
          </div>
        </Show>

        <SwitchContent e={e} />
      </div>
    </div>
  );
}

function SwitchContent(props: { e: Ev }) {
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
          <Show when={e.data.final}>
            <div class="msgfoot"><CopyBtn text={String(e.data.content ?? "")} /><span>copy summary</span></div>
          </Show>
        </>
      );
    case "tool_call": {
      const args = JSON.stringify(e.data.args, null, 1);
      const preview = oneLine(JSON.stringify(e.data.args ?? {}), 110);
      return (
        <details class="embed">
          <summary><b>⚙ {String(e.data.name)}</b> <span class="meta">{preview}</span></summary>
          <div class="mono">{args}</div>
        </details>
      );
    }
    case "tool_result": {
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
