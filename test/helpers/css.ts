
export function stripCssComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "");
}

function* rules(css: string): Generator<{ selector: string; body: string }> {
  let i = 0;
  for (;;) {
    const open = css.indexOf("{", i);
    if (open === -1) return;
    const prevClose = css.lastIndexOf("}", open);
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

export function cssRuleBody(
  css: string,
  selector: string,
  opts: { last?: boolean } = {},
): string {
  const last = opts.last !== false;
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

export function cssRuleBodies(css: string, selector: string): string[] {
  const want = selector.trim();
  const out: string[] = [];
  for (const r of rules(css)) {
    if (r.selector.split(",").some((part) => part.trim() === want)) out.push(r.body);
  }
  return out;
}

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
