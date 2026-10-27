import { createHighlighterCore, hastToHtml } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { HighlighterCore } from "shiki";

const THEMES = {
  light: "github-light",
  dark: "github-dark",
} as const;

const CHUNK_LINES = 400;

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

const NAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile", makefile: "makefile",
  ".gitignore": "ini", ".gitattributes": "ini", ".editorconfig": "ini",
  ".npmrc": "ini", ".nvmrc": "ini", ".env": "ini",
  justfile: "justfile", "cmakelists.txt": "cmake",
};

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

let corePromise: Promise<HighlighterCore> | null = null;
function core(): Promise<HighlighterCore> {
  corePromise ??= createHighlighterCore({
    themes: [
      import("shiki/themes/github-light.mjs"),
      import("shiki/themes/github-dark.mjs"),
    ],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return corePromise;
}

const langLoads = new Map<string, Promise<void>>();
function ensureLang(hl: HighlighterCore, lang: string): Promise<void> {
  let p = langLoads.get(lang);
  if (!p) {
    const load = LANG_IMPORTS[lang];
    p = load
      ? load().then((m) => hl.loadLanguage(m as never)).then(() => undefined)
      : Promise.reject(new Error(`no grammar loader for ${lang}`));
    p.catch(() => langLoads.delete(lang)); 
    langLoads.set(lang, p);
  }
  return p;
}

export function langForPath(path: string): string | null {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (NAME_LANG[name]) return NAME_LANG[name];
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return EXT_LANG[ext] ?? null;
}

export async function* highlightChunks(
  path: string,
  code: string,
): AsyncGenerator<string> {
  const lang = langForPath(path);
  if (!lang || !code.trim()) return;
  if (!LANG_IMPORTS[lang]) return;
  yield* highlightLangChunks(lang, code);
}

/**
 * shiki's own settings already keep the background off the wire.
 *
 * With `defaultColor: false` and dual `themes`, `codeToHast` emits **no** `background-color` — only the
 * CSS variables `--shiki-light-bg` / `--shiki-dark-bg` (MEASURED on the generated `<pre>`). So there is
 * nothing to strip here, and no stylesheet needs an `!important` to undo it: whatever surface the block
 * sits on shows through, and each container decides for itself whether it HAS one.
 *
 * (An earlier attempt added a HAST pass to remove a background that this configuration never produces,
 * and a `.shikiwrap … { background-color: transparent !important }` rule that existed only to undo it.
 * The operator's instinct — "shiki自体の設定で無効化できない?" — was right, and it was already done.)
 */

export async function* highlightLangChunks(
  lang: string,
  code: string,
): AsyncGenerator<string> {
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
      defaultColor: false, 
      ...(state ? { grammarState: state } : {}),
    });
    state = hl.getLastGrammarState(root) ?? undefined;
    yield hastToHtml(root);
  }
}
