# teapot 🫖

A lightweight harness for running many AI coding agents continuously — simpler
and lighter than existing harnesses. No TUI. One small web server, a browser
tab, and any number of long-running agents.

## Design principles

- **TypeScript + Node.js**, minimal dependencies (`hono`, `openai`, `@hono/node-server`)
- **Idle cost ≈ 0**: no polling loops; everything is event-driven or driven by
  one 15-second scheduler tick. Verified: master sits at ~0% CPU when idle.
- **No TUI** — Discord-style chat UI built with **SolidJS + Vite**
  (`frontend/`, built to `public/`): agents as channels, events flowing as chat
  messages, tool calls as compact embeds. Markdown is rendered by a hand-written,
  XSS-safe renderer (`frontend/md.js`)
- **Integrated terminal** — humans get an interactive shell (xterm.js over
  WebSocket) inside the selected agent's workspace: inspect what the agent
  did, run tests, fix things alongside it. Zero native dependencies — the PTY
  comes from util-linux `script` when available (colors, line editing,
  ctrl+c), with a plain-pipe fallback elsewhere.
- **Human-readable persistence** — append-only JSONL event logs you can read
  with `cat` / `jq`; goal & memory as plain Markdown files in git

## Quick start

Requires Node.js **>= 24** (TypeScript is executed natively in dev mode).

### Install globally from npm

```sh
npm install -g teapot-coding-agent
mkdir -p ~/.config/teapot-coding-agent
curl -o ~/.config/teapot-coding-agent/config.json \
  https://raw.githubusercontent.com/akku1139/teapot/main/teapot.config.example.json  # then edit it
teapot
# open http://localhost:7788
```

The global install puts a `teapot` binary on your PATH (it serves the compiled
server plus the pre-built web UI — no build step, no repo checkout needed).
Alternatives:

```sh
npx teapot-coding-agent          # run without installing
teapot ~/my-config.json          # explicit config path
TEAPOT_PORT=8080 teapot          # env overrides work as usual
```

### Run from a checkout (development)

```sh
pnpm install
mkdir -p ~/.config/teapot-coding-agent
cp teapot.config.example.json ~/.config/teapot-coding-agent/config.json  # edit it
pnpm dev            # or: pnpm build && pnpm start
# open http://localhost:7788
```

Config lookup order: CLI arg → `$TEAPOT_CONFIG` →
`~/.config/teapot-coding-agent/config.json` → `./teapot.config.json` (legacy).
Data (event logs) goes to `~/.local/share/teapot-coding-agent` by default.
Env overrides: `TEAPOT_PORT`, `TEAPOT_API_KEY`, `TEAPOT_BASE_URL`,
`TEAPOT_MODEL`, `TEAPOT_CONFIG_DIR`, `TEAPOT_DATA_DIR`.

## Multiple providers

Agents are matched to named OpenAI-compatible providers:

```jsonc
{
  "providers": {
    "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "sk-or-..." },
    "local":      { "baseUrl": "http://localhost:11434/v1", "apiKey": "ollama", "model": "qwen3-coder" }
  },
  "defaultProvider": "openrouter",
  "agents": [
    { "id": "alpha", "workspace": "workspaces/alpha" },                          // default provider
    { "id": "beta",  "workspace": "workspaces/beta", "provider": "local" },      // local model
    { "id": "gamma", "workspace": "workspaces/gamma", "provider": "openrouter",
      "model": "anthropic/claude-sonnet-4" }                                     // per-agent model
  ]
}
```

Per-agent inline `baseUrl`/`apiKey`/`model` override the provider entry.

## Architecture

```
master (Hono server, src/master.ts + src/server/api.ts)
├── Agent alpha  (workspace A)  ── JSONL event log
├── Agent beta   (workspace B)  ── JSONL event log
└── scheduler tick (15s) → cron tasks → prompts on forked branches
```

- **Agent** (`src/agent/agent.ts`): an async loop that alternates LLM turns and
  tool executions until the model stops calling tools, then auto-continues
  toward its goal. Stop/resume at any time via API/UI — stop aborts an
  in-flight LLM call immediately (AbortController). Runaway guards: turn cap
  per round, consecutive-tool-error cap, per-command timeouts.
- **Context compaction**: message history is token-estimated each turn; past a
  budget (`contextTokenBudget`, default ~96k) older turns are summarized by
  the LLM into dense continuation notes (fallback: safe truncation). Cut
  points never split a tool_call/tool_result pair.
- **Session persistence**: conversations are rebuilt from the JSONL log on
  restart (`restoreSession`), so agents resume mid-task across master
  restarts instead of starting blank.
- **LLM** (`src/agent/llm.ts`): official `openai` npm client against any
  OpenAI-compatible endpoint (OpenRouter, vLLM, Ollama...). Model is config,
  never hard-coded.
- **Tools** (`src/agent/tools.ts`): provider-agnostic JSON-schema function
  specs — `read_file`, `write_file`, `edit_file`, `list_dir`, `bash` (git goes
  through bash), plus meta tools `finish` / `report_progress`. Paths are
  confined to the workspace; bash runs detached in its own process group and
  the whole group is SIGKILLed on timeout.
- **Goal / knowledge**: `GOAL.md` (goal + status), `AGENTS.md` (project
  knowledge), `MEMORY.md` (agent notes) live in each workspace as normal git-
  editable Markdown. The goal file is the source of truth; the harness re-reads
  it on restart.

### Web UI

- **Sessions as channels** — chat feed with live-streamed LLM output (💭
  reasoning collapsible), tool calls/results as expandable embeds, progress
  reports and state changes as dividers
- **Deep links** — every session has a URL (`http://localhost:7788/session/<id>`);
  the last open session is remembered
- **Details panel** (`d`) — session info, model switcher (provider select +
  OpenAI-compatible `GET /models` autocomplete; applies to the running
  session from the next turn), controls, goal editor, progress, runtime stats
- **Terminal** (`t`) — interactive shell in the agent's workspace for humans,
  rendered with xterm.js over WebSocket
- **Keyboard** — `↑`/`↓` switch sessions · `/` focus composer · `t` terminal ·
  `d` panel · `esc` interrupt a running agent
- Realtime updates flow over WebSocket (`/api/ws`) with auto-reconnect

### Agent Skills

Skills are reusable playbooks the agent loads on demand — and writes itself,
so hard-won procedure knowledge survives sessions:

```
<workspace>/skills/<name>/SKILL.md      # project skills (git-friendly)
~/.config/teapot-coding-agent/skills/<name>/SKILL.md   # shared across agents
```

```markdown
---
name: release-checklist
description: Steps to cut a release safely
---

1. run pnpm test
2. bump version ...
```

- The system prompt lists every discovered skill (name + description);
  workspace skills override same-named global ones.
- The agent calls `load_skill(name)` when a task matches and follows it.
- The agent calls `save_skill(name, description, content)` to distill a
  reusable procedure it developed — available from the next turn, forever.

### Session log format (JSONL)

One file per agent (`dataDir/<agent>.jsonl`); every conversation *including
forks* lives in the same interleaved stream:

```json
{"v":1,"id":"e27","seq":27,"ts":"…","agent":"alpha","session":"sess-alpha-main",
 "branch":"br032sl","parent":"e26","type":"fork",
 "data":{"fromSession":"sess-alpha-main","fromBranch":"br0","fromEvent":"e26","newBranch":"br032sl"}}
```

- every event carries `session`, `branch`, `parent` (previous event on the same branch), monotonic `seq`
- a `fork` event records exactly where the new branch split off
- reconstruct any conversation: filter `branch === X` (or walk `parent` links
  backwards across the fork point)
- event types: `session_start, fork, prompt, system_note, message, tool_call,
  tool_result, state, progress, error, usage, goal`
- torn trailing lines are ignored on read → crash-safe append-only log

### Progress reports

Two complementary mechanisms:

1. the agent can call `report_progress` whenever it wants;
2. the harness injects a progress-report request at the next *turn boundary*
   after `progressIntervalMs` of activity — never mid-turn, so it never
   interrupts a tool call. Reports are first-class `progress` events.

### Scheduled tasks

Cron-style specs (`*/10 * * * *` or `every 10m`) checked by the single 15 s
master tick. Tasks run as prompts on **forked branches** by default so periodic
chatter never disturbs an agent's main line of work.

## HTTP API

```
GET  /api/agents                     list snapshots
GET  /api/agents/:id                 one snapshot
POST /api/agents/:id/prompt          {text, start?}
POST /api/agents/:id/start | /stop
POST /api/agents/:id/goal            {text} or {status}
POST /api/agents/:id/fork            {} → new branch, same session log
GET  /api/agents/:id/events?limit&branch&session
GET  /api/agents/:id/branches
GET  /api/metrics                    master rss/heap/load + per-agent stats
GET  /api/events                     SSE updates (push, no polling)
GET  /brew                           418 I'm a teapot (RFC 2324)
```

## Security / execution model

Designed for a dedicated agent Linux user; workspaces are path-confined,
subprocesses run in killable process groups with hard timeouts, and resource
limits (RLIMIT_* / cgroups) have a natural insertion point in
`src/agent/tools.ts:runShell`. The master survives agent crashes by
construction: agent errors never escape their own loop, and global handlers
keep the process alive.

## License

AGPL-3.0-or-later
