import { Show } from "solid-js";
import { BashElapsed } from "./code";

/**
 * The header of a row: a BOLD label and an optional DIM tail, and nothing else.
 *
 * WHY THE SHAPE IS SEALED: a caller hands over STRINGS (or, for a markdown label, one pre-rendered HTML string), so no caller can
 * add a third flex item of its own. That is the point — the flex rules are what keep the label shrinking and the dim tail whole,
 * and a caller that puts something in between breaks that relationship without touching this file. MEASURED: a bash header showing a
 * long command ellipsised its own DURATION away, because both the label and the tail were flex items with `min-width: 0` and the
 * browser shrank both — the label has to be the only thing that may shrink.
 *
 * A union rather than an optional `boldHtml`: half the header passing HTML and half passing text is not something a type should be
 * allowed to express loosely.
 */
type RowHeadCommon = {
  /** the DIM tail — a duration, a count, a mode. Never shrinks, never wraps. */
  dim?: string | undefined;
  /** a LIVE elapsed counter instead of `dim` (a running tool has no duration yet) */
  elapsedSince?: string | undefined;
  /** the timeout the counter is running under, so the row explains the limit it is about to hit */
  elapsedTimeoutMs?: number | undefined;
  /** a dim `@actor` chip, separate so it is never mistaken for part of the label */
  actor?: string | undefined;
  /** a leading dim glyph (📌, 🔎) — its own slot, so it is never part of the ellipsised label */
  glyph?: string | undefined;
};
export type RowHeadProps = RowHeadCommon & ({ bold: string; boldHtml?: never } | { boldHtml: string; bold?: never });

export function RowHead(props: RowHeadProps) {
  return (
    <>
      <Show when={props.glyph}>
        <span class="rowhead-glyph">{props.glyph}</span>
      </Show>
      <Show when={"boldHtml" in props} fallback={<b class="rowhead-bold">{props.bold}</b>}>
        <b class="rowhead-bold content inline-md" innerHTML={(props as { boldHtml: string }).boldHtml} />
      </Show>
      <Show when={props.actor}>
        <span class="rowhead-actor">@{String(props.actor)}</span>
      </Show>
      <Show when={props.elapsedSince}>
        <span class="rowhead-dim">
          <BashElapsed startedAt={String(props.elapsedSince)} inline timeoutMs={props.elapsedTimeoutMs} />
        </span>
      </Show>
      <Show when={!props.elapsedSince && props.dim !== undefined}>
        <span class="rowhead-dim">{props.dim}</span>
      </Show>
    </>
  );
}
