
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
  echo: (p: PendingEchoLike) => TimelineEvent;
  feedTypes: ReadonlySet<string>;
  renderedTypes: ReadonlySet<string>;
  renderedNoteEvents: ReadonlySet<string>;
}

const META_TOOLS_HIDDEN = new Set(["report_progress", "ask_user", "record_decision"]);

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
  const visible = dropInvisibleRows(deduped, input, stillPendingIds);
  const resequenced = resequencePrompts(visible, lifecycle);
  const echoes = remainingEchoes(input.pending, lifecycle).map(input.echo);
  return { rows: placeEchoesBelow(resequenced, echoes), pendingCount: echoes.length };
}
