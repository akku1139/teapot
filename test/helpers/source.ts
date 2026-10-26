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
import { fileURLToPath } from "node:url";

/**
 * Read a SOURCE file next to a test, given a `new URL(..., import.meta.url)`.
 *
 * Use this instead of building a path from a URL's `pathname` property, which is a
 * URL path and not a filesystem path: on Windows it yields
 * `/D:/a/teapot/src/agent/agent.ts`, and handing that to `readFileSync` makes Node
 * treat it as a RELATIVE path with a drive letter in it, searching
 * `D:\D:\a\teapot\...`. Nine files did exactly that, and every one of them failed
 * on the Windows runner only — which is the platform where nobody can iterate.
 *
 * `fileURLToPath` performs the conversion correctly on both platforms, and taking
 * the URL (not a string) means the mistake cannot be written here at all.
 */
export function readSourceUrl(url: URL): string {
  return readSource(fileURLToPath(url));
}

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
 *
 * REGEX LITERALS must be skipped too. Without that, `/^https?:\/\//` ends with an
 * escaped slash followed by the closing slash — two adjacent `/` — and the
 * stripper mistakes it for a line comment, swallowing the rest of the line. Worse
 * than a bad match: it can silently truncate the code a test is asserting about,
 * which is the same class of false confidence this helper exists to remove.
 * (Caught by running the stripper across all of `src/` and `frontend/`: 36 files
 * stripped, one threw a syntax error.)
 */
export function stripSourceComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  /** the last non-space character emitted, used to tell `/` division from a regex */
  const lastMeaningful = (): string => {
    for (let j = out.length - 1; j >= 0; j--) {
      const ch = out[j]!;
      if (!/\s/.test(ch)) return ch;
    }
    return "";
  };
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
    // a `/` opening a REGEX literal, rather than commenting or dividing:
    // it follows an operator/opening bracket/keyword position, and `/` followed
    // by `=` or another `/` is division/comment, never a regex
    if (c === "/" && n !== "/" && n !== "=" && n !== "*" && regexCanStartAfter(lastMeaningful())) {
      out += c;
      i++;
      // copy the literal verbatim, honouring escapes and `[...]` classes (a `/`
      // inside a class does not close the literal)
      let inClass = false;
      while (i < src.length) {
        const r = src[i]!;
        if (r === "\\") {
          out += r + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += r;
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) {
          i++;
          break;
        } else if (r === "\n") {
          break; // unterminated — treat as division after all, stop cleanly
        }
        i++;
      }
      // flags
      while (i < src.length && /[a-z]/.test(src[i]!)) {
        out += src[i]!;
        i++;
      }
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

/**
 * Can a regex literal start here, given the last meaningful character emitted?
 *
 * Standard heuristic: yes after an operator, an opening bracket, a comma, or a
 * keyword — no after an identifier, a closing bracket, or a literal (where `/`
 * means division).
 */
function regexCanStartAfter(prev: string): boolean {
  if (!prev) return true; // start of file
  return "(,=:[!&|?{};+-*%^~<>".includes(prev) || prev === "\n";
}

/**
 * The source from `anchor` to the end of the block it starts.
 *
 * A fixed-width window (`slice(at, at + 400)`) is a GUESS about how long the code will
 * be, and it fails as prose grows: #126 and #130 recorded the trap twice, then #152 hit
 * it a third time in different files — a comment added to `isLive()` pushed an asserted
 * clause past a 1600-char window on Windows (CRLF makes the block longer) while Linux
 * stayed green.
 *
 * Walking to the matching close brace removes the guess: the window is exactly the
 * construct under test, however it is written or formatted. Falls back to `fallback`
 * characters when no brace is found, so a test still gets a bounded slice rather than
 * the whole file.
 */
export function blockFrom(src: string, anchor: string, fallback = 2000): string {
  const at = src.indexOf(anchor);
  if (at === -1) return "";
  // Only walk braces when the anchor actually OPENS a block. An anchor can be a plain
  // expression (e.g. `const off = isChat`), and then the next `{` belongs to some later
  // construct — walking it would silently return the wrong region, which is how a
  // mechanical conversion of these slices broke three tests.
  const lineEnd = src.indexOf("\n", at);
  const segment = src.slice(at, lineEnd === -1 ? src.length : lineEnd);
  if (!segment.includes("{")) {
    // not a block opener: take enough lines for a multi-line expression, stopping at
    // the first blank line so neighbouring constructs are not swept in
    const rest = src.slice(at, at + fallback);
    const stop = rest.search(/\n\s*\n/);
    return stop === -1 ? rest : rest.slice(0, stop);
  }
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return src.slice(at, at + fallback);
}
