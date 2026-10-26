import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { renderMarkdown } from "../frontend/md.js";

function renderIsolated(src: string, timeoutMs = 5000): { ok: true; html: string } | { ok: false } {
  const script = `
    import { renderMarkdown } from ${JSON.stringify(new URL("../frontend/md.js", import.meta.url).href)};
    process.stdout.write(renderMarkdown(process.argv[1] ?? ""));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, src], {
    timeout: timeoutMs,
    encoding: "utf8",
  });
  if (r.error || r.status !== 0) return { ok: false };
  return { ok: true, html: r.stdout };
}

test("a line that is its own fence terminates", () => {
  for (const src of ["```js```", "```json```", "```bash```", "```ts```"]) {
    const r = renderIsolated(src);
    assert.ok(r.ok, `renderMarkdown(${JSON.stringify(src)}) must terminate (#29 audit)`);
  }
});

test("every degenerate backtick line terminates", () => {
  for (const src of ["`````````", "``` ``` ```", "```js```abc", "```", "``", "`", "``````"]) {
    const r = renderIsolated(src);
    assert.ok(r.ok, `renderMarkdown(${JSON.stringify(src)}) must terminate (#29 audit)`);
  }
});

test("the hang cannot come back through a streaming-shaped input", () => {
  const r = renderIsolated("here is an example:\n```js\nconst a = 1;\n```\nand ```json``` inline\n");
  assert.ok(r.ok, "a realistic mixed message must terminate (#29 audit)");
});

test("a normal fenced block is still a code block", () => {
  const r = renderIsolated("```js\nconst a = 1;\n```");
  assert.ok(r.ok);
  assert.match(r.ok ? r.html : "", /<pre><code class="language-js">const a = 1;<\/code><\/pre>/, "fences must survive (#29 audit)");
});

test("an unclosed fence still runs to EOF rather than hanging", () => {
  const r = renderIsolated("```js\nconst a = 1;");
  assert.ok(r.ok);
  assert.match(r.ok ? r.html : "", /<pre><code[^>]*>/, "unclosed fences are legal (#29 audit)");
});

test("inline code spans are unaffected", () => {
  const out = renderMarkdown("use `a | b` and `x`");
  assert.match(out, /<code>a \| b<\/code>/, "code spans still work (#29 audit)");
});
