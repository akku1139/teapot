/**
 * Session titles (#155) — "いろんなチャットアプリが実装してる、CodexやDSHとかも実装してそう /
 * 自動生成とかサブエージェント名とかだとわかりにくい".
 *
 * The sidebar renders the raw session id, so `teapot-10-16854917` and
 * `teapot-10-sub-trim-…` read as machinery: an operator with several sessions
 * cannot tell which is which, and the timeline in front of them is the only clue.
 *
 * ## Why the FIRST USER PROMPT, and not a model call
 *
 * Every harness that does this derives the title from the opening request — it is
 * already written by the human, it costs nothing, and it is stable (the first
 * message of a session never changes, so the title never churns under the reader).
 * A generated title would need an LLM call at exactly the moment the session starts,
 * and would then drift as the session's real subject emerges.
 *
 * ## This is a DISPLAY rule, so it is deliberately lossy
 *
 * The input is arbitrary operator text: markdown, fenced code, URLs, a pasted
 * 200-line log. A sidebar row is ~40 characters wide. So the rule takes the first
 * MEANINGFUL line and trims it, rather than trying to summarise — a title that
 * silently reorders what the operator wrote would be worse than a truncated one.
 */
export function sessionTitleFrom(firstUserPrompt: string | undefined | null): string | null {
  if (typeof firstUserPrompt !== "string") return null;
  const lines = firstUserPrompt.split("\n");
  // A fenced block is CONTENT, not a subject: the operator pasted a log or a diff
  // and the prose follows it. Taking the first line inside the fence titled a
  // session "log" (measured). So skip from an opening fence to its closing one.
  let inFence = false;
  let fence = "";
  for (const raw of lines) {
    const fenceOpen = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceOpen) {
      const marker = fenceOpen[1]!;
      if (!inFence) {
        inFence = true;
        fence = marker[0]!;
        continue;
      }
      if (marker[0] === fence) {
        inFence = false; // closing fence
        continue;
      }
    }
    if (inFence) continue; // inside a block: its body is not a title
    // strip the markdown that would otherwise eat the visible width: ATX headings,
    // bullets/ordered markers, blockquotes, and emphasis characters
    const line = raw
      .replace(/^\s{0,3}#{1,6}\s*/, "")
      .replace(/^\s{0,3}>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/[*_`~]/g, "")
      .trim();
    if (!line) continue;
    // a bare URL or a lone issue/PR reference carries no subject — the NEXT line
    // usually does (a prompt may OPEN with "https://…" or a lone "2.")
    if (/^https?:\/\/\S+$/.test(line)) continue;
    if (/^#?\d+[.)]?$/.test(line)) continue;
    return clip(line, 60);
  }
  return null;
}

/** Trim to `max` characters on a word boundary, with an ellipsis when cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  // prefer the last space so a word is not sliced in half; fall back to a hard cut
  // when the line has no space at all (a single long token / CJK run)
  const at = cut.lastIndexOf(" ");
  const body = at > max * 0.6 ? cut.slice(0, at) : cut;
  return `${body.trimEnd()}…`;
}
