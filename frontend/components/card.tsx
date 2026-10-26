import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { renderMarkdown } from "../md";

export function Card(props: {
  title?: string;
  meta?: string;
  tone?: "ok" | "warn" | "tool";
  class?: string;
  markdown?: boolean;
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
