/**
 * Comment stripper for this repo's TS/TSX.
 *
 * WHY a hand-written scanner rather than a parser: `typescript` is not a dependency of this package
 * (it is not installed under node_modules), and the job needs exactly one thing — comment ranges —
 * while correctly skipping strings, templates and REGEX literals, which a naive `//` search corrupts.
 *
 * WHY the JSX awareness: inside JSX TEXT, `//` and `/*` are literal characters the operator sees on
 * screen, not comments. A scanner that does not know when it is inside JSX text silently deletes
 * renderable content — the exact failure that made the earlier "comment-stripping scripts destroyed
 * code" note in AGENTS.md.
 */
export function findComments(src, { jsx = false } = {}) {
  const out = [];
  let i = 0;
  const n = src.length;
  let mode = "code";
  /** `}` depth that returns us to the enclosing template (one frame per `${`) */
  const tplDepth = [];
  let brace = 0;
  /** nesting depth of JSX expression containers, so closing one returns to JSX TEXT */
  /** each entry remembers where the expression container returns to: JSX text or a tag's attributes */
  const jsxCtx = [];
  /** JSX depth: > 0 means we are inside a tag's attributes (JSX context) */
  let jsxTag = 0;
  /** true while between `>` and the next `<` in JSX children — TEXT, not code */
  let jsxText = false;
  const prevSig = (at) => {
    for (let k = at - 1; k >= 0; k--) {
      const ch = src[k];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
      return ch;
    }
    return "";
  };
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (mode === "code") {
      if (jsxText) {
        if (c === "<") { jsxText = false; jsxTag = 1; i++; continue; }
        /**
         * `{` in JSX CHILDREN starts an expression container, which is ordinary code — that is how
         * `{/* … *\/}` (a real comment) and `{foo}` (a real expression) both appear. Without this,
         * every JSX comment was missed, and the earlier naive scripts deleted the wrong spans.
         */
        if (c === "{") { jsxText = false; brace++; jsxCtx.push({ depth: brace, back: "text" }); i++; continue; }
        i++; continue;
      }
      if (c === "{") { brace++; i++; continue; }
      if (c === "}") {
        /**
         * Closing a `${ … }` returns to the TEMPLATE, and must RESTORE the brace count.
         *
         * The old line popped the saved depth but left `brace` at 0 instead of restoring it, so every
         * `}` after a template interpolation was counted one level too shallow. MEASURED: the JSX
         * expression container in `App.tsx` then never closed, the scanner stayed in JSX-TEXT for the
         * rest of the file, and 34 comment lines survived a strip that otherwise removed 26k.
         */
        if (tplDepth.length && brace === 0) { brace = tplDepth.pop(); mode = "tpl"; i++; continue; }
        // closing a JSX expression container returns us to JSX CHILDREN
        if (jsxCtx.length && brace === jsxCtx[jsxCtx.length - 1].depth) {
          const frame = jsxCtx.pop();
          brace--;
          if (jsx) {
            /**
             * Return to WHERE the container was opened.
             *
             * A `{…}` in JSX children returns to CHILDREN (text). One inside a tag — `style={…}` —
             * returns to the TAG's attributes, where the next thing is `>` or another attribute, not
             * text. Sending it to text made the scanner miss the tag's `>`, so it never re-entered
             * code and every following comment was skipped.
             */
            if (frame.back === "tag") { jsxTag = 1; jsxText = false; }
            else jsxText = true;
          }
          i++;
          continue;
        }
        brace--; i++; continue;
      }
      if (c === "/" && c2 === "/") { const s = i; i += 2; while (i < n && src[i] !== "\n") i++; out.push({ s, e: i, kind: "line" }); continue; }
      if (c === "/" && c2 === "*") { const s = i; i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i = Math.min(i + 2, n); out.push({ s, e: i, kind: "block" }); continue; }
      if (c === "'") { mode = "sq"; i++; continue; }
      if (c === '"') { mode = "dq"; i++; continue; }
      if (c === "`") { mode = "tpl"; i++; continue; }
      if (jsx) {
        if (jsxTag > 0) {
          if (c === ">") { jsxTag = 0; jsxText = true; i++; continue; }
          if (c === "{") { jsxTag = 0; jsxText = false; brace++; jsxCtx.push({ depth: brace, back: "text" }); i++; continue; } // expression container = code
          // a tag is also where TEMPLATES and STRINGS appear (`style={x ? \`a\` : ""}`): those modes
          // exit back to code, and the `}` closing the container must still be counted — which it
          // is, because the container path above already pushed the brace depth
          i++; continue;
        }
        /**
         * Entering a JSX tag, and ONLY a JSX tag.
         *
         * `<string, string>()` is a generic type argument list, not an element — treating it as one
         * put the scanner inside "a tag" that never closes, after which NO comment was found for the
         * rest of the file. MEASURED on `App.tsx`: 1 comment detected in the whole file, so a strip
         * pass left 1,094 comment lines behind.
         *
         * A tag is `<` followed by a letter or `>`, AND the previous significant character must not
         * be an identifier/`)`/`]` — those mean type arguments or a comparison.
         */
        if (c === "<" && /[A-Za-z>]/.test(c2 ?? "")) {
          let k = i - 1;
          while (k >= 0 && /\s/.test(src[k])) k--;
          const before = k >= 0 ? src[k] : "";
          // `Map<string, string>` / `foo<T>()` / `a < b` are not tags
          const typeLike = /[\w$)\]>]/.test(before);
          const comparison = /[\w$)\]]/.test(before) && /[\s]/.test(src[k + 1] ?? "");
          if (!typeLike && !comparison) { jsxTag = 1; i++; continue; }
        }
      }
      if (c === "/") {
        /**
         * REGEX or division?
         *
         * A `/` starts a regex when it begins an EXPRESSION: after `(`, `=`, `,`, `return`, etc. The
         * first version of this compared the last 12 characters against `/return$/` — which fails
         * when a SPACE follows the keyword (`return /^https?:\/\//`), and MEASURED that made the
         * stripper treat the `//` inside the pattern as a comment, truncating the source into an
         * unterminated-regex syntax error. Scanning back over whitespace first is the fix.
         */
        let k = i - 1;
        while (k >= 0 && /\s/.test(src[k])) k--;
        const prev = k >= 0 ? src[k] : "";
        const word = /([A-Za-z_$][\w$]*)$/.exec(src.slice(Math.max(0, k - 10), k + 1))?.[1] ?? "";
        const keywordBefore = /^(return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await)$/.test(word);
        if (prev === "" || /[=(,:[!&|?{};+\-*%<>~^]/.test(prev) || keywordBefore) {
          mode = "re"; i++; continue;
        }
      }
      i++; continue;
    }
    if (mode === "sq") { if (c === "\\") { i += 2; continue; } if (c === "'") mode = "code"; i++; continue; }
    if (mode === "dq") { if (c === "\\") { i += 2; continue; } if (c === '"') mode = "code"; i++; continue; }
    if (mode === "tpl") { if (c === "\\") { i += 2; continue; } if (c === "`") { mode = "code"; i++; continue; } if (c === "$" && c2 === "{") { tplDepth.push(brace); brace = 0; mode = "code"; i += 2; continue; } i++; continue; }
    if (mode === "re") { if (c === "\\") { i += 2; continue; } if (c === "/") { mode = "code"; i++; continue; } if (c === "\n") { mode = "code"; i++; continue; } i++; continue; }
  }
  return out;
}

const KEEP = /@ts-(expect-error|ignore|nocheck)|eslint-disable|oxlint-disable|@__PURE__|@vite-ignore|prettier-ignore|istanbul ignore/;

/** remove every comment except a DIRECTIVE (those change compilation behaviour) */
export function stripComments(src, opts = {}) {
  const comments = findComments(src, opts);
  let out = "";
  let at = 0;
  for (const c of comments) {
    const text = src.slice(c.s, c.e);
    if (KEEP.test(text)) continue; // keep the directive, and everything before it
    out += src.slice(at, c.s);
    // a BLOCK comment on its own line leaves its indentation behind: drop the whole line
    if (c.kind === "block" && /^[ \t]*$/.test(src.slice(src.lastIndexOf("\n", c.s - 1) + 1, c.s)) && src[c.e] === "\n") {
      out = out.replace(/[ \t]*$/, "");
      at = c.e + 1;
      // also swallow a run of blank lines this leaves behind
      while (src[at] === "\n" && src[at + 1] === "\n") at++;
      continue;
    }
    if (c.kind === "line" && /^[ \t]*$/.test(src.slice(src.lastIndexOf("\n", c.s - 1) + 1, c.s)) && src[c.e] === "\n") {
      out = out.replace(/[ \t]*$/, "");
      at = c.e + 1;
      while (src[at] === "\n" && src[at + 1] === "\n") at++;
      continue;
    }
    at = c.e;
  }
  out += src.slice(at);
  return out.replace(/\n{3,}/g, "\n\n");
}

/**
 * JSX comment blocks: `{/* … *\/}`.
 *
 * The lexer handles these when it tracks JSX correctly, but a handful of shapes (a template inside
 * an attribute inside a conditional) still desync it — MEASURED: 35 of 1,295 `//` lines survived in
 * `App.tsx`. JSX comments are DELIMITED, so a regex is exact here in a way it is not for line
 * comments: the opening `{/*` and the closing `*\/}` cannot appear in a string literal that is
 * already part of the JSX (a `*\/}` inside a string would have to be escaped, and then it is not
 * this sequence).
 *
 * Deliberately applied AFTER the lexer, and only to `.tsx`: on `.ts` there is no JSX, and `{/*`
 * would be an object literal with a division.
 */
export function stripJsxComments(src) {
  return src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, (m) => (/@ts-|eslint-|oxlint-|@__PURE__|@vite-ignore/.test(m) ? m : ""));
}

/**
 * Files this stripper must NEVER be pointed at.
 *
 * Tests keep their comments on purpose: a test's comment says WHY the case exists (which report it
 * reproduces, what the fixture is standing in for), and that reasoning is not derivable from the
 * assertions. The operator restored them after the purge for exactly that reason.
 *
 * Exported so a caller has no excuse to re-derive the rule, and applied by `stripTree` below.
 */
export const COMMENT_KEEP_DIRS = ["test/", "__tests__/", "tests/"];

export function isProtectedFromStripping(relPath) {
  const p = String(relPath).replace(/\\/g, "/");
  return COMMENT_KEEP_DIRS.some((d) => p.startsWith(d) || p.includes(`/${d}`))
    || /\.test\.[tj]sx?$/.test(p)
    || /\.spec\.[tj]sx?$/.test(p);
}

/** strip every non-test file under the given roots; returns what changed, never writes tests */
export function stripTree(roots, io) {
  const fs = io.fs;
  const path = io.path;
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir)) {
      if (["node_modules", "public", ".git", "dist"].includes(e) || e.startsWith(".")) continue;
      const p = path.join(dir, e);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e)) files.push(p);
    }
  };
  for (const d of roots) walk(d);
  const changed = [];
  for (const f of files) {
    if (isProtectedFromStripping(f)) continue;
    if (f.endsWith("strip-comments.mjs")) continue;
    const src = fs.readFileSync(f, "utf8");
    let out = stripComments(src, { jsx: f.endsWith(".tsx") });
    if (f.endsWith(".tsx")) out = stripJsxComments(out);
    if (out !== src) {
      fs.writeFileSync(f, out);
      changed.push(f);
    }
  }
  return changed;
}
