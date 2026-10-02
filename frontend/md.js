/**
 * Tiny dependency-free Markdown renderer (plain ES module, no build step).
 * Strategy: escape ALL HTML first, then apply a small set of block/inline
 * rules on the escaped text. Output is XSS-safe because raw <,>,& in input
 * can never survive as markup.
 *
 * Blocks: fenced code · headings #–###### · ul/ol incl. one-level nesting &
 * task items · GFM pipe tables (alignment, escaped pipes) · blockquotes ·
 * horizontal rules · paragraphs.
 * Inline: code spans (protected), images, links, bare autolinks, ***bold-
 * italic***, **bold**, __bold__, *em*, _em_, ~~strike~~.
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
    if (/^```[^\n]*$/.test(line) && !/^```.+\`\`\`/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence (may be missing — unclosed fence just runs to EOF)
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
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
    const items = [];
    while (i < lines.length) {
      const m = lines[i].match(LIST_ITEM);
      if (!m) break;
      const ind = indentOf(m[1]);
      if (ind < minIndent) break;
      const ol = /^\d/.test(m[2]);
      if (ordered === null) ordered = ol;
      else if (ol !== ordered) break; // marker type changed → close this list
      i++;
      let body = m[3];
      // folded continuation lines (wrapped text belonging to this item)
      while (
        i < lines.length &&
        /\S/.test(lines[i]) &&
        !LIST_ITEM.test(lines[i]) &&
        !/^#{1,6}\s/.test(lines[i]) &&
!lines[i].startsWith("```") &&
        !/^\s*&gt;/.test(lines[i])
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
    }
    return ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`;
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
    // images before links
    s = s.replace(
      /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,
      '<img src="$2" alt="$1" loading="lazy">',
    );
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,
      '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>',
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
        cur += s.slice(k, close + 1); // the span verbatim, pipes included
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
