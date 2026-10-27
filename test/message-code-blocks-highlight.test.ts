import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser } from "happy-dom";
import { renderMarkdown } from "../frontend/md.js";
import { highlightMessageCode } from "../frontend/lib/highlight-message.ts";

/**
 * Fenced code in a MESSAGE gets the same shiki treatment as a tool row.
 *
 * Asked for as "メッセージ内のコードブロックってshiki効かせないの?" with ```c and ```src/index.ts
 * examples. `md.js` emitted `<pre><code class="language-x">` and nothing else, so the same snippet was
 * flat `--fg` in a message and highlighted in a tool result.
 *
 * The body is one `innerHTML` string, so the upgrade happens on the DOM afterwards — which is what these
 * drive, using happy-dom (the same engine `read_url` uses).
 */
async function render(html: string): Promise<Document> {
  const browser = new Browser();
  const page = browser.newPage();
  page.content = `<html><body><div class="content">${html}</div></body></html>`;
  await page.waitUntilComplete();
  const doc = page.mainFrame.document as unknown as Document;
  /**
   * `highlight-message.ts` creates its wrapper with `document.createElement`, which exists in the
   * browser but not in node. happy-dom supplies the document; publishing it globally is what lets the
   * module run unchanged under the test runner.
   */
  (globalThis as { document?: unknown }).document = doc;
  return doc;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a fenced block in a message becomes a shiki surface (#shiki)", async () => {
  const doc = await render(renderMarkdown("```c\nvoid main(void) {}\n```"));
  const root = doc.querySelector(".content") as unknown as HTMLElement;
  highlightMessageCode(root);
  // the upgrade is async (dynamic import + highlighter); the plain block stays until it lands
  for (let i = 0; i < 60 && !root.querySelector(".shikiwrap"); i++) await wait(50);

  const wrap = root.querySelector(".shikiwrap");
  assert.ok(wrap, "the block must be promoted, or messages stay flat while tool rows are highlighted");
  const pre = wrap!.querySelector("pre.shiki");
  assert.ok(pre, "and the output must be shiki's own <pre class=shiki>");
  assert.ok(wrap!.querySelectorAll("span").length > 0, "with token spans, i.e. actually coloured");
});

test("an info string that names a FILE also highlights (#shiki)", async () => {
  // ```src/index.ts — the reported example; `md.js` keeps `src/index.ts` as the language string and
  // shiki resolves the extension itself
  const doc = await render(renderMarkdown("```src/index.ts\nexport const test = \"\";\n```"));
  const root = doc.querySelector(".content") as unknown as HTMLElement;
  highlightMessageCode(root);
  for (let i = 0; i < 60 && !root.querySelector(".shikiwrap"); i++) await wait(50);
  assert.ok(root.querySelector(".shikiwrap"), "a filename info string must not prevent highlighting");
});

test("a block with no language stays plain (#shiki)", async () => {
  const doc = await render(renderMarkdown("```\nplain text\n```"));
  const root = doc.querySelector(".content") as unknown as HTMLElement;
  highlightMessageCode(root);
  await wait(120);
  assert.equal(root.querySelector(".shikiwrap"), null, "no info string = the author asked for no language");
  assert.ok(root.querySelector("pre"), "and the text is still there");
});

test("the wrapper paints NO surface of its own (#shiki)", async () => {
  /**
   * The transparency contract that has been broken repeatedly: shiki writes an inline background on its
   * `<pre>`, and if the wrapper adds its own the message grows an opaque block. `.shikiwrap` must stay
   * surface-less so the message's own surface shows through — MEASURED in real Firefox:
   * `wrapBg: rgba(0, 0, 0, 0)`, `wrapRadius: 0px`.
   */
  const doc = await render(renderMarkdown("```c\nint x;\n```"));
  const root = doc.querySelector(".content") as unknown as HTMLElement;
  highlightMessageCode(root);
  for (let i = 0; i < 60 && !root.querySelector(".shikiwrap"); i++) await wait(50);
  const wrap = root.querySelector(".shikiwrap")!;
  assert.equal(wrap.className, "shikiwrap", "exactly this class, nothing that paints a surface");
});

test("a second pass does not re-do the work (#shiki)", async () => {
  // rows re-render; the marker is what keeps this from re-highlighting on every pass
  const doc = await render(renderMarkdown("```c\nint y;\n```"));
  const root = doc.querySelector(".content") as unknown as HTMLElement;
  highlightMessageCode(root);
  for (let i = 0; i < 60 && !root.querySelector(".shikiwrap"); i++) await wait(50);
  const first = root.querySelector(".shikiwrap");
  highlightMessageCode(root);
  await wait(50);
  assert.equal(root.querySelector(".shikiwrap"), first, "the same element, not a duplicate");
  assert.equal(root.querySelectorAll(".shikiwrap").length, 1);
});
