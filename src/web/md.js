/**
 * Tiny dependency-free Markdown renderer (plain ES module, no build step).
 * Strategy: escape ALL HTML first, then apply a small set of block/inline
 * rules on the escaped text. Output is XSS-safe because raw <,>,& in input
 * can never survive as markup.
 */
export function renderMarkdown(src) {
  const lines = escapeHtml(src.replace(/\r\n/g, "\n")).split("\n");
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
    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    // list (ul / ol)
    const isOl = /^\s*\d+[.)]\s+/.test(line);
    if (isOl || /^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*[-*]\s+(.*)$/) ?? (isOl ? lines[i].match(/^\s*\d+[.)]\s+(.*)$/) : null);
        if (!m) break;
        items.push(`<li>${inline(m[1])}</li>`);
        i++;
      }
      out.push(isOl ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
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
      !/^#{1,4}\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*([-*]|\d+[.)])\s/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, "$1<em>$2</em>")
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>',
      );
  }
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
