/**
 * Tiny dependency-free Markdown renderer (plain ES module, no build step).
 * Strategy: escape ALL HTML first, then apply a small set of block/inline
 * rules on the escaped text. Output is XSS-safe because raw <,>,& in input
 * can never survive as markup.
 *
 * Blocks: fenced code (3+ backticks, info string kept as a language class) ·
 * headings #–###### · ul/ol incl. one-level nesting, loose lists & task items ·
 * GFM pipe tables (alignment, escaped pipes) · blockquotes · horizontal rules ·
 * paragraphs.
 * Inline: code spans (protected), images, links, bare autolinks, ***bold-
 * italic***, **bold**, __bold__, *em*, _em_, ~~strike~~.
 *
 * ## Deliberate divergences from CommonMark
 *
 * Written down because "is this a bug or a choice?" comes up every time, and an
 * undocumented choice gets re-reported as a defect.
 *
 *   - **A newline inside a paragraph is `<br>`.** CommonMark says a soft break is a
 *     space. This renders CHAT: an operator typing three short lines means three lines,
 *     and collapsing them loses meaning that no amount of spec compliance gives back.
 *   - **Not supported, on purpose**: setext headings, indented code blocks, reference
 *     links, backslash escapes (other than `\|` in tables), multi-backtick code spans,
 *     and raw HTML passthrough. Each is either rare in chat or an XSS surface, and the
 *     escape-first design is what makes the renderer safe to point at model output.
 *   - **Tab width in `indentOf` is 2, not CommonMark's 4.** Model output is usually
 *     two-space indented, and honouring 4 would stop most real nested lists from
 *     nesting at all.
 *   - **A row is a table before it is a list item**, so `- a | b` followed by a
 *     separator row becomes a table. Rare, and the alternative misparses far more
 *     common input.
 */
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Public entry: escape everything up front, then structure the lines. */
export function renderMarkdown(src) {
  return renderEscaped(escapeHtml(src.replace(/\r\n/g, "\n")).split("\n"));
}

/**
 * Structure already-escaped lines into HTML. Blockquote recursion calls this
 * directly so inner content is never double-escaped.
 */
function renderEscaped(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // fenced code block. The info string may be any non-whitespace run
    // (`js`, `/subject/why-qa`, `text .txt`…) — the old /\w*/ pattern rejected
    // slash-y pseudo-paths, which made the line fall through to paragraph
    // handling and HANGED the renderer on such chats.
    const fence = line.match(/^(`{3,})([^\n]*)$/);
    if (fence && !/^```.+\`\`\`/.test(line)) {
      const ticks = fence[1].length;
      // The INFO STRING is kept as a class, which is what makes syntax highlighting
      // possible at all — it used to be discarded, so every block rendered unhighlighted.
      const info = fence[2].trim().split(/\s+/)[0] ?? "";
      const buf = [];
      i++;
      // A fence closes with AT LEAST as many backticks as opened it. Matching exactly
      // three meant a four-backtick fence never closed and ran to EOF — and the case
      // people write it for is nesting a ``` block inside one.
      const close = new RegExp("^`{" + ticks + ",}\\s*$");
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence (may be missing — unclosed fence just runs to EOF)
      /**
       * The LANGUAGE is the last path/extension segment of the info string.
       *
       * ` ```src/index.ts ` is a common way to say "this is that file", and the old rule stripped the
       * slash (`srcindex.ts`), which no highlighter can resolve — so a filename-tagged block silently
       * stayed flat while a bare ```c was highlighted. Taking the extension is what makes both work;
       * the original string is kept for a title.
       */
      const token = info ? info.split(/\s+/)[0] : "";
      const lang = token ? token.split("/").pop().split(".").pop().replace(/[^\w+#-]/g, "") : "";
      const cls = lang ? ` class="language-${lang}"` : "";
      // NO extra attribute on <pre>: the info string is already HTML-escaped by this point, so echoing
      // it as a title produced `aquotbgtltscriptgt` for `a&b>c<script>` — and the renderer's contract is
      // a bare `<pre><code class=...>`, which is what the highlighter and the tests both expect.
      out.push(`<pre><code${cls}>${buf.join("\n")}</code></pre>`);
      continue;
    }
    // horizontal rule (before list: *** / --- would otherwise look like items)
    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    // heading (# through ###### → h1–h6)
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    // blockquote (recursive → nested quotes/lists/tables all work);
    // escapeHtml turned ">" into "&gt;", so match the escaped marker
    if (/^\s*&gt;/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*&gt;/.test(lines[i])) buf.push(lines[i++].replace(/^\s*&gt;\s?/, ""));
      out.push(`<blockquote>${renderEscaped(buf)}</blockquote>`);
      continue;
    }
    // table (GFM): header row containing |, then a --- separator row
    if (line.includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const align = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left",
      );
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /\S/.test(lines[i]) && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const cell = (c, idx, tag) => {
        const a = align[idx];
        const style = a && a !== "left" ? ` style="text-align:${a}"` : "";
        return `<${tag}${style}>${inline(c)}</${tag}>`;
      };
      // A header row of nothing but blank cells is a legal GFM table, and
      // cmark-gfm does render a <thead> for it — but visually it is a bare
      // strip of dark cells and a border above the real content, reading as a
      // stray empty row rather than as column headings. It also happens by
      // accident whenever someone pipes a table out of a tool whose header is
      // empty. So: keep the table, drop the meaningless <thead> entirely.
      // Only when EVERY cell is blank — a table with one real heading still
      // needs its header, and a partially-blank one keeps the blanks so the
      // real columns stay aligned over their data.
      const hasHeader = head.some((c) => c !== "");
      out.push(
        `<div class="tbl"><table>` +
          (hasHeader ? `<thead><tr>${head.map((c, k) => cell(c, k, "th")).join("")}</tr></thead>` : "") +
          `<tbody>${rows.map((r) => `<tr>${r.map((c, k) => cell(c, k, "td")).join("")}</tr>`).join("")}</tbody></table></div>`,
      );
      continue;
    }
    // list (ul/ol, task items, one level of nesting via indentation)
    if (LIST_ITEM.test(line)) {
      out.push(parseList(indentOf(line.match(LIST_ITEM)[1])));
      continue;
    }
    // blank line
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    // paragraph
    //
    // TERMINATION IS THE WHOLE CONTRACT HERE. Every branch in this loop must
    // consume at least one line, or the outer `while` re-reads the same line
    // forever. A line can match a guard ABOVE (which therefore declines it) and
    // still match one of these — "```js```" opens a fence but also contains
    // its own closer, so the fence branch skips it, and then the paragraph loop
    // skips it for starting with ```. Nothing consumed it. That hung the whole
    // browser tab, growing `out` by one empty <p> per spin, and it was
    // reachable from ordinary model output: a reply that typed an inline fence
    // (```js```) while streaming.
    //
    // So: if the paragraph is empty and we are still on the line we started
    // from, consume it unconditionally rather than spinning. A stray ``` is
    // better rendered as a paragraph than as a hang.
    const startLine = i;
    const para = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !lines[i].startsWith("```") &&
      !/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !/^\s*&gt;/.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1]))
    ) {
      para.push(lines[i++]);
    }
    if (i === startLine) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");

  function indentOf(ws) {
    return ws.replace(/\t/g, "  ").length;
  }

  /** Consumes list lines from i onward; returns HTML. One nesting level. */
  function parseList(minIndent) {
    let ordered = null;
    /** the first item's number, so `<ol start="3">` survives (it used to be dropped) */
    let start = 1;
    const items = [];
    while (i < lines.length) {
      const m = lines[i].match(LIST_ITEM);
      if (!m) break;
      const ind = indentOf(m[1]);
      if (ind < minIndent) break;
      const ol = /^\d/.test(m[2]);
      if (ordered === null) ordered = ol;
      else if (ol !== ordered) break; // marker type changed → close this list
      if (ordered && items.length === 0) {
        const n = Number.parseInt(m[2], 10);
        // CommonMark: the list starts at the first item's number (any other numbers are
        // ignored, which is why only the FIRST is read)
        if (Number.isFinite(n)) start = n;
      }
      i++;
      let body = m[3];
      // folded continuation lines (wrapped text belonging to this item)
      //
      // Every BLOCK-STARTING construct must end the item, or the block is swallowed as
      // item text. MEASURED: "- item\n---" produced `<li>item ---</li>` instead of an
      // `<hr>`, and a table directly under a list was absorbed the same way. Headings,
      // fences and quotes were already excluded — these two were the hole.
      while (
        i < lines.length &&
        /\S/.test(lines[i]) &&
        !LIST_ITEM.test(lines[i]) &&
        !/^#{1,6}\s/.test(lines[i]) &&
        !lines[i].startsWith("```") &&
        !/^\s*&gt;/.test(lines[i]) &&
        // a thematic break (the same predicate the block loop uses, so they agree)
        !/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
        /**
         * A `=====` fence line ends the item too.
         *
         * The harness wraps the goal in `=====` fences (`autoContinueNudge`), so a goal whose last
         * line is a bullet produced "- last item" followed by "=====". That `=` line is not a
         * thematic break and not a heading marker this renderer knows, so it was folded into the
         * item as text and rendered as "・ last item =====" — reported as "goalとかが箇条書きだった
         * ときに…実際に描画されるのは `・ last item =====`".
         *
         * Matched here as a block boundary rather than teaching the renderer setext headings: the
         * fences are decoration around a value, and turning a trailing `=====` into an <h1> would
         * be a worse rendering of the same input.
         */
        !/^ {0,3}={3,}\s*$/.test(lines[i]) &&
        // a table START: this line has a pipe and the NEXT is a separator row
        !(lines[i].includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1]))
      ) {
        body += " " + lines[i].trim();
        i++;
      }
      // nested list deeper-indented than this item?
      let sub = "";
      const n = lines[i]?.match(LIST_ITEM);
      if (n && indentOf(n[1]) > ind) sub = parseList(indentOf(n[1]));
      // task-list checkbox
      const task = body.match(/^\[( |x|X)\]\s+(.*)$/);
      const box = task
        ? `<input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""}> `
        : "";
      items.push(`<li>${box}${inline(task ? task[2] : body)}${sub}</li>`);
      // A BLANK line between items makes a LOOSE list — still one list. Without this the
      // list ended at the blank line and the next item started a second one, and (because
      // the blank line was then consumed as an empty paragraph) the FIRST item was lost
      // entirely: "- a\n\n- b" rendered as a single <ul> containing "b".
      //
      // Only skip the blanks when the next non-blank line is another item at this depth;
      // otherwise the list really has ended and the blank line belongs to what follows.
      let look = i;
      while (look < lines.length && !/\S/.test(lines[look])) look++;
      const nextItem = lines[look]?.match(LIST_ITEM);
      if (look > i && nextItem && indentOf(nextItem[1]) === ind && /^\d/.test(nextItem[2]) === ordered) {
        i = look;
      }
    }
    // `<ol start="N">` only when the list does not begin at 1 — the attribute is
    // redundant otherwise, and emitting it always would churn every ordered list.
    if (!ordered) return `<ul>${items.join("")}</ul>`;
    return start === 1
      ? `<ol>${items.join("")}</ol>`
      : `<ol start="${start}">${items.join("")}</ol>`;
  }

  function inline(s) {
    // protect code spans from further processing. The placeholder uses a
    // private-use char + sentinel pair; literal NULs in the source were a
    // collision (user text containing \u0000<digits>\u0000 swapped in another
    // span's HTML). escapeHtml keeps them, so strip before placeholdering.
    const codes = [];
    s = s.replace(/\u0000/g, "");
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(`<code>${c}</code>`);
      return `\ue000${codes.length - 1}\uE001`;
    });
    // LINKS AND IMAGES are placeholdered too, for the same reason as code spans: the
    // HTML they produce must not be re-scanned by the passes below.
    //
    // Measured: `[https://example.com](https://example.com)` produced
    //   <a href="…"><a href="…">https://example.com</a></a>
    // because the autolink pass ran afterwards and its lookbehind
    // `(?<!["'=\w])` accepts the `>` that ends `<a href="…">`. Nested <a> is invalid
    // HTML, so the browser closes the outer one early and the rest of the row's markup
    // lands outside it.
    //
    // Image first: `![x](url)` must not have its inner part claimed by the link rule.
    s = s.replace(
      /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,
      (_, alt, url) => {
        codes.push(`<img src="${url}" alt="${alt}" loading="lazy">`);
        return `\ue000${codes.length - 1}\uE001`;
      },
    );
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,
      (_, text, url) => {
        codes.push(`<a href="${url}" rel="noopener noreferrer" target="_blank">${text}</a>`);
        return `\ue000${codes.length - 1}\uE001`;
      },
    );
    // bare autolinks (skip anything already inside an attribute/text)
    s = s.replace(
      /(?<!["'=\w])(https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?"')\]])/g,
      '<a href="$1">$1</a>',
    );
    // emphasis — triple first, then bold, then italic; permissive about inner
    // spaces so half-written streaming text and "** spaced **" both work
    s = s.replace(/\*\*\*([\s\S]+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>");
    s = s.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([\s\S]+?)~~/g, "<del>$1</del>");
    // eslint-disable-next-line no-control-regex
    return s.replace(/\ue000(\d+)\ue001/g, (_, k) => codes[+k] ?? "");
  }
}

/**
 * Split a table row into cells.
 *
 * A pipe is a cell boundary only when it is NOT:
 *   - escaped as `\|` → a literal pipe, and
 *   - inside a CODE SPAN, where it is ordinary text.
 *
 * The code-span rule deliberately mirrors `inline()`'s `/`([^`]+)`/g exactly.
 * The two must agree, or a cell is split at a place the inline renderer treats
 * as code — which is how `| `N| ` gutter |` came out as four columns instead of
 * two, and how `` `a|b` `` lost its code formatting. GFM agrees: inside a code
 * span a pipe is content, and the only escape needed is `\|`.
 *
 * Note the escaped pipe is also suppressed INSIDE a span: `` `a\|b` `` is the
 * documented way to write a pipe in code, and the backslash there is the
 * author's, not markup.
 */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  const cells = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") {
      // a literal pipe, inside a span or out
      cur += "|";
      k++;
      continue;
    }
    if (ch === "`") {
      // Only enter a span if it actually CLOSES. `inline()` uses
      // /`([^`]+)`/g, so an unclosed backtick is literal text THERE — if we
      // treated it as a span here, this row would keep every pipe to its end
      // and merge columns the inline renderer does consider separate. A
      // half-open span is the exact disagreement this fix exists to remove,
      // so a span must be complete on BOTH ends before any pipe is
      // suppressed.
      const close = s.indexOf("`", k + 1);
      if (close !== -1) {
        // The span is copied so its pipes are not boundaries — but the ESCAPE must be
        // resolved inside it too. GFM renders `a\|b` in a code span as `a|b`, and
        // copying verbatim left the backslash visible (`<code>a\|b</code>`).
        cur += s.slice(k, close + 1).replace(/\\\|/g, "|");
        k = close;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "|" && k === s.length - 1) break; // trailing pipe
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells.filter((c, idx) => !(c === "" && idx === cells.length - 1 && s.endsWith("|")));
}

/** `| --- | :--: |` — the second row of a GFM table. */
function isSeparatorRow(line) {
  const s = line.trim();
  if (!s.includes("|") || !s.includes("-")) return false;
  const cells = splitRow(s);
  return cells.every((c) => /^:?-+:?$/.test(c)) && cells.some((c) => c !== "");
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
