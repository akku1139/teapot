import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { ansiRuns, hasAnsi } from "../lib/ansi";
import { fmtDur, truncate } from "../lib/format";

const HIGHLIGHT_CACHE = new Map<string, string>();
const HIGHLIGHT_MAX = 400;

function highlightCachePut(key: string, html: string): void {
  if (HIGHLIGHT_CACHE.size >= HIGHLIGHT_MAX) {
    // Map preserves insertion order, so this drops the oldest entry
    const oldest = HIGHLIGHT_CACHE.keys().next();
    if (!oldest.done) HIGHLIGHT_CACHE.delete(oldest.value);
  }
  HIGHLIGHT_CACHE.set(key, html);
}

export function BashElapsed(props: { startedAt: string; inline?: boolean; timeoutMs?: number }) {
  const start = new Date(props.startedAt).getTime();
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    // 500ms tick is plenty for a seconds readout and stops with the row
    const t = setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => clearInterval(t));
  });
  // shares fmtDur() with the finished rows so a running call and its result
  // read identically instead of flipping between two formats (#24)
  const txt = () => fmtDur(Math.max(0, now() - start));
  // inline: compact form for the folded summary ("running… 1m 26s")
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
  // #131: `startedAt` is 0 until a reasoning delta arms the clock, which is the
  // state right after a session switch. `now() - 0` is elapsed since the EPOCH, so
  // it flashed "thinking 497531h". 0 is a sentinel, never a timestamp.
  if (!props.startedAt) return null;
  return <span class="thinktimer">{fmtDur(Math.max(0, now() - props.startedAt))}</span>;
}

export function AnsiText(props: { text: string }) {
  /**
   * Only pay for the tokenizer when the text can contain escapes.
   *
   * Most results are plain, and `ansiRuns` walks every character; the gate keeps the common case at
   * a single `includes`.
   */
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
  // a separator that cannot appear in a language id or in the code itself
  const key = () => (props.lang ? `${props.lang}::${props.text.length}::${props.text}` : "");
  const cached = () => (props.lang ? HIGHLIGHT_CACHE.get(key()) : undefined);
  const [html, setHtml] = createSignal(cached() ?? "");
  createEffect(() => {
    const k = key();
    const text = props.text;
    const lang = props.lang;
    if (!lang || !text.trim()) { setHtml(""); return; }
    const hit = HIGHLIGHT_CACHE.get(k);
    if (hit !== undefined) { setHtml(hit); return; }
    /**
     * No "is my run still current" guard.
     *
     * The result is cached by CONTENT, so it does not matter which instance produced it or whether
     * that instance still exists — the next mount reads it back. A guard could only throw work
     * away, and that is how an earlier version lost the highlighting entirely.
     */
    void (async () => {
      try {
        const { highlightLangChunks } = await import("../lib/shiki");
        let acc = "";
        for await (const chunk of highlightLangChunks(lang, text)) acc += chunk;
        if (!acc) return;
        highlightCachePut(k, acc);
        // paint only if this instance is still asking for the same content
        if (key() === k) setHtml(acc);
      } catch {
        // give up → the plain fallback stays
      }
    })();
  });
  /**
   * `when={!!html()}`: a boolean, so Solid re-evaluates the CONDITION reactively.
   *
   * `when={html()}` also tracks, but the CHILD below is an accessor-free element — it is created
   * once when the condition first holds. MEASURED: the effect logged `{chunks: 1, accLen: 604}`
   * while the DOM still held the plain `<pre>` fallback, which is why "ツールカードのshiki効いてない"
   * looked like the highlighter was failing when it had actually succeeded.
   */
  return (
    <Show when={!!html()} fallback={<pre class="mono toolbody">{props.text}</pre>}>
      {/**
        * The wrapper carries BOTH classes the stylesheet keys on: `toolbody` for the shared surface
        * and `shiki` for the dual-theme colour variables. Shiki emits its own
        * `<pre class="shiki"><code>…</code></pre>` — markup we generate from a grammar, never from
        * user input — so the inner `<pre>` must not paint a second surface of its own.
        */}
      <div class="toolbody shiki" innerHTML={html()} />
    </Show>
  );
}
