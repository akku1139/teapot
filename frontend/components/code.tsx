import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { ansiRuns, hasAnsi } from "../lib/ansi";
import { fmtDur } from "../lib/format";
import { cacheHighlighted, highlightedHtml } from "../lib/highlight-cache";

export function BashElapsed(props: { startedAt: string; inline?: boolean; timeoutMs?: number }) {
  const start = new Date(props.startedAt).getTime();
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => clearInterval(t));
  });
  const txt = () => fmtDur(Math.max(0, now() - start));
  if (props.inline) {
    return (
      <span class="bashelapsed">
        running… {txt()}
        {props.timeoutMs ? ` · timeout ${Math.round(props.timeoutMs / 1000)}s` : ""}
      </span>
    );
  }  return <span class="bashelapsed">{txt()} elapsed</span>;
}

export function ThinkingTimer(props: { startedAt: number }) {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => clearInterval(t));
  });
  const txt = () => {
    if (!props.startedAt) return null;
    const elapsed = Math.max(0, now() - props.startedAt);
    if (elapsed > 24 * 60 * 60 * 1000) return null; 
    return fmtDur(elapsed);
  };
  return (
    <Show when={txt() !== null} fallback={null}>
      <span class="thinktimer">{txt()}</span>
    </Show>
  );
}

export function AnsiText(props: { text: string }) {
  const runs = createMemo(() => (hasAnsi(props.text) ? ansiRuns(props.text) : null));
  return (
    <Show
      when={runs()}
      fallback={<pre class="mono toolbody">{props.text}</pre>}
    >
      <pre class="mono toolbody ansi">
        <For each={runs()!}>
          {(r) => (r.classes.length ? <span class={r.classes.join(" ")}>{r.text}</span> : r.text)}
        </For>
      </pre>
    </Show>
  );
}

export function HighlightedCode(props: { text: string; lang?: string }) {
  const key = () => (props.lang ? `${props.lang}::${props.text.length}::${props.text}` : "");
  const cached = () => (props.lang ? highlightedHtml(key()) : undefined);
  const [html, setHtml] = createSignal(cached() ?? "");
  createEffect(() => {
    const k = key();
    const text = props.text;
    const lang = props.lang;
    if (!lang || !text.trim()) { setHtml(""); return; }
    const hit = highlightedHtml(k);
    if (hit !== undefined) { setHtml(hit); return; }
    void (async () => {
      try {
        const { highlightLangChunks } = await import("../lib/shiki");
        let acc = "";
        for await (const chunk of highlightLangChunks(lang, text)) acc += chunk;
        if (!acc) return;
        cacheHighlighted(k, acc);
        if (key() === k) setHtml(acc);
      } catch {
      }
    })();
  });
  return (
    <Show when={!!html()} fallback={<pre class="mono toolbody">{props.text}</pre>}>
      {}
      <div class="toolbody shiki" innerHTML={html()} />
    </Show>
  );
}
