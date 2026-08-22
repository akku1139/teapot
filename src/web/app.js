/**
 * teapot web UI — vanilla ES module, no framework, no build step.
 * Updates arrive via SSE (event-driven; no polling loop).
 */
import { renderMarkdown } from "./md.js";

let agents = [];
let selected = null;
const $ = (id) => document.getElementById(id);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

/* ---------- SSE: push-based refresh ---------- */
const dirty = new Set();
new EventSource("/api/events").onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.kind === "hello" || msg.kind === "agent-update") {
    dirty.add(msg.agentId ?? null);
    scheduleRefresh();
  }
};
let refreshTimer = null;
function scheduleRefresh() {
  // coalesce bursts into one fetch per 500ms (keeps CPU flat)
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    await loadAgents();
    for (const id of dirty) if (id === selected || dirty.has(null)) await select(id ?? selected);
    dirty.clear();
  }, 500);
}

/* ---------- rendering ---------- */
async function loadAgents() {
  const data = await api("/api/agents");
  agents = data.agents;
  const nav = $("agent-list");
  nav.innerHTML = "";
  for (const a of agents) {
    const div = document.createElement("div");
    div.className = "agent" + (a.id === selected ? " sel" : "");
    div.innerHTML = `<div>${a.id}</div><div class="muted"><span class="badge ${a.status}">${a.status}</span> ${
      a.goal?.status === "done" ? "goal ✓" : ""
    } ${a.latestProgress ? "📝" : ""}</div>`;
    div.onclick = () => select(a.id);
    nav.appendChild(div);
  }
  const m = await api("/api/metrics");
  $("metrics").textContent =
    `master rss=${m.rssMb}MB heap=${m.heapUsedMb}MB load1=${m.loadavg1} ` +
    `turns=${m.agents.reduce((s, a) => s + a.turns, 0)} tools=${m.agents.reduce((s, a) => s + a.toolCalls, 0)}`;
}

async function select(id) {
  if (!id) return;
  selected = id;
  try {
    var a = await api(`/api/agents/${id}`);
  } catch { return; }
  $("placeholder").hidden = true;
  $("pane").hidden = false;
  $("a-id").textContent = a.id;
  $("a-status").textContent = a.status + (a.statusReason ? ` — ${a.statusReason}` : "");
  $("a-status").className = `badge ${a.status}`;
  $("a-model").textContent = a.model;
  $("branch-info").textContent = `${a.session} / ${a.branch}`;
  $("goal-text").textContent = a.goal.text || "(no goal set)";
  $("goal-status").textContent = a.goal.status;
  const p = a.latestProgress;
  $("progress").innerHTML = p
    ? `<b>${esc(p.doing)}</b>\n${p.recent ? esc(p.recent) + "\n" : ""}${
        p.problems ? "⚠ " + esc(p.problems) + "\n" : ""}${p.next ? "→ " + esc(p.next) : ""}
       <span class="muted">${p.ts}</span>`
    : "none yet";
  $("runtime").textContent =
    `turns=${a.stats.turns} toolCalls=${a.stats.toolCalls} ` +
    `tokens in/out=${a.stats.inputTokens}/${a.stats.outputTokens}`;
  await loadEvents(a);
  document.querySelectorAll("nav .agent").forEach((el, i) =>
    el.classList.toggle("sel", agents[i]?.id === id),
  );
}

async function loadEvents(agent) {
  const data = await api(`/api/agents/${agent.id}/events?limit=150`);
  $("ev-count").textContent = `(${data.total})`;
  const box = $("events");
  box.innerHTML = "";
  for (const e of data.events.slice(-150)) box.appendChild(eventEl(e));
  box.scrollTop = box.scrollHeight;
}

function eventEl(e) {
  const div = document.createElement("div");
  div.className = `event type-${e.type}`;
  const time = e.ts.slice(11, 19);
  let body = "";
  switch (e.type) {
    case "message":
      body = renderMarkdown(String(e.data.content ?? ""));
      break;
    case "prompt":
      body = `<b>user:</b> ${renderMarkdown(String(e.data.text ?? ""))}`;
      break;
    case "tool_call":
      body = `<b>tool:</b> ${esc(e.data.name)} <code>${esc(JSON.stringify(e.data.args)).slice(0, 300)}</code>`;
      break;
    case "tool_result":
      body = `<b>${e.data.ok ? "ok" : "FAIL"}:</b> ${esc(String(e.data.result)).slice(0, 600)} <span class="muted">(${e.data.durationMs}ms)</span>`;
      break;
    case "progress":
      body = `<b>progress:</b> ${esc(e.data.doing ?? "")}`;
      break;
    case "state":
      body = `state ${esc(e.data.from)} → ${esc(e.data.to)}${e.data.reason ? " (" + esc(e.data.reason) + ")" : ""}`;
      break;
    case "fork":
      body = `⑂ fork from ${esc(e.data.fromBranch)} @${esc(e.data.fromEvent ?? "")}`;
      break;
    case "error":
      body = `<b>error:</b> ${esc(e.data.message ?? "")}`;
      break;
    default:
      body = esc(JSON.stringify(e.data).slice(0, 300));
  }
  div.innerHTML =
    `<span class="t">${time}</span>` +
    `<span class="badge">${e.type}</span>` +
    `<span class="t">${e.session}/${e.branch}</span>` +
    `<div class="md">${body}</div>`;
  return div;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ---------- actions ---------- */
$("btn-start").onclick = () => api(`/api/agents/${selected}/start`, { method: "POST" }).then(loadAgents);
$("btn-stop").onclick = () => api(`/api/agents/${selected}/stop`, { method: "POST" }).then(loadAgents);
$("btn-fork").onclick = async () => {
  await api(`/api/agents/${selected}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await loadAgents();
  await select(selected);
};
$("prompt-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const text = $("prompt-input").value.trim();
  if (!text) return;
  $("prompt-input").value = "";
  await api(`/api/agents/${selected}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, start: $("prompt-start").checked }),
  });
};
$("goal-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const text = $("goal-input").value.trim();
  if (!text) return;
  $("goal-input").value = "";
  await api(`/api/agents/${selected}/goal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
};

loadAgents().then(() => agents[0] && select(agents[0].id));
setInterval(loadAgents, 30_000); // light fallback only
