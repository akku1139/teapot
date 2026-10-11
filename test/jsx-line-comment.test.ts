/**
 * A `//` line comment sitting in JSX CHILDREN position is not a comment — it is
 * JSX text, and it renders literally on the page.
 *
 * This shipped: the #146 explanation for the live-bubble gate was written
 * between `</For>` and `<Show>`, so the timeline ended with a paragraph of
 * source code in a human's feed, and it stayed there for every session.
 *
 * `{/* … *\/}` is the form that is actually a comment, so the guard parses the
 * file and looks for JSXText, which is exactly what the compiler makes of the
 * wrong form — a text-position comment and an indented one inside a `{ }`
 * expression differ only by context, which a pattern match cannot see.
 *
 * Parsing goes through `vite`'s `parseAst` (the same oxc parser the build
 * uses). `typescript` cannot do it here: the TypeScript 7 native port this
 * project depends on no longer exports `createSourceFile` from its main entry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.join(root, "frontend");

/** every JSX text node that would print a `//` line on screen */
function renderedLineComments(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.type !== "Program" && node.type === "JSXText" && String(node.value).includes("//")) {
      // a JSXText node starts where the PREVIOUS sibling ended, so its own
      // leading whitespace is inside it — the reported line must be the line
      // the comment actually opens on, not the one above it
      const lines = String(node.value).split("\n");
      const at = lines.findIndex((l: string) => l.trim().length > 0);
      const lead = lines.slice(0, at).reduce((n: number, l: string) => n + l.length + 1, 0) +
        (lines[at]?.length ?? 0) - (lines[at]?.trimStart().length ?? 0);
      const line = source.slice(0, node.start + lead).split("\n").length;
      out.push({ line, text: String(node.value).trim().replace(/\s+/g, " ").slice(0, 70) });
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
    void node.type;
  };
  walk(parseAst(source, { lang: "tsx" }));
  return out;
}

test("no `//` comment is left in JSX text position (#146)", () => {
  const files = readdirSync(frontend).filter((f) => f.endsWith(".tsx"));
  assert.ok(files.length > 0, "there must be a .tsx file to check");
  const bad: string[] = [];
  for (const f of files) {
    for (const hit of renderedLineComments(readFileSync(path.join(frontend, f), "utf8"))) {
      bad.push(`${f}:${hit.line} renders as text: ${hit.text}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    "a `//` comment in JSX children prints on the timeline — wrap it in `{/* … */}`:\n" + bad.join("\n"),
  );
});

test("the guard fires on the shape it is meant to catch", () => {
  // the check above is only worth anything if it can fail — the exact snippet
  // that shipped, with the comment between two elements
  const sample = `export const A = () => (
  <div>
    <For each={[]}>{(x) => <span>{x}</span>}</For>
    // #146: the bubble must belong to the DISPLAYED session.
    <Show when={true}>ok</Show>
  </div>
);`;
  const hits = renderedLineComments(sample);
  assert.equal(hits.length, 1, `expected the rendered comment to be detected: ${JSON.stringify(hits)}`);
  assert.equal(hits[0]!.line, 4, `the reported line must be the comment's: ${JSON.stringify(hits[0])}`);

  // and it must NOT fire on the correct form, nor on an ordinary code comment
  const ok = `// a real comment, outside JSX
export const B = () => (
  <div>
    {/* a JSX comment */}
    <span>ok</span>
  </div>
);`;
  assert.deepEqual(renderedLineComments(ok), []);
});
