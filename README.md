# teapot 🫖

**A lightweight harness for running multiple autonomous AI coding agents in parallel, from your browser.**

> Try it in 5 minutes → [Quick start](#-quick-start) · Details live in the [Reference](#-reference) section

[日本語版はこちら](README.ja.md)

---

## 🚀 Quick start

### 1. Install

Requires Node.js **24+**.

```sh
npm install -g teapot-coding-agent
```

### 2. Write a config file

```sh
mkdir -p ~/.config/teapot-coding-agent
nano ~/.config/teapot-coding-agent/config.json
```

**Minimal setup** (OpenRouter — other providers below):

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "sk-or-your-key",
      "model": "anthropic/claude-sonnet-4"
    }
  },
  "defaultProvider": "openrouter",
  "agents": [
    { "id": "main", "workspace": "/home/you/my-project" }
  ]
}
```

Prefer copying a template? Grab [`teapot.config.example.json`](teapot.config.example.json).

### 3. Run

```sh
teapot
```

→ Open **http://localhost:7788**. That's it.

### 4. Use it

- Click `#main` in the left panel
- Type an instruction in the composer (e.g. "Fix this bug and make the tests pass")
- The agent reads/writes files, runs bash, and works on its own

| Action | How |
|---|---|
| Terminal | `t` |
| Right panel (goal/progress/runtime) | `d` |
| Command list | type `/` in the composer |
| Interrupt the agent | `Esc` |

---

## 🤔 What is this?

One line: **a server that hosts several autonomous coding agents over any OpenAI-compatible API, operated from a browser.**

```text
├─ agent: android  ── ~/projects/android-app
├─ agent: kernel   ── ~/projects/kernel
└─ agent: web      ── ~/projects/film-sims-web
```

Each agent owns its own workspace and runs in parallel as a channel in a Discord-style UI. teapot is **not** a wrapper around Claude Code or Codex CLI — it implements its own agent loop (read_file / edit_file / apply_patch / bash / read_url / memory / skills).

### When would I use it?

- Long-running self-directed tasks like *"triage every bug in this repo and fix them until tests pass"*
- **Different models per project** — heavy work on Sonnet, code review on a local Qwen
- Watch progress, goals and task lists in the browser while you do something else

### How does it compare to CLI tools?

| | teapot | Claude Code & similar CLIs |
|---|---|---|
| Form | resident server + web UI | interactive terminal |
| Multiple agents | ✅ parallel | usually one session |
| Mixed models | ✅ per agent | fixed |
| Long-running work | ✅ auto-restores from JSONL logs | manual session juggling |
| Scheduled tasks (cron) | ✅ 15-second tick | ❌ |

---

## 🔧 Features

<details>
<summary><b>Goals &amp; autonomous loop</b></summary>

Set a goal and auto-continue keeps deciding whether to keep working after each round. Optionally attach a **verification contract** — when the agent calls `finish`, an independent auditor LLM checks the contract before "done" counts:

```text
goal:    "Add account deletion to the auth module"
verify:  "npm test passes with zero failures / README documents the endpoint"
              ↓ on finish
independent audit → approved ⇒ done · changes-required ⇒ gaps queued back to the worker
```

</details>

<details>
<summary><b>Sub-agents</b></summary>

Spawn sub-agents with `@persona <task>` mentions. Children can fork the parent conversation by reference, so provider prefix caches stay warm. `wait_children` parks the parent until a child settles; its report lands in the parent's timeline. Nesting cap via `maxSpawnDepth` (default 3).

</details>

<details>
<summary><b>Memory / task list / skills</b></summary>

- **memory.md** — durable notes per session (set_memory / get_memory)
- **todo.md** — checklist shared with the operator; supports surgical per-item updates
- **skills** — reusable playbooks stored globally (`~/.config/teapot-coding-agent/skills/`) or per workspace; workspace versions shadow global ones

</details>

<details>
<summary><b>Scheduled tasks (cron)</b></summary>

```json
{ "tasks": [{ "id": "nightly", "agent": "main",
              "schedule": "0 3 * * *", "prompt": "Check git status and test results, report anything broken" }] }
```

</details>

<details>
<summary><b>Integrated terminal</b></summary>

Press `t` for an interactive shell inside the selected agent's workspace (xterm.js over WebSocket). The PTY comes from util-linux `script` when available, with a plain-pipe fallback — zero native dependencies.

</details>

<details>
<summary><b>File tree with previews &amp; editing</b></summary>

Browse the workspace from 🗂 files in the right panel: shiki syntax highlighting for code, rendered preview for Markdown, inline playback for images/video/audio, and in-place text editing that saves back to disk (409 on write conflicts).

</details>

<details>
<summary><b>Context management</b></summary>

Past a token budget (default: 75% of the model's window, or 96k if unknown), older turns are summarized by the LLM so work continues. Goals, memory and skills live in separate files, so context survives restarts and next-day resumes.

</details>

---

## ⚠️ Security (please read)

Agents can run `bash` and rewrite files — including `rm` and `npm install`.

- Designed to run under a **dedicated Linux user**
- `git commit` before handing over a repo you care about
- File operations outside the workspace are rejected (`safeJoin`)
- teapot listens on localhost only by default. If you expose it, set **both** `--host 0.0.0.0` and an API token (`TEAPOT_API_TOKEN` env or config `password`):

```sh
TEAPOT_API_TOKEN=mysecret teapot --host 0.0.0.0 --port 7788
```

---

<a id="-reference"></a>
## 📖 Reference

<details>
<summary><b>Config reference</b></summary>

| Key | Default | Meaning |
|---|---|---|
| `port` | 7788 | listen port (env `TEAPOT_PORT`, CLI `--port/-p`) |
| `host` | 127.0.0.1 | bind address (env `TEAPOT_HOST`, CLI `--host`; `0.0.0.0` exposes to LAN) |
| `dataDir` | `~/.local/share/teapot-coding-agent` | session logs etc. (env `TEAPOT_DATA_DIR`) |
| `providers.<name>` | — | `{ baseUrl, apiKey, model? }` OpenAI-compatible endpoint |
| `defaultProvider` | — | used when an agent doesn't specify one |
| `agents[].id` | required | URL key / display name |
| `agents[].workspace` | required | working directory |
| `agents[].provider` / `model` | inherited | per-agent overrides |
| `agents[].contextWindowTokens` | auto-inferred | model's real window (drives gauge + compaction) |
| `agents[].readOnly` | false | true blocks mutating tools |
| `agents[].autoContinue` | true | keep looping toward an active goal |
| `contextTokenBudget` | derived | compaction threshold in raw tokens; null/unset = 75% derivation (recommended) |
| `maxSpawnDepth` | 3 | sub-agent nesting limit |
| `password` | — | API auth (env `TEAPOT_API_TOKEN` wins) |
| `tasks[]` | — | cron tasks `{ id, agent, schedule, prompt }` |

Lookup order: CLI arg → `$TEAPOT_CONFIG` → `~/.config/teapot-coding-agent/config.json` → `./teapot.config.json`

</details>

<details>
<summary><b>Mixing providers</b></summary>

```jsonc
{
  "providers": {
    "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "sk-or-..." },
    "local":      { "baseUrl": "http://localhost:8080/v1", "apiKey": "llama.cpp" }
  },
  "defaultProvider": "openrouter",
  "agents": [
    { "id": "coder",    "workspace": "~/proj", "model": "anthropic/claude-sonnet-4" },
    { "id": "reviewer", "workspace": "~/proj", "provider": "local" }
  ]
}
```

Anything OpenAI-compatible works: OpenRouter / OpenAI / Ollama / vLLM / llama.cpp.
Requests to openrouter.ai automatically carry app-attribution headers.

Model context windows are inferred from `/v1/models` at startup and drive the runtime gauge plus the derived compaction budget (manual override supported).

</details>

<details>
<summary><b>HTTP API</b></summary>

```
GET  /api/agents                        list
POST /api/agents                        create { workspace, id?, provider?, model?, start? }
GET  /api/agents/:id/events?limit=300   events ( ?before=<id> pages upward )
GET  /api/agents/:id/branches           branch list
GET  /api/agents/:id/file?path=         fetch text file
PUT  /api/agents/:id/file?path=         save { content, baseContent? } (409 on conflict)
GET  /api/agents/:id/raw?path=          raw media bytes
GET  /api/agents/:id/tree               file tree
POST /api/agents/:id/prompt             send { text, start? } → { promptId }
POST /api/agents/:id/prompt/cancel      withdraw { promptId } (409 once delivered)
POST /api/agents/:id/goal               { text?, status?, verify? }
POST /api/agents/:id/start|stop|fork|load
DELETE /api/agents/:id                  remove (logs kept)
GET  /api/metrics                       RSS / heap / loadavg
WS   /api/ws                            live event stream
```

All API routes honor optional bearer auth.

</details>

<details>
<summary><b>Session log (JSONL) format</b></summary>

Append-only JSONL you can read with `cat`/`jq`:

```jsonl
{"v":1,"id":"e1","type":"prompt","data":{"source":"user","text":"..."}}
{"v":1,"id":"e2","type":"tool_call","data":{"callId":"…","name":"bash","argsRaw":"…"}}
{"v":1,"id":"e3","type":"tool_result","data":{"callId":"…","ok":true,"durationMs":117}}
{"v":1,"id":"e4","type":"message","data":{"role":"assistant","content":"…"}}
```

Each event links to its parent, forks share the branch point, and `goal.md` / `memory.md` / `todo.md` live beside `chat.jsonl` under `sessions/<agent>-<uuid>/`.

</details>

<details>
<summary><b>Development (from a checkout)</b></summary>

```sh
pnpm install
pnpm dev            # run TypeScript natively
pnpm dev-web        # Vite HMR (separate terminal)
pnpm test           # node --test
pnpm build          # tsc + vite build → dist/ + public/
```

Layout: `src/master.ts` (boot/cron/config) · `src/agent/` (loop/tools) ·
`src/server/api.ts` (Hono REST+WS) · `frontend/` (SolidJS) · `test/` (node:test)

</details>

---

## License

AGPL-3.0-or-later — [LICENSE](LICENSE)
