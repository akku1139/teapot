/**
 * What a `todo` event means, as the timeline should say it.
 *
 * The row used to read "✅ tasks updated (agent)" whatever happened — the same line for "I finished the parser" and "I added
 * three steps". The operator's ask: "アップデートのタイプ(追加、完了、置換など)によって上手いこと". The event carries the counts AND
 * (since that report) the texts, so the row can say which items moved and in which direction.
 *
 * The label is chosen by what actually changed, so a completion reads as a completion. A `set` (the whole list replaced by
 * the operator or the agent) has no per-item detail and says so instead of inventing some.
 */
export interface TodoEventData {
  event?: unknown;
  by?: unknown;
  matched?: unknown;
  added?: unknown;
  removed?: unknown;
  unknown?: unknown;
  done?: unknown;
  reopened?: unknown;
  addedItems?: unknown;
  removedItems?: unknown;
}

export interface TodoSummary {
  /** the one-line label: a verb that matches what happened */
  label: string;
  /** item lines, grouped by what happened to them; empty when the event carries no detail */
  body: string;
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim()) : [];

const glyph = (ok: string, pending: string) => ({ ok, pending });

function hasItemDetail(data: TodoEventData | undefined): boolean {
  return (
    Array.isArray(data?.done) ||
    Array.isArray(data?.reopened) ||
    Array.isArray(data?.addedItems) ||
    Array.isArray(data?.removedItems) ||
    Array.isArray(data?.unknown)
  );
}

/** one item line: the glyph says the direction, the text says which item */
function section(items: string[], g: { ok: string; pending: string }): string[] {
  return items.map((t) => `${g.ok} ${t}`);
}

export function summarizeTodo(data: TodoEventData | undefined): TodoSummary {
  const by = String(data?.by ?? "operator");
  const who = by === "human" ? "operator" : by;
  /**
   * A missing `event` is not a replacement. `set` is the literal event name the server writes when it replaces the list, so an
   * event that carries item data without naming itself is an ITEM update (an older producer, or a log written before the name
   * existed) — reading it as "replaced" would claim a wholesale rewrite that never happened.
   */
  const named = typeof data?.event === "string" ? data.event : "";
  const looksLikeItems = Array.isArray((data as { items?: unknown } | undefined)?.items) || hasItemDetail(data);
  const ev = named || (looksLikeItems ? "items" : "set");

  /**
   * The counts are the only thing that can distinguish "the whole list was replaced" from "an item moved", so an event
   * WITHOUT them is not evidence of a replacement — an older log, or a producer that only set `by`, says `updated` and stops
   * there. Only a real `set` (which carries no counts by construction, but also no item lists) is reported as a replacement.
   */
  const countsKnown =
    typeof data?.matched === "number" || typeof data?.added === "number" || typeof data?.removed === "number";

  /**
   * A REPLACEMENT is a `set` — the whole list written at once — and there is no per-item delta to report for it, so the row
   * says that and stops. Anything else is a per-item update, whose counts may be missing in an older log; that reads
   * `updated`, which claims nothing about direction.
   */
  if (ev === "set") {
    return { label: `✅ tasks replaced (${who})`, body: "" };
  }

  const done = strList(data?.done);
  const reopened = strList(data?.reopened);
  const added = strList(data?.addedItems);
  const removed = strList(data?.removedItems);
  const unknown = strList(data?.unknown);

  /**
   * The verb comes from what changed, most-consequential first: a completion is the news, an addition is the next most, and
   * "updated" is the fallback for a log written before the texts were recorded (counts only).
   */
  const parts: string[] = [];
  if (done.length) parts.push(`✔ ${done.length} done`);
  if (added.length) parts.push(`＋ ${added.length} added`);
  if (reopened.length) parts.push(`↺ ${reopened.length} reopened`);
  if (removed.length) parts.push(`－ ${removed.length} removed`);

  const label = parts.length
    ? `✅ tasks ${parts.join(" · ")} (${who})`
    : countsKnown
      ? // an older event: the counts are all it has, so say the counts and do not claim a direction
        `✅ tasks updated (${who})`
      : `✅ tasks updated (${who})`;

  const body = [
    ...section(done, glyph("✔", "·")),
    ...section(added, glyph("＋", "·")),
    ...section(reopened, glyph("↺", "·")),
    ...section(removed, glyph("－", "·")),
    ...(unknown.length ? unknown.map((t) => `⚠ not found: ${t}`) : []),
  ].join("\n");

  return { label, body };
}
