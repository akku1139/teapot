import { pendingFloor, placeEchoesBelow, resequenceToDelivery } from "./timeline-order.ts";

export interface TimelineEvent {
  id: string;
  seq: number;
  ts?: string;
  type: string;
  data?: any;
  session?: string;
  branch?: string;
}

export interface PendingEchoLike {
  id: string;
  promptId?: string;
  at: number;
  text: string;
  sent: boolean;
}

export interface TimelineInput {
  events: readonly TimelineEvent[];
  consumed: ReadonlySet<string>;
  pending: readonly PendingEchoLike[];
  /** ids the server still lists in its pending queue — their log rows must not render as settled */
  serverPendingIds?: readonly string[];
  echo: (p: PendingEchoLike) => TimelineEvent;
  feedTypes: ReadonlySet<string>;
  renderedTypes: ReadonlySet<string>;
  renderedNoteEvents: ReadonlySet<string>;
}

const META_TOOLS_HIDDEN = new Set(["report_progress", "ask_operator", "ask_user", "record_decision"]);

export function feedCandidates(input: TimelineInput): TimelineEvent[] {
  const { events, consumed, feedTypes } = input;
  return events.filter((e) => {
    if (e.type === "sub") return true;
    if (!feedTypes.has(e.type)) return false;
    const metaToolName =
      e.type === "tool_call" || e.type === "tool_result" ? String(e.data?.name ?? "") : "";
    if (META_TOOLS_HIDDEN.has(metaToolName)) return false;
    if (e.type === "tool_result") return !consumed.has(e.id);
    if (e.type === "message") {
      const content = String(e.data?.content ?? "");
      const reasoning = String(e.data?.reasoning ?? "");
      if (content.trim() === "" && reasoning.trim() !== "" && e.data?._prevKind === "tool")
        return false;
      if (e.data?.progressEcho) return false;
      if (!e.data?.final && content.trim() === "(tool call)") return false;
      return content.trim() !== "" || reasoning.trim() !== "" || !!e.data?.final;
    }
    return true;
  });
}

export function expandSubRows(events: readonly TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const e of events) {
    if (e.type !== "sub") {
      out.push(e);
      continue;
    }
    const d = e.data as { sub?: string; type?: string; data?: any };
    const kind = String(d?.type ?? "message");
    if (kind === "state") continue;
    out.push({ ...e, type: kind, data: { ...(d?.data ?? {}), actor: d?.sub } });
  }
  return out;
}

const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

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

export function promptLifecycle(events: readonly TimelineEvent[]): {
  deliveredIds: Set<string>;
  loggedUserPrompts: Set<string>;
  /** every prompt id the LOG already carries, harness included — that row is the queue row, no echo needed */
  loggedPromptIds: Set<string>;
  deliveredNotes: Map<string, number>;
  cancelledNotes: Map<string, number>;
} {
  const deliveredIds = new Set<string>();
  const loggedUserPrompts = new Set<string>();
  const loggedPromptIds = new Set<string>();
  const deliveredNotes = new Map<string, number>();
  const cancelledNotes = new Map<string, number>();
  for (const e of events) {
    const pid = e.data?.promptId;
    if (!pid) continue;
    if (e.type === "prompt") loggedPromptIds.add(String(pid));
    if (e.type === "prompt" && e.data?.source === "user") loggedUserPrompts.add(String(pid));
    if (e.type === "system_note" && e.data?.event === "prompt-delivered") {
      deliveredIds.add(String(pid));
      deliveredNotes.set(String(pid), e.seq);
    }
    if (e.type === "system_note" && e.data?.event === "prompt-cancelled")
      cancelledNotes.set(String(pid), e.seq);
  }
  return { deliveredIds, loggedUserPrompts, loggedPromptIds, deliveredNotes, cancelledNotes };
}

/**
 * A prompt that has not been delivered yet IS the queued row — whoever drew it.
 *
 * MEASURED (both recurring reports): the "pending" look was only ever put on the client's optimistic echo, so the LOG row
 * for the same prompt rendered settled until the echo was removed or a snapshot caught up. Two visible consequences:
 *
 *   - a prompt sent to an idle agent flashed settled for a frame (the echo was replaced by the log row before the
 *     delivery note arrived);
 *   - a harness prompt queued behind another harness prompt "一瞬確定する" — harness prompts have no local echo at all,
 *     so their log row is what the operator sees, and it was drawn as if it had already run.
 *
 * The delivery note (`prompt-delivered`) is the single source of truth for "it ran", and it is logged by the server that
 * dispatched it. Everything after the newest note is still waiting, which also bounds this to the live tail so an old log
 * that never recorded a note cannot make ancient prompts look queued.
 */
const awaitingCache = new WeakMap<TimelineEvent, TimelineEvent>();

/**
 * Where a WAITING prompt row sits: after everything else, in arrival order.
 *
 * MEASURED (the "task4 → task3 と一瞬並んで、すぐ 3→4 に戻る" report, and the same on the goal path): a harness prompt has
 * no optimistic echo, so its LOG row appears first at its natural seq — above the queue — and the next snapshot swaps it
 * for a queue clone whose seq is `MAX_SAFE_INTEGER`. The row visibly jumped to the bottom. Keeping the log row (there is
 * one owner now) but placing it where the queue is removes the jump: waiting prompts sort after delivered history, in the
 * order they were enqueued.
 */
const QUEUED_TAIL_SEQ = Number.MAX_SAFE_INTEGER - 100_000;
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

export function markAwaitingPrompts(
  events: readonly TimelineEvent[],
  _lifecycle: ReturnType<typeof promptLifecycle>,
  /**
   * The prompts the SERVER still reports as queued.
   *
   * The delivery note settles a prompt, but a log written before harness prompts produced one (anything older than
   * v0.37.172) has no note at all — so `ahead > 0` alone kept those rows saying "queued…" for ever, which is the report
   * "harnessのメッセージがqueuedから外れなくなった". The snapshot's list is the live truth: a prompt that is not in it is
   * not waiting, whatever its log says.
   */
  livePendingIds?: ReadonlySet<string>,
): TimelineEvent[] {
  const newestSeq = events.reduce((m, e) => (e.seq > m ? e.seq : m), 0);
  return events.map((e) => {
    if (e.type !== "prompt") return e;
    /**
     * The SERVER's queue position, recorded when it enqueued the prompt. `> 0` means something was in front of it.
     *
     * This replaced a delivery-note inference ("no note yet ⇒ queued"), which was wrong for the one case the operator
     * kept reporting: an idle (or waiting) agent takes the prompt within milliseconds, so the row that had not yet seen
     * its note claimed "queued…" for a frame — "idleやwaitingからプロンプト送ると一瞬キューになってる". A missing note is
     * not a queue; an `ahead` count is.
     */
    const ahead = Number(e.data?.ahead ?? 0);
    if (!(ahead > 0)) return e;
    const pid = String(e.data?.promptId ?? "");
    if (_lifecycle.deliveredIds.has(pid)) return e;
    if (_lifecycle.cancelledNotes.has(pid)) return e;
    /**
     * The event's OWN `ahead` decides, and the server's live list only refines it for rows that are not fresh.
     *
     * MEASURED (issue #224): gating on `pendingPromptIds` alone inverted the flicker — a prompt sent to a RUNNING agent
     * arrived as a log row and rendered SETTLED for ~17ms (one frame) until the snapshot listed it, then flipped to
     * "queued…". The log row already carries the queue position the server recorded at enqueue, so the first frame can
     * be right; the snapshot is only needed to settle STALE rows (a log written before v0.37.172 has no delivery note, so
     * nothing else could ever settle them).
     *
     * `recent` is what separates the two: only the tail of the log can be waiting, so an old row is settled even when the
     * server is silent about it, and a fresh one is trusted even before the snapshot arrives.
     */
    const recent = e.seq > newestSeq - 8;
    if (livePendingIds && !livePendingIds.has(pid) && !recent) return e;
    if (e.data?.pending) return e;
    /**
     * Cached, because a row's OBJECT IDENTITY is what keeps Solid from re-creating it (and the suite names that
     * contract). Handing back a fresh object on every build would re-render every waiting prompt on every event.
     */
    const hit = awaitingCache.get(e);
    if (hit) return hit;
    const marked = { ...e, seq: QUEUED_TAIL_SEQ + e.seq, data: { ...e.data, pending: true, queued: true } };
    awaitingCache.set(e, marked);
    return marked;
  });
}

export function dropInvisibleRows(
  events: readonly TimelineEvent[],
  input: Pick<TimelineInput, "renderedTypes" | "renderedNoteEvents">,
  stillPendingIds: ReadonlySet<string>,
): TimelineEvent[] {
  return events.filter((e) => {
    if (!input.renderedTypes.has(e.type))
      return e.type === "system_note" && input.renderedNoteEvents.has(String(e.data?.event ?? ""));
    if (e.type !== "prompt") return true;
    /**
     * ANY source: a prompt the harness queued is as pending as one the operator typed.
     *
     * Only `source === "user"` rows were hidden, so a queued HARNESS prompt was drawn twice — its log row as if it had
     * already run, plus the queue clone that says "queued…": "#122 harness からのメッセージがpendingであるにもかかわらず、
     * メッセージにpending表示がついてない". The clone is what the operator should see, for both sources.
     */
    const pid = String(e.data?.promptId ?? "");
    return pid === "" || !stillPendingIds.has(pid);
  });
}

const cancelledCache = new WeakMap<TimelineEvent, Map<number, TimelineEvent>>();

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
    const marked =
      cancelSeq !== undefined ? withCancelled(e, cancelSeq) : e;
    if (settled !== undefined) {
      out.push(resequenceToDelivery(marked, settled));
      continue;
    }
    const floor = floorOf(marked.seq);
    out.push(marked.seq === floor ? marked : { ...marked, seq: floor });
  }
  return out;
}

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

export function pendingEchoCount(
  pending: readonly PendingEchoLike[],
  lifecycle: ReturnType<typeof promptLifecycle>,
): number {
  return remainingEchoes(pending, lifecycle).length;
}

export function buildTimeline(input: TimelineInput): TimelineEvent[] {
  return buildTimelineWithCount(input).rows;
}

export function buildTimelineWithCount(input: TimelineInput): {
  rows: TimelineEvent[];
  pendingCount: number;
} {
  const candidates = feedCandidates(input);
  const expanded = expandSubRows(candidates);
  const deduped = dedupeAgainstEmbeds(expanded);
  const lifecycle = promptLifecycle(deduped);
  const stillPendingIds = new Set<string>();
  for (const p of input.pending) {
    if (p.promptId && !lifecycle.deliveredIds.has(p.promptId)) stillPendingIds.add(p.promptId);
  }
  /**
   * …and every id the SERVER still reports as queued.
   *
   * The server logs a `prompt` event when a prompt is enqueued, so its row exists in the log before the local echo has
   * been labelled with a `promptId`. The log row was therefore rendered as if it had been delivered — a settled copy of
   * a prompt that had not run yet, sitting next to its own queued echo until one of them went away:
   * "送った瞬間は適切にcancel/copyのついたキュー状態が出てるのに、その数フレーム後に何故か確定状態のメッセージが出て
   * queued状態のやつも当然残ってて、さらに数フレーム後に謎の確定状態のメッセージが消える".
   *
   * The echo is what draws a queued row, and `mergeQueued` creates one for ids that only the server knows about, so
   * hiding the log row here never leaves the prompt invisible.
   */
  for (const id of input.serverPendingIds ?? []) {
    // ONLY when an echo (or a queue clone) will draw the row in its place — hiding a log row with nothing behind it
    // would make the prompt disappear entirely, which is worse than the duplicate this exists to prevent
    if (!id || lifecycle.deliveredIds.has(id)) continue;
    if (input.pending.some((p) => p.promptId === id)) stillPendingIds.add(id);
  }
  const awaiting = markAwaitingPrompts(
    deduped,
    lifecycle,
    input.serverPendingIds ? new Set(input.serverPendingIds) : undefined,
  );
  /**
   * ONE owner per prompt: the log row if the server has logged it, the optimistic echo if it has not.
   *
   * The echo used to survive until delivery and the log row was hidden underneath it, which is what made a harness prompt
   * (no echo at all) and a user prompt (echo first) take different routes through the same queue. Deciding here — and
   * using the SAME list for `stillPendingIds` — means a row is drawn in exactly one place.
   */
  const drawnEchoes = remainingEchoes(input.pending, lifecycle).filter(
    (p) => !p.promptId || !lifecycle.loggedPromptIds.has(p.promptId),
  );
  /**
   * Nothing is hidden any more: an echo only exists while the log has no row for its prompt, so the log row can never be
   * a duplicate of one that is on screen. (Hiding it used to be the fix for "queued HARNESS prompts rendered twice", and
   * it created the opposite hole — a prompt whose echo had just been removed showed nothing at all for a frame.)
   */
  void stillPendingIds;
  const visible = dropInvisibleRows(awaiting, input, EMPTY_IDS);
  const resequenced = resequencePrompts(visible, lifecycle);
  const echoes = drawnEchoes.map(input.echo);
  const rows = placeEchoesBelow(resequenced, echoes);
  /**
   * How many rows SAY "queued…" — not how many prompts have not been delivered yet.
   *
   * MEASURED: the badge counted "not delivered yet", so a prompt sent to an IDLE agent made it flash for the few
   * milliseconds between enqueue and dispatch — "一瞬queuedになってる" with both the client's and the server's status
   * correctly idle. A prompt that is about to start is not a queue.
   */
  /**
   * The badge counts rows that SAY "queued…", and nothing else.
   *
   * Counting `pending` (or any echo) made an in-flight idle send flash a badge while the row itself showed a timestamp —
   * the two disagreed, which is how the operator noticed (#224). One predicate, used by the row and the badge.
   */
  const pendingCount = rows.filter((r) => r.data?.queued === true && !r.data?.sent).length;
  return { rows, pendingCount };
}
