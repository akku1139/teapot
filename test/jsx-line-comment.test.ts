import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.join(root, "frontend");

function renderedLineComments(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const looksLikeComment = (v: string): boolean => {
    const t = v.trim();
    return t.includes("//") || t.startsWith("/*") || t.includes("\n *");
  };
  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.type !== "Program" && node.type === "JSXText" && looksLikeComment(String(node.value))) {
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

  const ok = `// a real comment, outside JSX
export const B = () => (
  <div>
    {/* a JSX comment */}
    <span>ok</span>
  </div>
);`;
  assert.deepEqual(renderedLineComments(ok), []);
});

test("the guard also catches a bare `/** … */` block in JSX text position (#146)", () => {
  const sample = `export const A = () => (
  <div>
    <Show when={true}>a</Show>
    /**
     * a block comment in children position
     */
    <Show when={true}>ok</Show>
  </div>
);`;
  const hits = renderedLineComments(sample);
  assert.ok(
    hits.length > 0,
    "a bare block comment between elements renders as text and must be reported",
  );

  const good = sample.replace("    /**", "    {/**").replace("     */", "     */}");
  assert.equal(renderedLineComments(good).length, 0, "`{/* … */}` is a real comment");
});
