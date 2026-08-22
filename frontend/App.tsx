import { createSignal, onMount, For, Show, createMemo } from "solid-js";
import { renderMarkdown } from "./md";

/* ---------- types ---------- */
interface Agent {
  id: string; status: string; statusReason: string; workspace: string;
  session: string; branch: string; goal: { status: string; text: string };
  latestProgress: any; stats: any; model: string;
}
interface Ev {
  id: string; seq: number; ts: string; session: string; branch: string;
  type: string; parent: string | null; data: any;
}

const AUTHORS: Record<string, { name: string; icon: string; color: string }> = {
  user: { name: "you", icon: "🧑", color: "#faa81a" },
  message: { name: "agent", icon: "🫖", color: "#5865f2" },
  tool_call: { name: "tool", icon: "🔧", color: "#3ba0c9" },
  progress: { name: "progress", icon: "📈", color: "#3ba55d" },
};
const authorOf = (e: Ev) => AUTHORS[e.type] ?? { name: e.type, icon: "•", color: "#9298a5" };

const CHAT_TYPES = new Set(["user", "message", "prompt", "tool_call", "tool_result", "progress"]);
const isChat = (e: Ev) => CHAT_TYPES.has(e.type);
const fmtTs = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

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
  const loadCfg = () => api("/api/config").then(setCfg).catch(() => {});

  const sel = createMemo(() => agents().find((a) => a.id === selected()));

  const refreshAgents = () => api("/api/agents").then((d) => setAgents(d.agents)).catch(() => {});
  const refreshMetrics = () => api("/api/metrics").then(setMetrics).catch(() => {});

  async function loadEvents(id: string) {
    try {
      const [ev, br] = await Promise.all([
        api(`/api/agents/${id}/events?limit=300`),
        api(`/api/agents/${id}/branches`),
      ]);
      setEvents(ev.events);
      setBranches(br.branches);
    } catch { /* agent may be gone */ }
  }

  async function select(id: string) {
    setSelected(id);
    await loadEvents(id);
    requestAnimationFrame(scrollBottom);
  }

  function scrollBottom() {
    const f = document.querySelector(".feed");
    if (f) f.scrollTop = f.scrollHeight;
  }

  onMount(() => {
    loadCfg();
    refreshAgents().then(() => agents()[0] && select(agents()[0].id));
    refreshMetrics();
    // push updates via SSE; coalesce bursts at 400ms
    let timer: ReturnType<typeof setTimeout> | null = null;
    new EventSource("/api/events").onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (timer) return;
      timer = setTimeout(async () => {
        timer = null;
        await refreshAgents();
        await refreshMetrics();
        if (selected()) {
          const before = events().length;
          await loadEvents(selected()!);
          if (events().length !== before) scrollBottom();
        }
      }, 400);
    };
    setInterval(refreshMetrics, 30_000);
  });

  const send = async (e: Event) => {
    e.preventDefault();
    if (!selected() || !draft().trim()) return;
    const text = draft();
    setDraft("");
    await api(`/api/agents/${selected()}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, start: autoStart() }),
    });
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
    <div class="layout">
      {/* ---------- sidebar ---------- */}
      <nav class="sidebar">
        <h1>🫖 teapot
          <span style="float:right;display:flex;gap:4px">
            <button class="iconbtn" title="new agent" onclick={() => { loadCfg(); setShowNew(true); }}>＋</button>
            <button class="iconbtn" title="settings" onclick={() => { loadCfg(); setShowCfg(true); }}>⚙</button>
          </span>
        </h1>
        <For each={agents()}>
          {(a) => (
            <div class={"agent-item" + (a.id === selected() ? " sel" : "")} onclick={() => select(a.id)}>
              <span class={`dot ${a.status}`} />
              <span>{a.id}</span>
              <Show when={a.goal.status === "done"}><span title="goal done">✓</span></Show>
            </div>
          )}
        </For>
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
            <Show when={sel()!.statusReason}>
              <span class="sub">{sel()!.statusReason}</span>
            </Show>
            <span class="sub">{sel()!.model} · {sel()!.session}/{sel()!.branch} · turns {sel()!.stats.turns} · tools {sel()!.stats.toolCalls}</span>
          </header>

          <div class="feed">
            <For each={events().filter(isChat)}>
              {(e, i) => <MessageRow e={e} prev={events().filter(isChat)[i() - 1]} />}
            </For>
          </div>

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
              enter to send · prompts are appended to the conversation and the agent keeps working toward its goal
            </div>
          </div>
        </Show>
      </section>

      {/* ---------- right bar ---------- */}
      <aside class="rightbar">
        <Show when={sel()}>
          <h3>controls</h3>
          <div class="btnrow">
            <button onclick={act("/start")}>▶ start</button>
            <button onclick={act("/stop")}>■ stop</button>
            <button onclick={() => api(`/api/agents/${sel()!.id}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(() => select(sel()!.id))}>⑂ fork</button>
            <button onclick={async () => {
              if (!confirm(`remove agent ${sel()!.id}? (log is kept)`)) return;
              await api(`/api/agents/${sel()!.id}`, { method: "DELETE" });
              setSelected(null); setAgents(agents().filter((a) => a.id !== sel()!.id));
            }} title="remove agent">🗑</button>
          </div>

          <h3>goal <span class={`badge ${sel()!.goal.status === "done" ? "done" : ""}`}>{sel()!.goal.status}</span></h3>
          <form onsubmit={setGoal} style="display:flex;gap:4px;margin-bottom:6px">
            <input id="goal-input" type="text" placeholder="set new goal…" style="flex:1;background:var(--bg-darkest);border:none;border-radius:6px;padding:6px 8px;color:var(--fg);font:inherit" />
            <button type="submit" style="background:var(--acc);border:none;border-radius:6px;color:#fff;padding:0 10px;cursor:pointer">✓</button>
          </form>
          <div class="card">{sel()!.goal.text || "no goal set"}</div>

          <h3>latest progress</h3>
          <Show when={sel()!.latestProgress} fallback={<div class="muted">none yet</div>}>
            <div class="card">{sel()!.latestProgress.doing}{"\n"}{sel()!.latestProgress.recent ?? ""}
              {"\n"}<span class="muted">{sel()!.latestProgress.ts}</span></div>
          </Show>

          <h3>branches</h3>
          <For each={branches()}>
            {(b) => (
              <div class={"branch-row" + (b.branch === sel()!.branch ? " cur" : "")}>{b.branch}<span>{b.events}</span></div>
            )}
          </For>

          <h3>runtime</h3>
          <div class="card muted">turns {sel()!.stats.turns} · tools {sel()!.stats.toolCalls}
            {"\n"}tokens in/out {sel()!.stats.inputTokens}/{sel()!.stats.outputTokens}
            {"\n"}{sel()!.workspace}</div>
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
      return <div class="content" innerHTML={renderMarkdown(String(e.data.content ?? ""))} />;
    case "tool_call":
      return (
        <div class="embed">
          <b>⚙ {String(e.data.name)}</b>
          <div class="mono">{truncate(JSON.stringify(e.data.args, null, 1), 500)}</div>
        </div>
      );
    case "tool_result":
      return (
        <div class={"embed" + (e.data.ok ? "" : " fail")}>
          <div class="mono">{truncate(String(e.data.result), 700)}</div>
          <div class="meta">{e.data.durationMs}ms{e.data.ok ? "" : " · FAILED"}</div>
        </div>
      );
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
