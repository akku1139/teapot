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
