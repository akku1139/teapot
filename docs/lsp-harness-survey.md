# LSP integration in agent harnesses — survey

Surveyed 14 harnesses against primary sources (official docs, source, changelogs)
on 2026-10-02. Nothing implemented; this is the landscape and a recommendation.

## Short answer

Only **3 of 14** harnesses give the model real LSP access, and they all paid
for it in latency. For teapot specifically, the survey says the *cheapest useful
thing* is diagnostics — not a language-server client.

## Who actually does it

| Harness | Model-facing LSP? | Mechanism | Diagnostics |
|---|---|---|---|
| **Claude Code** (GA, v2.0.74) | **YES** — read-only `LSP` tool | spawns stdio subprocess | **pushed** into context after every edit |
| **Kiro / AWS** (GA) | **YES** — one `code` tool | spawns stdio subprocess | **pulled** per request |
| **OpenCode** | yes — **experimental, off by default** | spawns stdio subprocess | both push + pull, merged |
| **Zed** | yes — **feature-flagged off** | spawns subprocess | both, with a staleness warning |
| Cursor, Windsurf/Devin, Cline, Continue, Roo | **NO** | — | inherit the IDE's Problems panel only |
| Aider, Codex CLI, Gemini CLI, OpenHands, Amazon Q | **NO** | — | — |

Verified independently: Claude Code's CHANGELOG documents the LSP tool and ~10
subsequent LSP fixes; `grep -i "lsp|language server"` over Cursor's `docs.md`
and `llms.txt` returns **zero** hits.

### Three tiers, and the tier is the real design decision

1. **Owns the language server** — Claude Code, Kiro, OpenCode, Zed. True
   semantic intelligence; you own the subprocess lifecycle.
2. **Inherits the host editor's** — Windsurf, Continue, Roo, Cline. Free
   language servers, but the integration budget goes to the Problems panel.
   **None expose definition/references to the model.**
3. **None** — Aider's author declined explicitly ("cumbersome for users to
   find, install, run an LSP server for every language", #527); Codex CLI's
   request has 606 reactions and is still open; Gemini CLI closed seven LSP PRs
   unmerged.

## What the evidence says to copy — and to avoid

**Copy: the read-only subset.** Claude Code exposes definition, references,
hover, document/workspace symbols, implementations and call hierarchies — and
**no rename, no codeAction**. Almost nobody ships rename to a model; Kiro is the
exception and gates it behind a per-file prompt with a dry-run
("Would rename 12 occurrences in 5 files"). That restraint looks deliberate.

**Copy: Zed's staleness honesty.** Zed is the only harness that tells the model
its diagnostics may be stale. Given #7 (the read-file gutter) and #38 (a filter
that looked like data loss), teapot has already been bitten twice by UI that
implies more certainty than it has.

**Avoid: the costs Claude Code's changelog paid for.** These are the real
lessons, all visible in shipped fixes:

- *"Fixed a per-turn slowdown when a language server publishes project-wide
  diagnostics for thousands of files"* — a `tsserver`/`rust-analyzer` emitting
  whole-project diagnostics is a **per-turn** cost, not a one-off.
- *"LSP documents staying open indefinitely"* → LRU with a 50-doc cap.
- Servers that reject `shutdown` params (rust-analyzer) being left running.
- A command-injection fix in **binary detection**.
- One server failing to initialize blocking a valid server for the same
  extension.

**OpenCode's own docs recommend against its feature**: *"in many projects it is
better to have the agent run lint, typecheck, or other diagnostic CLI tools
directly"*, and its write path can block **5–10s per file**.

## The friction nobody has solved: getting the server

Three approaches, each with a real downside:

- **user installs it** (Claude Code, Kiro) — most honest, most work for the user
- **auto-download** (OpenCode ~35 servers, Zed) — supply chain, version drift
- **inherit the editor** (Windsurf/Continue/Roo) — not available to a CLI

MCP is the universal escape hatch. Bridges exist
([isaacphi/mcp-language-server](https://github.com/isaacphi/mcp-language-server),
[bug-ops/mcpls](https://github.com/bug-ops/mcpls)), which is how Cursor — the
most-used harness — has any LSP story at all.

**teapot has no MCP support today** (the only `mcp` references in `src/` are
`mcpServers` params in the ACP adapter). So "use an MCP bridge" is not free here;
it means building MCP support first.

## Recommendation, in order

### 1. Diagnostics via existing tools — do this first

teapot already has everything this needs: `bash` can run `tsc --noEmit`,
`ruff`, `go vet`, `cargo check`, and the result comes back through the normal
tool result. No new subsystem, no subprocess to supervise, no latency budget,
no server distribution problem.

The gap is that teapot has **no dedicated diagnostic tool**, so the model has to
know to run the right command. A thin `diagnostics(lang?)` tool that runs the
project's own configured checker and returns **structured** output (file, line,
severity, message) is a genuine improvement over "bash something clever" —
and it is hours, not weeks.

This is exactly what OpenCode's docs recommend over its own LSP.

### 2. A language-server client — only if 1 shows a real gap

If diagnostics prove insufficient and the pain is *semantic* (find the
implementation, not grep), then a client is justified, and the shape is settled by
the evidence:

- **stdio subprocess per (workspace, language)**, supervised by the existing
  `bgShellsByWs`-style lifecycle, killed on `ctx.signal`;
- **opened documents LRU-capped** (Claude Code landed on 50) — this is not
  optional;
- **per-file notification budget**, so a server that publishes project-wide
  diagnostics cannot tax every turn;
- **read-only tool surface** — definition, references, hover, symbols. No
  rename, no codeAction;
- **surface staleness** to the model, the way Zed does;
- **server acquisition is the hard part** and should be explicit config
  (`.lsp.json`) rather than magic. Auto-download means shipping binaries.

On cost: teapot's whole compaction design is built around a **byte-identical
prefix**. LSP documents are opened *and mutated* by the server, and Claude
Code's changelog is a catalogue of what that costs. Since diagnostics do not
require keeping documents open, they are the subset that fits teapot's existing
model; a full LSP client would be the first feature that fights `buildMessages()`.

### 3. The master/sub-agent split — free, and available now

Same reasoning as #48: put the expensive lookup in a **sub-agent**, whose prompt
is short-lived and never re-priced. The master's byte-identical system prompt and
its prefix cache are untouched. `spawn_agent` + `wait_children` already exist.

So: "have a cheap sub-agent run the typecheck/diagnostic sweep and report" is
achievable today with no new code, and is probably where the value is.

## What I did not verify

- Whether Zed's `lsp-tool` flag has flipped on for stable builds since
  2026-06-17.
- Whether Roo's MCP marketplace lists LSP servers (remotely fetched, not in-repo).
- A historical OpenHands `openhands/lsp/` package — no primary source on any tag.

## Corrections to premises in the original request

- `sst/opencode` → **`anomalyco/opencode`**; `All-Hands-AI/OpenHands` →
  `OpenHands/OpenHands` (agent moved to `OpenHands/software-agent-sdk`).
- **Windsurf is now "Devin Desktop"** (`docs.windsurf.com` → `docs.devin.ai`).
- `aider.chat/docs/mcp.html` is **404** — Aider has no MCP at all.
- Cline's MCP tool naming is `<server>__<tool>`, Gemini CLI's is
  `mcp_{server}_{tool}`.
- Amazon Q IDE plugins reach **end of support 2027-04-30**; AWS steers to Kiro.