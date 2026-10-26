
export interface LiveBuf {
  text: string;
  reasoning: string;
  at: number;
}

export function applyDelta(
  prev: Map<string, LiveBuf>,
  agentId: string,
  patch: { text?: string; reasoning?: string },
  now = Date.now(),
): Map<string, LiveBuf> {
  const m = new Map(prev);
  m.set(agentId, {
    text: patch.text ?? "",
    reasoning: patch.reasoning ?? "",
    at: now,
  });
  return m;
}

export function clearLive(prev: Map<string, LiveBuf>, agentId: string): Map<string, LiveBuf> {
  if (!prev.has(agentId)) return prev;
  const m = new Map(prev);
  m.delete(agentId);
  return m;
}

export function isTurnBoundary(ev: unknown): boolean {
  const e = ev as { type?: string; data?: { detail?: string } } | null;
  return e?.type === "state" && e.data?.detail === "llm turn start";
}

export function isLiveStatus(status: string | undefined): boolean {
  return status === "running" || status === "waiting" || status === "needs_operator";
}

export interface LiveBufferStatus {
  textCovered: boolean;
  reasoningStale: boolean;
}

export function liveBufferStatus(
  buf: LiveBuf,
  events: { type?: string; ts?: string; data?: { role?: string; content?: string } }[],
  status: string | undefined,
): LiveBufferStatus {
  const text = buf.text.trim();
  const assistant = assistantTexts(events);
  const live = isLiveStatus(status);
  return {
    textCovered: !text || assistant.has(text),
    reasoningStale:
      !buf.reasoning.trim() ||
      loggedReasoning(events).has(buf.reasoning.trim()) ||
      (live && startedToolCallSince(events, buf.at)),
  };
}

export function liveBufferRemainder(
  buf: LiveBuf,
  events: { type?: string; ts?: string; data?: { role?: string; content?: string } }[],
  status: string | undefined,
): { text: string; reasoning: string; live: boolean; empty: boolean } {
  const st = liveBufferStatus(buf, events, status);
  const text = st.textCovered ? "" : buf.text;
  const reasoning = st.reasoningStale ? "" : buf.reasoning;
  const live = isLiveStatus(status);
  const nothingPending = !text.trim() && !reasoning.trim();
  const sawContent = !!buf.text.trim() || !!buf.reasoning.trim();
  return { text, reasoning, live, empty: nothingPending && (!live || sawContent) };
}

export function isCoveredByLog(
  buf: LiveBuf | null | undefined,
  events: { type?: string; ts?: string; data?: { role?: string; content?: string } }[],
  status: string | undefined,
): boolean {
  if (!buf) return false;
  return liveBufferRemainder(buf, events, status).empty;
}

function startedToolCallSince(
  events: { type?: string; ts?: string }[],
  at: number,
): boolean {
  if (!at) return false;
  return events.some((e) => {
    if (e.type !== "tool_call") return false;
    const t = Date.parse(String(e.ts ?? ""));
    return Number.isFinite(t) && t > at;
  });
}

function loggedReasoning(
  events: { data?: { reasoning?: unknown } }[] | readonly { data?: unknown }[],
): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    const r = String((e.data as { reasoning?: unknown } | undefined)?.reasoning ?? "").trim();
    if (r) out.add(r);
  }
  return out;
}

function assistantTexts(events: { type?: string; data?: { role?: string; content?: string } }[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.type === "message" && e.data?.role === "assistant") out.add(String(e.data.content ?? "").trim());
  }
  return out;
}

export function isOwnLiveWork(row: { data?: { actor?: unknown } } | null | undefined): boolean {
  if (!row) return false;
  const actor = row.data?.actor;
  return !(typeof actor === "string" && actor.length > 0);
}

export function pruneDeadLiveBuffers<T>(
  buffers: ReadonlyMap<string, T>,
  statusOf: (agentId: string) => string | undefined,
): Map<string, T> {
  const doomed: string[] = [];
  for (const id of buffers.keys()) {
    const st = statusOf(id);
    if (st === undefined) continue; 
    if (isLiveStatus(st)) continue; 
    doomed.push(id);
  }
  if (doomed.length === 0) return buffers as Map<string, T>;
  const out = new Map(buffers);
  for (const id of doomed) out.delete(id);
  return out;
}

export function reconcileLiveBuffer(
  buf: LiveBuf | null | undefined,
  events: { type?: string; ts?: string; data?: { role?: string; content?: string } }[],
  status: string | undefined,
): LiveBuf | null {
  if (!buf) return null;
  const rest = liveBufferRemainder(buf, events, status);
  if (rest.empty) return null;
  if (rest.text === buf.text && rest.reasoning === buf.reasoning) return buf;
  return { text: rest.text, reasoning: rest.reasoning, at: buf.at };
}

export function clearThinkClockIfDone(
  startedAt: number,
  agents: readonly { id: string; status?: string; session?: string }[],
  selected: string | null | undefined,
  live: { text: string; reasoning: string } | null | undefined,
): number {
  if (!startedAt) return 0; 
  if (live) return startedAt;
  if (!selected) return 0;
  const a = agents.find((x) => x.id === selected);
  if (a?.status === "running" || a?.status === "waiting" || a?.status === "needs_operator") {
    return startedAt;
  }
  return 0;
}
