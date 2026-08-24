# teapot 🫖

A lightweight harness for running many AI coding agents continuously — simpler
and lighter than existing harnesses. No TUI. One small web server, a browser
tab, and any number of long-running agents.

## Design principles

- **TypeScript + Node.js**, small dependency set (`hono`, `openai`,
  `@hono/node-server`, `ws`, `zod`, `@mozilla/readability` + `happy-dom` for
  `read_url`)
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
teapot
# open http://localhost:7788 — the first-run wizard walks you through
# provider → API key → model → first agent (writes config.json for you)
```

The global install puts a `teapot` binary on your PATH (it serves the compiled
server plus the pre-built web UI — no build step, no repo checkout needed).
Prefer hand-writing the config? Skip the wizard and drop an edited copy of
[`teapot.config.example.json`](teapot.config.example.json) at the path below.
Alternatives:

```sh
npx teapot-coding-agent                    # run without installing
teapot --port 8080                         # CLI flags: --port/-p, --config/-c
teapot ~/my-config.json                    # explicit config path
TEAPOT_PORT=8080 teapot                    # env overrides work as usual
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
    "orcarouter": { "baseUrl": "https://api.orcarouter.ai/v1", "apiKey": "sk-orca-...", "model": "orcarouter/auto" },
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

Per-agent inline `baseUrl`/`apiKey`/`model` override the provider entry. The
first-run wizard and the settings modal ship quick-add presets for OpenRouter,
OrcaRouter, OpenAI and Ollama.

**OpenRouter app attribution**: requests to `openrouter.ai` endpoints
automatically carry `HTTP-Referer` / `X-OpenRouter-Title` /
`X-OpenRouter-Categories: programming-app`, so teapot's usage shows up in
OpenRouter's public rankings & analytics — no config needed. Other providers
receive no extra headers.

## Architecture

```
master (Hono server, src/master.ts + src/server/api.ts)
├── Agent alpha  (workspace A)  ── JSONL event log
├── Agent beta   (workspace B)  ── JSONL event log
└── scheduler tick (15s) → cron tasks → prompts on forked branches
```

- **Agent** (`src/agent/agent.ts`): an async loop that alternates LLM turns and
  tool executions until the model stops calling tools, then auto-continues
  toward its goal. `ask_user` parks the loop in a `waiting` status until the
  operator replies. Stop/resume at any time via API/UI — stop aborts an
  in-flight LLM call immediately (AbortController). Runaway guards: turn cap
  per round, consecutive-tool-error cap, per-command timeouts.
- **Context management (staged)**: each turn prefers the provider's real
  `prompt_tokens`; past ~60% of budget, old oversized tool outputs are pruned
  (recent window protected); past the budget (`contextTokenBudget`, default
  ~96k — auto-derived at 75% when a model's `contextWindowTokens` is known)
  older turns are summarized into dense continuation notes plus a
  "## Durable lessons" section harvested into memory.md. Cut points never
  split a tool_call/tool_result pair.
- **Session persistence**: conversations are rebuilt from the JSONL log on
  first interaction (lazy — boot cost stays O(agents)), so agents resume
  mid-task across master restarts instead of starting blank. Restores replay
  byte-identical request payloads, keeping provider prefix caches warm.
- **LLM** (`src/agent/llm.ts`): official `openai` npm client against any
  OpenAI-compatible endpoint (OpenRouter, vLLM, Ollama...). Model is config,
  never hard-coded.
- **Tools** (`src/agent/tools.ts`): provider-agnostic JSON-schema function specs —
  file work via `read_file` (numbered lines, grep-style `pattern` mode, negative
  offsets), `write_file`, `edit_file` (unique replacement, `replace_all`,
  whitespace-tolerant fallbacks with recovery hints), `apply_patch`
  (Codex-style multi-file add/update/rename/delete patches, validated
  atomically before writing) and `list_dir`; `bash` for git/builds/tests and
  quick bulk transforms; `read_url` fetches a web page's readable content
  (Mozilla Readability + happy-dom); plus meta tools `finish` / `ask_user` /
  `report_progress` / `get_goal` / `set_goal` / `get_todo` / `set_todo` /
  `read_memory` / `set_memory` / `get_feedback` / `add_feedback` /
  `record_decision` / `get_decisions` / `list_skills`. Paths are confined to
  the workspace (symlink-aware); bash runs detached in its own process group
  and the whole group is SIGKILLed on timeout or shutdown.
- **Sub-agents** — an agent can `spawn_agent({task, context, persona?})` to
  delegate work: `context:"fork"` starts the child with a byte-exact copy of
  the parent's conversation prefix (provider prefix caches stay warm; stored
  as a reference header in the child's log — parent history is never copied),
  `"none"` starts fresh. Parents steer children via `message_agent`, check on
  them with `list_children`, and can bulk-stop them (`stop_children`,
  descendants included). Children mirror their activity into the parent's
  timeline tagged `@<id>`, and their finish/error reports are delivered back
  automatically. Nesting depth is capped by `maxSpawnDepth` (default 3).
  Default personas: reviewer/tester/researcher/implementer (+ read-only
  enforcement for researcher/reviewer), plus `@mention` spawning from the
  composer.
- **Cache-friendly prompt design** — the system prompt is byte-identical on
  every turn; session state (goal, memory, skills) is fetched via tools, never
  injected. Combined with the append-only message history this keeps provider
  prefix caches hot, so long sessions pay incremental input prices instead of
  re-sending full context every turn.
- **Session storage** — everything teapot manages lives under
  `<dataDir>/sessions/<sid>/` (`chat.jsonl`, `goal.md`, `todo.md`,
  `memory.md`, `feedback.md`, `decisions.md`), so agent workspaces stay
  clean. Each incarnation gets a fresh `<agentId>-<uuid>` directory (no
  history leaks across projects); restarts reuse the latest one. Legacy
  layouts are migrated automatically.
- **Goal / knowledge** — goal + memory are harness-managed and read/written
  through tools (`get_goal` / `set_goal` / `read_memory` / `set_memory`);
  `AGENTS.md` is optional project knowledge in the workspace root that agents
  are told to read at session start. Nothing is seeded into your project.
- **Decisions & feedback** — `record_decision(decision, rationale,
  alternatives?)` keeps the *why* behind choices in `decisions.md`
  (compaction forgets reasoning, this file doesn't); corrections become
  durable rules via `add_feedback(rule)` with repetition counts.
- **Task list** — `todo.md` in the session dir, editable by BOTH sides:
  humans write it from the web UI (✅ tasks panel) or
  `POST /api/agents/:id/todo {text, notify?}`, the agent reads and updates it
  via `get_todo` / `set_todo`. Saving with notify queues a harness prompt so
  the agent picks up changes at the next turn boundary.

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
- The agent calls `save_skill(name, description, content, files?)` to distill a
  reusable procedure — `files` bundles helper scripts next to `SKILL.md`
  (made executable automatically), and `load_skill` lists them as runnable
  workspace paths. Available from the next turn, forever.
- Bundled skill: [`skills/qa-adversarial`](skills/qa-adversarial/SKILL.md) —
  seven adversarial QA personas. Copy it into
  `~/.config/teapot-coding-agent/skills/` (global) or a workspace's
  `skills/` folder to enable it.

### Session log format (JSONL)

One file per session (`<dataDir>/sessions/<sid>/chat.jsonl`, sid =
`<agentId>-<uuid8>`); every conversation *including forks* lives in the same
interleaved stream:

```json
{"v":1,"id":"e27","seq":27,"ts":"…","agent":"alpha","session":"alpha-9f3c21ab",
 "branch":"br032sl","parent":"e26","type":"fork",
 "data":{"fromSession":"alpha-9f3c21ab","fromBranch":"br0","fromEvent":"e26","newBranch":"br032sl"}}
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
POST /api/agents/:id/load            lazy session restore (stopped → idle)
POST /api/agents/:id/goal            {text, notify?} or {status}
POST /api/agents/:id/fork            {} → new branch, same session log
POST /api/agents/:id/edit-prompt     {eventId, text, tail: "discard"|"summarize"} → fork & resend
GET  /api/agents/:id/events?limit&branch&session
GET  /api/agents/:id/branches
GET  /api/tasks                      scheduled tasks with computed next-fire times
GET  /api/metrics                    master rss/heap/load + per-agent stats
GET  /api/events                     SSE updates (push, no polling)
GET  /brew                           418 I'm a teapot (RFC 2324)
```

## Security / execution model

Designed for a dedicated agent Linux user; workspaces are path-confined,
subprocesses run in killable process groups with hard timeouts, and resource
limits (RLIMIT_* / cgroups) have a natural insertion point in
`src/agent/tools.ts:runShell`.

**LAN exposure**: the API has no auth by default (localhost-first tool). To
expose it beyond localhost, set `TEAPOT_API_TOKEN=<secret>` (env wins) or a
`password` field in the config — every `/api/*`
route then requires `Authorization: Bearer <secret>` (WebSocket handshakes
accept `?token=<secret>`). In the web UI, open
`http://host:7788/#token=<secret>` once; the token is stored locally and
attached automatically. The master survives agent crashes by
construction: agent errors never escape their own loop, and global handlers
keep the process alive.

## License

AGPL-3.0-or-later
