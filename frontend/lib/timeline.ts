/**
 * The timeline pipeline, extracted from `App.tsx`.
 *
 * ## Why this is a module (#timeline-refactor)
 *
 * The feed used to be one ~240-line `createMemo` in the component, doing seven
 * sequential transformations with closures over eleven component signals. It was
 * fragile for reasons that are structural rather than accidental:
 *
 *  1. **It wrote to its own inputs.** Rows were re-sequenced by assigning into the
 *     array (`visible[i] = resequenceToDelivery(e, …)`) and a cancelled marker was set
 *     on the event's `data` object (`e.data.cancelled = true`). Those objects come from
 *     the events store, so a re-run saw the PREVIOUS run's writes. Two runs with the
 *     same input could then produce different output, which is the definition of a bug
 *     that "sometimes" happens.
 *  2. **Order was load-bearing and unstated.** The invisible-row filter had to run AFTER
 *     the pending-echo bookkeeping but BEFORE `prev` was read positionally — a
 *     constraint recorded only in a comment. Moving a stage broke grouping in ways the
 *     type system could not see (#75, and the "sometimes groups, sometimes not"
 *     report).
 *  3. **Nothing could be tested in isolation.** Every assertion needed the whole
 *     component, so failures named the wrong feature.
 *
 * The stages below are numbered in the order they MUST run, each is a pure function of
 * its arguments, and none mutates an event.
 */

import { pendingFloor, placeEchoesBelow, resequenceToDelivery } from "./timeline-order.ts";

/** the minimum an event must look like — deliberately structural, not nominal */
export interface TimelineEvent {
  id: string;
  seq: number;
  ts?: string;
  type: string;
  data?: any;
  session?: string;
  branch?: string;
}

/** one pending (not yet delivered) message, as the composer shows it */
export interface PendingEchoLike {
  id: string;
  promptId?: string;
  at: number;
  text: string;
  sent: boolean;
}

/** what the pipeline needs from the component, passed explicitly */
export interface TimelineInput {
  events: readonly TimelineEvent[];
  /** tool_call ids whose result is merged into their call row */
  consumed: ReadonlySet<string>;
  pending: readonly PendingEchoLike[];
  /** builds an echo row; supplied by the caller because it needs session/branch */
  echo: (p: PendingEchoLike) => TimelineEvent;
  /** types that can draw a row at all */
  feedTypes: ReadonlySet<string>;
  /** types that DO draw a row (a subset of feedTypes) */
  renderedTypes: ReadonlySet<string>;
  /** system_note `event` names that draw a row */
  renderedNoteEvents: ReadonlySet<string>;
}

const META_TOOLS_HIDDEN = new Set(["report_progress", "ask_user", "record_decision"]);

/**
 * Stage 1 — drop what must never reach the feed.
 *
 * Sub-events pass through (they are expanded in stage 2). Tool results whose call row
 * will show them are dropped here rather than in the renderer, so grouping sees the
 * real sequence.
 */
export function feedCandidates(input: TimelineInput): TimelineEvent[] {
  const { events, consumed, feedTypes } = input;
  return events.filter((e) => {
    if (e.type === "sub") return true;
    if (!feedTypes.has(e.type)) return false;
    // a meta tool's own row is redundant with the card it produced (#107)
    const metaToolName =
      e.type === "tool_call" || e.type === "tool_result" ? String(e.data?.name ?? "") : "";
    if (META_TOOLS_HIDDEN.has(metaToolName)) return false;
    // paired tool results live inside their call's merged row
    if (e.type === "tool_result") return !consumed.has(e.id);
    if (e.type === "message") {
      const content = String(e.data?.content ?? "");
      const reasoning = String(e.data?.reasoning ?? "");
      // a reasoning-only turn right after a tool belongs to that action's row
      if (content.trim() === "" && reasoning.trim() !== "" && e.data?._prevKind === "tool")
        return false;
      // a requested progress report is already shown by its embed
      if (e.data?.progressEcho) return false;
      // sanitize()'s request-only placeholder from old logs
      if (!e.data?.final && content.trim() === "(tool call)") return false;
      return content.trim() !== "" || reasoning.trim() !== "" || !!e.data?.final;
    }
    return true;
  });
}

/**
 * Stage 2 — expand mirrored CHILD activity into normal rows tagged with the actor.
 *
 * `sub` events are no longer written (#63), but logs that predate that still contain
 * them, and silently hiding rows an operator can see on disk makes the log untrustworthy.
 */
export function expandSubRows(events: readonly TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const e of events) {
    if (e.type !== "sub") {
      out.push(e);
      continue;
    }
    const d = e.data as { sub?: string; type?: string; data?: any };
    const kind = String(d?.type ?? "message");
    if (kind === "state") continue; // child state churn is noise at the parent level
    // a NEW object, so nothing downstream can write into the stored event
    out.push({ ...e, type: kind, data: { ...(d?.data ?? {}), actor: d?.sub } });
  }
  return out;
}

const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Stage 3 — drop an assistant message that repeats the embed before it verbatim.
 *
 * Models often end a `report_progress` / `record_decision` turn by repeating the same
 * content as an ordinary message; the embed already shows it.
 */
export function dedupeAgainstEmbeds(events: readonly TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === "message" && e.data?.role === "assistant") {
      const prev = out[out.length - 1];
      const embedType = prev?.type;
      const isEmbed =
        embedType === "progress" || embedType === "decision" || prev?.data?.progressEcho;
      if (isEmbed) {
        const a = norm(e.data?.content);
        const b = norm(prev?.data?.content);
        if (a && a === b) continue;
      }
    }
    out.push(e);
  }
  return out;
}

/**
 * Stage 4 — read the prompt lifecycle notes.
 *
 * MUST run before stage 5: both filters below consult this bookkeeping, and the
 * invisible-row filter must not remove the notes it reads.
 */
export function promptLifecycle(events: readonly TimelineEvent[]): {
  deliveredIds: Set<string>;
  loggedUserPrompts: Set<string>;
  deliveredNotes: Map<string, number>;
  cancelledNotes: Map<string, number>;
} {
  const deliveredIds = new Set<string>();
  const loggedUserPrompts = new Set<string>();
  const deliveredNotes = new Map<string, number>();
  const cancelledNotes = new Map<string, number>();
  for (const e of events) {
    const pid = e.data?.promptId;
    if (!pid) continue;
    if (e.type === "prompt" && e.data?.source === "user") loggedUserPrompts.add(String(pid));
    if (e.type === "system_note" && e.data?.event === "prompt-delivered") {
      deliveredIds.add(String(pid));
      deliveredNotes.set(String(pid), e.seq);
    }
    if (e.type === "system_note" && e.data?.event === "prompt-cancelled")
      cancelledNotes.set(String(pid), e.seq);
  }
  return { deliveredIds, loggedUserPrompts, deliveredNotes, cancelledNotes };
}

/**
 * Stage 5 — drop rows that DRAW NOTHING.
 *
 * This must run after stage 4 (which reads notes out of the same array) and before
 * `prev` is taken positionally: an invisible row CUTS a run of tool calls in half,
 * because grouping keys on the row type. MEASURED: 304 of 1500 events were `state`,
 * and replaying the real log reproduced "two adjacent bash rows that would not group".
 *
 * The rule is "does this type draw anything", not a list of known-invisible types, so a
 * future type that draws nothing is handled automatically.
 */
export function dropInvisibleRows(
  events: readonly TimelineEvent[],
  input: Pick<TimelineInput, "renderedTypes" | "renderedNoteEvents">,
  stillPendingIds: ReadonlySet<string>,
): TimelineEvent[] {
  return events.filter((e) => {
    if (!input.renderedTypes.has(e.type))
      return e.type === "system_note" && input.renderedNoteEvents.has(String(e.data?.event ?? ""));
    if (e.type !== "prompt" || e.data?.source !== "user") return true;
    const pid = String(e.data?.promptId ?? "");
    // an undelivered prompt's LOG row must not render as settled: the echo represents
    // it, and showing both says the model already saw it
    return pid === "" || !stillPendingIds.has(pid);
  });
}

/**
 * Stage 6 — put a delivered prompt at the seq where the model CONSUMED it.
 *
 * A prompt row is logged at enqueue time, so its seq is where the operator typed it,
 * not where it entered the conversation. An UNDELIVERED one goes to the bottom (where
 * it will be consumed), because its later-seq agent output is rendered above it
 * otherwise — the timeline saying the opposite of what happened.
 *
 * Returns NEW rows; the input is never mutated (#timeline-refactor, reason 1).
 */
/**
 * Cache for rows that this pipeline DERIVES (rather than returns unchanged).
 *
 * ## The rule this enforces
 *
 * `buildTimeline()` runs on every event burst. `<For>` keys on item IDENTITY, so a row that
 * comes back as a new object is disposed and re-created — its DOM state (an open
 * `<details>`, text selection, scroll position inside it) is thrown away with the node.
 *
 * Any stage that has to build a new row for the same input must therefore return the SAME
 * object next time. Keying a WeakMap by the input row does that: the input row is stable
 * (it comes from `stabilize()` in the events store), so the derived object is too.
 *
 * This is NOT a workaround for the ordering bug that came before it — that was a genuine
 * `seq` that moved on every rebuild, and it is fixed at its source (`pendingFloor` anchors
 * to the row). This cache exists for derivations that are legitimately one-time work.
 */
const cancelledCache = new WeakMap<TimelineEvent, Map<number, TimelineEvent>>();

/** the same input row + the same cancellation note must yield the same OUTPUT object */
function withCancelled(e: TimelineEvent, noteSeq: number): TimelineEvent {
  let byNote = cancelledCache.get(e);
  if (!byNote) {
    byNote = new Map();
    cancelledCache.set(e, byNote);
  }
  const hit = byNote.get(noteSeq);
  if (hit) return hit;
  const marked = { ...e, data: { ...(e.data ?? {}), cancelled: true } };
  byNote.set(noteSeq, marked);
  return marked;
}

export function resequencePrompts(
  events: readonly TimelineEvent[],
  lifecycle: ReturnType<typeof promptLifecycle>,
): TimelineEvent[] {
  // An undelivered prompt must land below ALL settled rows, so the floor is computed from
  // the whole input rather than the partially built output.
  //
  // It must also be STABLE for a given row: `pendingFloor()` used to return `max(seq) + 1`,
  // which moves whenever anything new is logged, so a queued prompt got a new `seq` (and
  // therefore a new OBJECT) on every rebuild — and `<For>` remounts on identity, so that
  // row was re-created per incoming event. A prompt's own `seq` is below everything logged
  // after it, so anchoring there keeps the value fixed for as long as the row is unchanged.
  const floorOf = (own: number) => pendingFloor(events as TimelineEvent[], own);
  const out: TimelineEvent[] = [];
  for (const e of events) {
    if (e.type !== "prompt" || e.data?.source !== "user") {
      out.push(e);
      continue;
    }
    const pid = String(e.data?.promptId ?? "");
    const cancelSeq = lifecycle.cancelledNotes.get(pid);
    const delivered = lifecycle.deliveredNotes.get(pid) ?? 0;
    const settled = Math.max(delivered, cancelSeq ?? 0) || undefined;
    // The withdrawn marker is applied BEFORE the branch below: a cancelled prompt HAS
    // a `settled` seq (its cancellation), so it took the resequence branch and lost the
    // marker entirely — the row then rendered as an ordinary sent message, which is
    // exactly the #19 symptom the marker exists to prevent.
    // ── IDENTITY, not just correctness ────────────────────────────────────────────
    //
    // These rewrites used object spreads unconditionally, so every prompt row came back as
    // a BRAND NEW object on every rebuild — even when nothing about it had changed. That is
    // invisible to a value-equality assertion and fatal to `<For>`, which keys on IDENTITY:
    // the row was disposed and re-created on every incoming event, so an expanded
    // `<details>` inside it slammed shut and the timeline flickered on each message.
    //
    // MEASURED before this change: appending one event replaced 4 of 18 rows in the real
    // bundle, and `e1` (a plain user prompt) here. The rule is now: allocate only when a
    // value actually changes, otherwise return the SAME object. Anything else in this file
    // that derives a row must follow it (see `expandSubRows`).
    // The marker is DERIVED from a note, so it must be cached against the input row: the
    // source event never carries `cancelled`, so "does it already have the flag?" is always
    // false and a fresh object was allocated on every rebuild.
    const marked =
      cancelSeq !== undefined ? withCancelled(e, cancelSeq) : e;
    if (settled !== undefined) {
      out.push(resequenceToDelivery(marked, settled));
      continue;
    }
    // only move the row when the position actually differs
    const floor = floorOf(marked.seq);
    out.push(marked.seq === floor ? marked : { ...marked, seq: floor });
  }
  return out;
}

/**
 * Stage 7 — decide which pending messages still need an echo.
 *
 * A message needs one until it is DELIVERED and its log row exists; dropping it on the
 * log row alone made the indicator flash and vanish while the message was still queued.
 */
export function remainingEchoes(
  pending: readonly PendingEchoLike[],
  lifecycle: ReturnType<typeof promptLifecycle>,
): PendingEchoLike[] {
  return pending.filter((p) => {
    if (!p.promptId) return true;
    if (lifecycle.deliveredIds.has(p.promptId) && lifecycle.loggedUserPrompts.has(p.promptId))
      return false;
    return true;
  });
}

/**
 * The whole pipeline, in the order the stages MUST run.
 *
 * Exported as one function so the component cannot reorder the stages by accident, and
 * so a test can drive the real sequence with a plain array.
 */
export function buildTimeline(input: TimelineInput): TimelineEvent[] {
  // 1
  const candidates = feedCandidates(input);
  // 2
  const expanded = expandSubRows(candidates);
  // 3
  const deduped = dedupeAgainstEmbeds(expanded);
  // 4 BEFORE 5, because 5 reads this and must not remove the notes it reads
  const lifecycle = promptLifecycle(deduped);
  const stillPendingIds = new Set<string>();
  for (const p of input.pending) {
    if (p.promptId && !lifecycle.deliveredIds.has(p.promptId)) stillPendingIds.add(p.promptId);
  }
  // 5
  const visible = dropInvisibleRows(deduped, input, stillPendingIds);
  // 6
  const resequenced = resequencePrompts(visible, lifecycle);
  // 7
  const echoes = remainingEchoes(input.pending, lifecycle).map(input.echo);
  return placeEchoesBelow(resequenced, echoes);
}
