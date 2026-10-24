import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { renderMarkdown } from "../md";

/**
 * The one card surface in this app, for both the timeline and the right panel.
 *
 * ## Why this exists
 *
 * `.card` was a class with two very different jobs: a panel in the sidebar, and a row in the
 * timeline. Each caller assembled it by hand and they diverged — the timeline's goal cards rendered
 * markdown into a bare `<div innerHTML>`, while a `goal` event whose detail is command-shaped went
 * through a FENCED CODE BLOCK instead. A fenced block becomes `<pre>`, and `<pre>` re-declares
 * `white-space: pre`, which stops the wrapping the card around it had been given.
 *
 * MEASURED: "🎯 goal set" wrapped correctly (markdown), "🔍️ completion audit started" scrolled
 * sideways (fenced block) — the same card, two renderings, one of them broken.
 *
 * Tool cards hit the identical trap and fixed it by hand (`.toolbody.shiki pre code`). Two
 * hand-maintained copies of that fix is how the third one gets forgotten, so the wrapping lives HERE
 * for every card body, and `pre`/`code` are handled as one case.
 *
 * ## The three kinds
 *
 *   - `title` — a small uppercase label above the body (a card that says WHAT it is showing)
 *   - `tone`  — the left rule: `ok` / `warn` / `tool`, so the card's meaning is visible at a glance
 *   - `markdown` (default) — prose renders as markdown
 *     `false` — command-shaped text (`npm test passes`) is shown VERBATIM. Markdown would
 *     reinterpret `*` globs and `_` as emphasis and silently mangle the thing being verified, so it
 *     is rendered in a wrapping code surface rather than as markdown.
 */
export function Card(props: {
  /** small uppercase label above the body */
  title?: string;
  /** right-aligned note beside the title (a timestamp, a source) */
  meta?: string;
  tone?: "ok" | "warn" | "tool";
  /** extra class for a card with its own layout (the goal ladder) */
  class?: string;
  /** render the body as markdown (default) or as verbatim command text */
  markdown?: boolean;
  /** raw markdown when `markdown`, otherwise the literal text to show */
  body: string;
  children?: JSX.Element;
}) {
  const classes = () => {
    const t = props.tone;
    return ["card", t ? `card-${t}` : "", props.class ?? ""].filter(Boolean).join(" ");
  };
  const html = () =>
    props.markdown === false
      ? renderMarkdown(`\`\`\`\n${props.body}\n\`\`\``)
      : renderMarkdown(props.body);
  return (
    <div class={classes()}>
      <Show when={props.title}>
        <div class="ctitle">
          {props.title}
          <Show when={props.meta}>
            <span class="meta muted">{props.meta}</span>
          </Show>
        </div>
      </Show>
      {props.children ?? <div class="cardbody" innerHTML={html()} />}
    </div>
  );
}
