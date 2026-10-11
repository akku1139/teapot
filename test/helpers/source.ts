/**
 * Read a source file for a structural assertion, with line endings NORMALISED.
 *
 * #126: a dozen tests anchor on source text, and several used a literal `"\n"` to
 * find a block boundary. Git checks out CRLF on Windows, so every one of those
 * anchors missed there while passing on Linux — the Windows CI caught it on
 * `subagent-title-name.test.ts`, which was the THIRD occurrence of this exact
 * mistake in this project (after the `/home/dev` expectations and the CRLF search
 * in `stop-with-pending`).
 *
 * The fix is here rather than in each test: `readSource()` returns LF text
 * whatever the checkout used, so an anchor written as `"\n  });"` behaves
 * identically on both platforms. A test only needs this when it searches source;
 * tests that assert on runtime behaviour never read the file at all.
 */
import { readFileSync } from "node:fs";

export function readSource(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/**
 * Remove line and block comments from SOURCE, leaving string literals intact.
 *
 * A structural assertion that searches raw source can be satisfied by an
 * EXPLANATORY COMMENT rather than by code. That is not hypothetical here: two
 * tests asserted the `kind === "event"` branch reaches `runFeedRefresh`, and the
 * only match inside that branch was the comment `await refreshAgents() // the
 * agent's live STATUS`. Rewording the prose turned both red while the code was
 * unchanged — the same shape as #75, where a declaration quoted in a comment
 * satisfied the assertion that was supposed to prove the declaration existed.
 *
 * So: assert on stripped source, and the failure mode cannot come back.
 */
export function stripSourceComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      // line comment: drop through the newline (kept, so line offsets hold)
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      // block comment: drop it, but keep its newlines so line numbers survive
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
