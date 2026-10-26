/**
 * CSS-aware helpers for tests that assert on the stylesheet.
 *
 * #75: two test files asserted a rule body WITHOUT stripping comments, and the
 * declarations they checked were quoted verbatim in those same rules' explanatory
 * comments. So commenting out an entire UI fix — the declarations made inert —
 * still satisfied the assertions, and the full suite stayed green. Both were
 * proven survivors by mutation testing, not suspected.
 *
 * The fix is not "remember to strip comments" in each file; it is one helper
 * every CSS test shares, so a future file gets it by importing rather than by
 * remembering. The lesson generalises past CSS: an assertion over a string that
 * CONTAINS the thing it is looking for will match its own documentation.
 */

/** Remove `/* … *\/` comments from a CSS fragment. */
export function stripCssComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every selector in a stylesheet, in source order. */
function* rules(css: string): Generator<{ selector: string; body: string }> {
  let i = 0;
  for (;;) {
    const open = css.indexOf("{", i);
    if (open === -1) return;
    const prevClose = css.lastIndexOf("}", open);
    // the selector may itself contain a comment (a comment between rules is
    // consumed by the PREVIOUS body's brace walk), so strip before matching
    const selector = css
      .slice(prevClose === -1 ? 0 : prevClose + 1, open)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    let depth = 0;
    let close = -1;
    for (let j = open; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close === -1) return;
    yield { selector, body: stripCssComments(css.slice(open + 1, close)) };
    i = close + 1;
  }
}

/**
 * Body of the rule whose selector list contains `selector` EXACTLY as one entry.
 *
 * Exact rather than substring so `.composer.maximized form` does not match a
 * later rule that merely mentions it in a selector list — which is its own way
 * of asserting on the wrong declaration.
 *
 * `last: true` (the default) takes the LAST match, because a fix appended after
 * an earlier declaration is the one in force.
 */
export function cssRuleBody(
  css: string,
  selector: string,
  opts: { last?: boolean } = {},
): string {
  const last = opts.last !== false;
  // the REQUEST is trimmed too: several callers pass `".agent-item "` copied from
  // a selector list, and rejecting that would push them back to an ad-hoc scanner
  const want = selector.trim();
  let found: string | null = null;
  for (const r of rules(css)) {
    if (r.selector.split(",").some((part) => part.trim() === want)) {
      if (found === null || last) found = r.body;
      if (!last) return found;
    }
  }
  if (found === null) throw new Error(`no rule whose selector is exactly ${JSON.stringify(want)}`);
  return found;
}

/** All rule bodies whose selector list contains `selector` as one entry. */
export function cssRuleBodies(css: string, selector: string): string[] {
  const want = selector.trim();
  const out: string[] = [];
  for (const r of rules(css)) {
    if (r.selector.split(",").some((part) => part.trim() === want)) out.push(r.body);
  }
  return out;
}

/**
 * Fail if `needle` appears ONLY inside a CSS comment.
 *
 * The direct statement of the #75 failure mode: a declaration that lives solely
 * in prose is not a declaration.
 */
export function assertNotOnlyInComment(css: string, needle: string, label: string): void {
  const withComments = css.includes(needle);
  const withoutComments = stripCssComments(css).includes(needle);
  if (withComments && !withoutComments) {
    throw new Error(
      `${label}: ${JSON.stringify(needle)} appears ONLY inside a CSS comment, so asserting ` +
        `on it proves nothing — the declaration is absent (#75)`,
    );
  }
}
