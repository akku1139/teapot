import { cacheHighlighted, highlightedHtml } from "./highlight-cache.ts";
import { langForPath } from "./shiki.ts";

/**
 * Upgrade fenced code blocks inside a rendered MESSAGE to shiki.
 *
 * Update: messages were rendered as an HTML string (`innerHTML`) by `md.js`, which emits
 * `<pre><code class="language-x">` and nothing more — so a C snippet in a chat message stayed flat
 * `--fg` while the very same snippet in a tool row was highlighted. The two paths have to agree.
 *
 * It cannot be a component: the message body is one big `innerHTML`, not a tree of Solid elements. So
 * this walks the DOM after render and REPLACES each `<pre>` once shiki has produced its HTML. Until
 * then the plain block stays, which is why there is no flash of unstyled or of empty content.
 *
 * ## The transparency contract, which has been broken repeatedly
 *
 * shiki writes an inline `background-color` on its `<pre class="shiki">` (github-dark's own surface).
 * On our translucent message surface that paints an opaque rectangle. The rule is the same one the tool
 * rows use: the output goes inside `.shikiwrap`, whose CSS makes shiki's own background transparent and
 * paints NO surface of its own, so the message's surface shows through unchanged.
 */
const LANG_CLASS = /(?:^|\s)language-([\w+#.-]+)/;

/** per-element markers, so a re-render does not redo work or fight a pending swap */
const DONE = "hl";

export function highlightMessageCode(root: HTMLElement | null | undefined): void {
  if (!root) return;
  for (const pre of root.querySelectorAll<HTMLPreElement>("pre")) {
    if (pre.dataset[DONE]) continue;
    const code = pre.querySelector("code");
    if (!code) {
      pre.dataset[DONE] = "skip";
      continue;
    }
    const raw = LANG_CLASS.exec(code.className)?.[1];
    /**
     * An info string is usually an EXTENSION (`ts`, `py`, `yml`), and shiki only knows language NAMES
     * (`typescript`). MEASURED: `highlightLangChunks("ts", …)` yields nothing while
     * `("typescript", …)` returns the highlighted HTML — so passing the raw string through would leave
     * every ```ts block in a message flat, which is the bug this whole change is about.
     */
    const lang = raw ? (langForPath(`x.${raw}`) ?? raw) : undefined;
    const text = code.textContent ?? "";
    if (!lang || !text.trim()) {
      // no info string = the author did not ask for a language; leave it as a plain block
      pre.dataset[DONE] = "skip";
      continue;
    }
    const key = `${lang}::${text.length}::${text}`;
    pre.dataset[DONE] = "pending";

    const hit = highlightedHtml(key);
    if (hit !== undefined) {
      swap(pre, hit);
      continue;
    }
    void (async () => {
      try {
        const { highlightLangChunks } = await import("./shiki.ts");
        let acc = "";
        for await (const chunk of highlightLangChunks(lang, text)) acc += chunk;
        if (!acc) {
          pre.dataset[DONE] = "skip";
          return;
        }
        cacheHighlighted(key, acc);
        // the row may have been re-rendered or scrolled out while we were working
        if (pre.isConnected) swap(pre, acc);
      } catch {
        pre.dataset[DONE] = "skip";
      }
    })();
  }
}

function swap(pre: HTMLPreElement, html: string): void {
  const wrap = document.createElement("div");
  wrap.className = "shikiwrap";
  const inner = document.createElement("div");
  // `.shikiwrap .shiki` is what makes shiki's inline background lose; the wrapper paints nothing
  inner.className = "shiki";
  inner.innerHTML = html;
  wrap.appendChild(inner);
  pre.replaceWith(wrap);
}
