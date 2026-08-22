# teapot 🫖

A lightweight harness for running many AI coding agents continuously — simpler
and lighter than existing harnesses. No TUI. One small web server, a browser
tab, and any number of long-running agents.

## Design principles

- **TypeScript + Node.js**, minimal dependencies (`hono`, `openai`, `@hono/node-server`)
- **Idle cost ≈ 0**: no polling loops; everything is event-driven or driven by
  one 15-second scheduler tick. Verified: master sits at ~0% CPU when idle.
- **No TUI** — information-dense vanilla-JS web UI (no framework, no bundler)
  with a hand-written, XSS-safe Markdown renderer (`src/web/md.js`)
- **Human-readable persistence** — append-only JSONL event logs you can read
  with `cat` / `jq`; goal & memory as plain Markdown files in git

## Quick start

```sh
pnpm install
cp teapot.config.example.json teapot.config.json   # edit: apiKey, model
pnpm dev            # or: pnpm build && pnpm start
# open http://localhost:7788
```

Config keys can also come from `TEAPOT_PORT`, `TEAPOT_API_KEY`,
`TEAPOT_BASE_URL`, `TEAPOT_MODEL`, `TEAPOT_DATA_DIR`.

## Architecture

```
master (Hono server, src/master.ts + src/server/api.ts)
├── Agent alpha  (workspace A)  ── JSONL event log
├── Agent beta   (workspace B)  ── JSONL event log
└── scheduler tick (15s) → cron tasks → prompts on forked branches
```

- **Agent** (`src/agent/agent.ts`): an async loop that alternates LLM turns and
  tool executions until the model stops calling tools, then auto-continues
  toward its goal. Stop/resume at any time via API/UI. Runaway guards: turn cap
  per round, consecutive-tool-error cap, per-command timeouts.
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
