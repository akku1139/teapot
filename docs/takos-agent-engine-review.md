# takos-agent-engine — review (no implementation)

Read the repo: `README.md` (506 lines), `architecture.md`, `docs/agent-runtime.md`,
and `src/memory/**`, `src/engine/context_assembler.rs`. Nothing below is
implemented; this is an assessment.

## What it actually is

**Rust** library (MIT, 2 stars, last pushed 2026-09-30). "Rust library for
embedding LLM agents with shared conversation history and long-term memory."

That detail decides most of this issue: teapot is TypeScript, so "porting" means
either a rewrite of the ideas or a sidecar in a second language. Neither is free.

## The idea worth stealing

Two memory layers over one store:

- **`RawNode`** — the unfiltered record: 5 kinds (`UserUtterance`,
  `AssistantUtterance`, `ToolResult`, `Note`, `Event`), with `importance`,
  `was_pushed_out_of_session`, `operation_key`.
- **`AbstractNode`** — knowledge distilled from raw nodes: entity/relation
  graph fragments with **provenance** back to the raw nodes that produced them.

The part I find genuinely good is the framing of overflow. Normally a context
window overflow means data is dropped. Here, a raw node pushed out of the session
is treated as *unrefined* rather than *discarded* — it gets a relaxed
reactivation threshold (0.72 → 0.63) and is promoted to an `AbstractNode` by a
maintenance pass. Information changes shape instead of disappearing.

Provenance is the other part worth taking: an `AbstractNode` can name the raw
nodes it came from, so an agent can check its own memory's basis. teapot has no
equivalent.

## Your prefix-cache concern is correct, and sharper than it looks

From the README's execution graph:

```
run_model → execute_tools → build_followup_query
  → reactivate_memory → reassemble_context → run_model_after_tools
```

Memory is **re-selected and re-assembled on every tool round**, and the
activation query is built from the *current* message plus the *previous tool
result*. So the prompt prefix changes mid-turn, on every round.

Against teapot's actual design that is a direct conflict, not a friction:

- `buildMessages()` is `[system] + append-only history`, described in the source
  as *"deliberately static … keeps prefix caches hot"*.
- `systemPrompt()` captures AGENTS.md, the workspace listing and the skills
  catalogue **once** and freezes them, specifically so the prompt stays
  byte-identical.
- #64 landed yesterday made compaction the **one** sanctioned exception — and
  only because compaction already rewrites the history, so re-pricing the cache
  there is free.

Per-round memory re-injection is that exception applied every 150ms of tool
work. The economics depend on provider cache pricing, but the shape of the
trade is: you would be trading real per-token cost for memory recall on the
master agent, which is the single agent where you least want that.

## Overlap with what teapot already has

This is the part that argues for caution:

| takos | teapot |
|---|---|
| memory in the prompt | `memory.md`, but **pulled via `read_memory()`, not injected** |
| distillation raw → structured | `harvestLessons()` |
| activation / retrieval scoring | none (no retrieval at all today) |
| provenance on distilled knowledge | none |
| overflow marked, not dropped | `maybePrune()` clips; `recentReads` re-attaches after compaction |
| 14-node execution graph | the existing round loop |

teapot's distillation is honestly thin — `harvestLessons()` regexes
`## Durable lessons` out of the compaction summary and appends it to
`memory.md`. That is a fair thing to replace.

But note the direction of the gap: takos is **stronger on memory
representation and provenance**, and teapot is **much stronger on session
lifecycle, tools, budget, and process architecture**. Its 14-node graph is not
something teapot needs; its memory model is the only part that is actually
missing.

## Recommendation

**Do not port the engine. Extract three ideas, in this order:**

1. **Provenance** — have `memory.md` entries record which session/compaction
   produced them. This is cheap, orthogonal to prefix caching, and closes the
   real gap. teapot already stamps `<!-- lessons harvested from compaction ... -->`,
   so the hook exists; it is not read back.
2. **Overflow as "unrefined", not "discarded"** — adopt the reframe. It fits
   teapot's existing `maybePrune`/`recentReads` machinery and does not require
   re-activating memories into the prompt every round.
3. **Retrieval, eventually** — an explicit `search_memory` tool the model calls
   when it wants something, rather than memories injected unprompted. This gets
   most of the benefit with **zero** prefix-cache cost, because a tool result
   lands in the normal append-only tail.

Point 3 is the important one, and on closer reading **teapot already has the
right shape**: `read_memory()` is a tool the model calls when it wants its notes,
so nothing is injected and the prefix never moves. Takos injects because it has
no model in the loop to ask.

So the gap is smaller than it looks. What is missing is not the mechanism but the
*index* — `read_memory()` returns the whole file, with no scoring, no relevance
filter and no `importance`. That is a retrieval problem, not an architecture
change, and it can be solved behind the same tool signature.

## The master/sub-agent split in the issue

Your instinct here is the strongest part of the idea, and it is worth separating
from the rest. A memory system on the **master** that a cheap sub-agent is
instructed to consult is close to free:

- the sub-agent's prompt is short-lived and not re-priced, so nothing is lost;
- the master keeps its byte-identical system prompt and its cache;
- the retrieval happens in the sub-agent, whose whole job is the one lookup.

That is roughly "give the sub-agent a `search_memory` tool and teach it to use
it" — and since `read_memory()` already exists, it is closer to *scoping* that
tool per agent than to building anything. It does not require porting anything.

## If a port is ever wanted

- **Do not** reimplement in Rust — that is a second runtime, a second build, and
  a language boundary on the hot path.
- The Rust crate could be embedded as an HTTP/sidecar memory service (it already
  has `storage::traits` with swappable backends, so this is natural), keeping
  teapot in TypeScript.
- The pieces that would move first: `RawNode`/`AbstractNode` schema, the
  activation scoring, and the four typed memory tools. The 14-node graph would
  be dropped — teapot's loop is not the problem.

## Open questions

- Does activation scoring (cosine + importance + 0.015/day decay + overflow
  bonus) hold up without embeddings? teapot has no embedding call today, and
  adding one is a new provider dependency and a new cost.
- `ContextAssembler`'s own doc comment is candid that its token estimator is
  heuristic and never reconciled against provider `usage`. teapot's
  `maybeCompact()` already uses real `lastUsage.input`; that is stronger, and
  would be worth keeping.