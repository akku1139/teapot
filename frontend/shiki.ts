/**
 * shiki syntax highlighting for the workspace file preview.
 *
 * This module is itself lazily imported by App.tsx (dynamic `import("./shiki")`
 * on the first file preview), and the highlighter inside it is fine-grained
 * (`shiki/core` + the JS regex engine): grammars are dynamic-imported per
 * language on first use. Net effect: the initial vite bundle carries none of
 * shiki — core, themes, and grammars all load on demand.
 *
 * Teapot ships 10 themes across two appearance modes (html[data-appearance]).
 * Instead of re-highlighting on every theme switch, each snippet is
 * highlighted ONCE with both palettes via shiki's dual-theme mode
 * (`themes` + `defaultColor: false`): colors come out as --shiki-light /
 * --shiki-dark CSS variables and app.css selects the active set by appearance,
 * so dark/midnight/tea/coffee/matcha/matrix/sunset share github-dark and
 * light/strawberry/ramune share github-light.
 *
 * Large files (up to the API's 100 KB truncation) are tokenized in line
 * chunks, carrying the grammar state between chunks, and each rendered chunk
 * is yielded immediately — the UI stays interactive instead of freezing on a
 * multi-second full-file tokenize. Any failure (unknown language, broken
 * grammar, …) surfaces as an exception so the caller can fall back to plain.
 */
import { createHighlighterCore, hastToHtml } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { HighlighterCore } from "shiki";

/** dark teapot themes → github-dark · light teapot themes → github-light */
const THEMES = {
  light: "github-light",
  dark: "github-dark",
} as const;

/** lines tokenized per slice — small enough to keep frames responsive */
const CHUNK_LINES = 400;

/** extension → bundled shiki grammar id (kept to ids shipped in shiki/langs) */
const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx", tsx: "tsx",
  json: "json", jsonc: "jsonc", json5: "json5", map: "json",
  md: "markdown", mdx: "mdx", markdown: "markdown",
  css: "css", pcss: "css", postcss: "css",
  sass: "sass", scss: "scss", less: "less", styl: "stylus",
  html: "html", htm: "html", vue: "vue", svelte: "svelte", astro: "astro",
  py: "python", pyi: "python", rb: "ruby", rake: "ruby",
  rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", fs: "fsharp", swift: "swift", m: "objective-c",
  php: "php", scala: "scala", groovy: "groovy", dart: "dart",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "fish",
  ps1: "powershell", bat: "bat", cmd: "bat",
  yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml", svg: "xml",
  sql: "sql", graphql: "graphql", gql: "graphql", prisma: "prisma",
  lua: "lua", pl: "perl", pm: "perl", r: "r", jl: "julia",
  ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell",
  clj: "clojure", cljs: "clojure", edn: "clojure",
  vim: "vim", zig: "zig", nim: "nim", sol: "solidity",
  tf: "terraform", tfvars: "terraform", hcl: "hcl",
  diff: "diff", patch: "diff", lock: "yaml",
};

/** extension-less names worth highlighting (dotfiles, makefiles, …) */
const NAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile", makefile: "makefile",
  ".gitignore": "ini", ".gitattributes": "ini", ".editorconfig": "ini",
  ".npmrc": "ini", ".nvmrc": "ini", ".env": "ini",
  justfile: "justfile", "cmakelists.txt": "cmake",
};

/** bundled grammar loaders, resolved against shiki's export map (lazy) */
const LANG_IMPORTS: Record<string, () => Promise<unknown>> = {
  astro: () => import("shiki/langs/astro.mjs"),
  bat: () => import("shiki/langs/bat.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  clojure: () => import("shiki/langs/clojure.mjs"),
  cmake: () => import("shiki/langs/cmake.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  erlang: () => import("shiki/langs/erlang.mjs"),
  fish: () => import("shiki/langs/fish.mjs"),
  fsharp: () => import("shiki/langs/fsharp.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  groovy: () => import("shiki/langs/groovy.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  json5: () => import("shiki/langs/json5.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  julia: () => import("shiki/langs/julia.mjs"),
  justfile: () => import("shiki/langs/justfile.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  makefile: () => import("shiki/langs/makefile.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  nim: () => import("shiki/langs/nim.mjs"),
  "objective-c": () => import("shiki/langs/objective-c.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  postcss: () => import("shiki/langs/postcss.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  prisma: () => import("shiki/langs/prisma.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sass: () => import("shiki/langs/sass.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  solidity: () => import("shiki/langs/solidity.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  vim: () => import("shiki/langs/viml.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  stylus: () => import("shiki/langs/stylus.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
};

/** shiki core + both palettes, created once on first preview */
let corePromise: Promise<HighlighterCore> | null = null;
function core(): Promise<HighlighterCore> {
  corePromise ??= createHighlighterCore({
    themes: [
      import("shiki/themes/github-light.mjs"),
      import("shiki/themes/github-dark.mjs"),
    ],
    langs: [],
    // forgiving: unsupported regexp constructs degrade to warnings instead of
    // crashing a whole grammar
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return corePromise;
}

/** single-flight grammar loading (several previews may race) */
const langLoads = new Map<string, Promise<void>>();
function ensureLang(hl: HighlighterCore, lang: string): Promise<void> {
  let p = langLoads.get(lang);
  if (!p) {
    const load = LANG_IMPORTS[lang];
    p = load
      ? load().then((m) => hl.loadLanguage(m as never)).then(() => undefined)
      : Promise.reject(new Error(`no grammar loader for ${lang}`));
    p.catch(() => langLoads.delete(lang)); // allow a retry after a bad load
    langLoads.set(lang, p);
  }
  return p;
}

/** map a file path to a bundled grammar id — null → caller renders plain */
export function langForPath(path: string): string | null {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (NAME_LANG[name]) return NAME_LANG[name];
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return EXT_LANG[ext] ?? null;
}

/**
 * Highlight a file, yielding one rendered `<pre class="shiki">…</pre>` chunk
 * at a time (already dual-theme CSS-variable encoded). Returns without
 * yielding when the path has no grammar (caller falls back to plain).
 * Throws on grammar-load or render failures (ditto).
 */
export async function* highlightChunks(
  path: string,
  code: string,
): AsyncGenerator<string> {
  const lang = langForPath(path);
  if (!lang || !code.trim()) return;
  if (!LANG_IMPORTS[lang]) return;

  const hl = await core();
  await ensureLang(hl, lang);

  const lines = code.split("\n");
  let state: ReturnType<typeof hl.getLastGrammarState> | undefined;
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const slice = lines.slice(i, i + CHUNK_LINES).join("\n");
    const root = hl.codeToHast(slice, {
      lang,
      themes: THEMES,
      defaultColor: false, // emit --shiki-light/--shiki-dark vars only
      ...(state ? { grammarState: state } : {}),
    });
    // carry tokenization state across chunks (multi-line strings/comments,
    // embedded languages in markdown) — both palettes' stacks are kept
    state = hl.getLastGrammarState(root) ?? undefined;
    yield hastToHtml(root);
  }
}
