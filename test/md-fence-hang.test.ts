/**
 * `renderMarkdown` must ALWAYS terminate.
 *
 * Found in a full-codebase review: a single line could wedge the renderer — and
 * therefore the browser tab — forever.
 *
 * The fence branch declines a line that contains its own closing fence
 * (`!  /^```.+\`\`\`/`), but the paragraph loop then declines it too, because it
 * starts with ``` and no paragraph is allowed to. Every branch had refused it,
 * `i` never advanced, and the outer `while` re-read the same line indefinitely
 * while pushing one empty `<p>` per spin — an unbounded array as well as a
 * hang.
 *
 * This is reachable from ordinary model output, not a contrived edge: an
 * assistant reply that types an inline fence mid-sentence (```js```) hits it,
 * and the LIVE STREAMING bubble re-renders on every delta — so it fires while
 * the user is still watching the text arrive.
 *
 * The contract these tests pin: every line is consumed, whatever it looks like.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { renderMarkdown } from "../frontend/md.js";

/** render in a child process so a regression cannot hang the test runner */
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

/* ---------- the hang ---------- */

test("a line that is its own fence terminates", () => {
  // The minimal trigger. Before the fix this never returned.
  for (const src of ["```js```", "```json```", "```bash```", "```ts```"]) {
    const r = renderIsolated(src);
    assert.ok(r.ok, `renderMarkdown(${JSON.stringify(src)}) must terminate (#29 audit)`);
  }
});

test("every degenerate backtick line terminates", () => {
  // Each of these matches the fence guard AND the paragraph guard, or neither.
  for (const src of ["`````````", "``` ``` ```", "```js```abc", "```", "``", "`", "``````"]) {
    const r = renderIsolated(src);
    assert.ok(r.ok, `renderMarkdown(${JSON.stringify(src)}) must terminate (#29 audit)`);
  }
});

test("the hang cannot come back through a streaming-shaped input", () => {
  // The live bubble appends a cursor character and re-renders per delta.
  const r = renderIsolated("here is an example:\n```js\nconst a = 1;\n```\nand ```json``` inline\n");
  assert.ok(r.ok, "a realistic mixed message must terminate (#29 audit)");
});

/* ---------- and the fix must not break real fences ---------- */

test("a normal fenced block is still a code block", () => {
  const r = renderIsolated("```js\nconst a = 1;\n```");
  assert.ok(r.ok);
  assert.match(r.ok ? r.html : "", /<pre><code>const a = 1;<\/code><\/pre>/, "fences must survive (#29 audit)");
});

test("an unclosed fence still runs to EOF rather than hanging", () => {
  const r = renderIsolated("```js\nconst a = 1;");
  assert.ok(r.ok);
  assert.match(r.ok ? r.html : "", /<pre><code>/, "unclosed fences are legal (#29 audit)");
});

test("inline code spans are unaffected", () => {
  const out = renderMarkdown("use `a | b` and `x`");
  assert.match(out, /<code>a \| b<\/code>/, "code spans still work (#29 audit)");
});
