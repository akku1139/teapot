# teapot hooks — design notes (NOT implemented yet)

Research basis: comparison of Claude Code, Codex CLI, Gemini CLI hooks and
OpenCode / Pi plugin systems (2026-08-26). See the conversation for the full
survey; this file distills what would fit teapot.

## Why teapot is different

teapot is a RESIDENT SERVER hosting many agents. CLI harnesses run hooks in
the user's shell session; teapot runs them server-side, shared by all agents.
That changes the trust model fundamentally:

- a project-local hook config (`<workspace>/.teapot/hooks.json`) is written
  by whatever the AGENT writes into that workspace — auto-loading it is
  arbitrary code execution by the model. Codex's trust-review flow exists for
  exactly this; we must have an equivalent from day one.
- hooks fire per AGENT, so the event payload should carry `agentId`,
  `session`, `branch` — and the UI can show firing history inline (a unique
  strength no CLI has).

## Recommended shape

Config-driven (Claude Code / Codex style), NOT a JS plugin API: teapot's
config is already the single source of truth, agents are remote-operated, and
shell scripts are the lowest common denominator operators already know.

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",                 // exact | a|b list | regex
        "hooks": [
          { "type": "command",
            "command": "/opt/teapot/hooks/guard.sh",
            "timeout": 10,                  // seconds
            "async": false }                // true = fire-and-forget
        ]
      }
    ],
    "PostToolUse": [ { "matcher": ".*", "hooks": [ ... ] } ],
    "UserPromptSubmit": [ ... ],
    "Stop":          [ ... ],   // round end (idle / error / done)
    "PreCompact":    [ ... ],   // can inject context before summarization
    "PostCompact":   [ ... ],
    "SessionStart":  [ ... ],
    "SessionEnd":    [ ... ]
  }
}
```

Levels: global config → agent entry override → workspace `.teapot/hooks.json`
(trusted-only). Merge like Codex: layers add, not replace.

## Event contract (industry-standard three-part rhythm)

- stdin: JSON `{event, agentId, sessionId, branch, cwd, tool?, args?, result?, ts}`
- stdout: JSON decision (see below); plain text to stdout = warning only
- exit codes: `0` = parse stdout JSON · `2` = block (stderr is the reason) · other = warn & continue

Decision object (keep small at v1):

```jsonc
{ "decision": "allow" | "deny",
  "reason": "...",                     // required with deny — SHOWN TO THE MODEL
  "systemMessage": "...",              // operator-facing toast in the web UI
  "hookSpecificOutput": {              // phase 2:
    "additionalContext": "...",        // appended to the tool result
    "tool_input": { ... }              // rewrite arguments before execution
  } }
```

The key property every harness converges on: **a deny reason becomes the
model's tool error**, so the model can adapt instead of just failing.

## Events worth having at v1 (in order)

1. PreToolUse / PostToolUse — the workhorses (guardrails, audit, redaction)
2. UserPromptSubmit — prompt scanning, context injection
3. Stop — round-end notifications, summary extraction
4. PreCompact / PostCompact — teapot already visualizes compaction; letting
   operators inject durable context here composes with harvestLessons

Phase 2+: SubagentStart/Stop, GoalSet, ErrorRetry (we now have the events),
FileChanged (needs a watcher).

## Trust model (non-negotiable)

- global-config hooks: trusted implicitly (operator wrote them)
- workspace-level hooks: require explicit approval in the web UI, recorded as
  a content hash; changed files re-enter "pending review" and are SKIPPED
  until re-approved (Codex semantics)
- managed tier: none initially (no enterprise story), but keep the merge order
  so it can be added later
- `/hooks` equivalent: a right-panel section listing discovered hooks + their
  review state + last-fired history (from the JSONL log)

## What the web UI uniquely enables

- hook firings appear as timeline rows (reuse the system_note embed pattern)
- a hooks panel: config viewer + pending-trust approvals + per-hook stats
- deny reasons already flow into tool_result rows the operator reads anyway

## Explicitly deferred

- HTTP hooks, MCP-tool hooks, LLM-judge ("prompt") hooks, agent hooks — all
  Claude Code extras; useful later, none are load-bearing
- argument rewriting (Gemini `tool_input`) — powerful but risky; wait for demand
- parallel-vs-sequential hook groups — v1 runs matched hooks sequentially in
  declaration order (deterministic, easy to reason about)
