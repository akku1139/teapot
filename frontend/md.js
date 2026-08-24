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
    // fenced code block
    if (/^```\w*\s*$/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
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
      out.push(
        `<div class="tbl"><table><thead><tr>${head.map((c, k) => cell(c, k, "th")).join("")}</tr></thead>` +
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
    // protect code spans from further processing
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(`<code>${c}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
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
    return s.replace(/\u0000(\d+)\u0000/g, (_, k) => codes[+k]);
  }
}

/** Split a table row on unescaped pipes; `\|` becomes a literal pipe. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  const cells = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
      continue;
    }
    if (s[k] === "|" && k === s.length - 1) break; // trailing pipe
    if (s[k] === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += s[k];
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
