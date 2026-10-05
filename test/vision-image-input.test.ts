/**
 * #125 — "can an agent receive image files, as vision input, off the filesystem?
 * I think it was implemented, but how is it?"
 *
 * Answer, measured rather than recalled: **half of it.**
 *
 *   operator → agent : YES, already implemented
 *   agent  → an image : NO
 *
 * ## What exists
 *
 * The composer accepts a paste or a 📎 attach, and
 * `POST /api/agents/:id/prompt` takes `images: [{url, name}]`. `drainPendingPrompts`
 * turns them into OpenAI content parts, text first:
 *
 *     { type: "text", text: "look" },
 *     { type: "image_url", image_url: { url: "data:image/png;base64,…" } }
 *
 * ## What does not
 *
 * **A filesystem path is silently DROPPED.** The `/prompt` image filter keeps
 * only `data:image/…` under ~9MB and `http(s)://`; anything else — including a
 * path and a `file://` URL — is filtered out with no error, so the prompt is sent
 * as text alone and the operator is told nothing.
 *
 * And `read_file` is text-only, so an AGENT cannot look at an image in its own
 * workspace at all. It can `ls` one, and that is the end of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const api = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
const agent = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
const tools = readFileSync(new URL("../src/agent/tools.ts", import.meta.url), "utf8");

/** the image filter as the /prompt route implements it */
function accepted(url: string): boolean {
  if (url.startsWith("data:image/")) return url.length < 12_000_000;
  return /^https?:\/\//.test(url);
}

test("operator → agent: images ride as content parts (#125)", () => {
  assert.match(
    agent,
    /p\.images\.map\(\(i\) => \(\{ type: "image_url" as const, image_url: \{ url: i\.url \} \}\)\)/,
    "images must reach the model as image_url parts (#125)",
  );
  assert.match(
    agent,
    /\{ type: "text", text: p\.text \},/,
    "with the text FIRST, which is what providers require (#125)",
  );
});

test("a data: image URL is accepted (#125)", () => {
  assert.equal(accepted("data:image/png;base64,AAAA"), true);
});

test("an http(s) image URL is accepted (#125)", () => {
  assert.equal(accepted("https://example.com/x.png"), true);
  assert.equal(accepted("http://example.com/x.png"), true);
});

test("a FILESYSTEM PATH is silently dropped (#125)", () => {
  // the gap the question is really about: an image sitting in the workspace
  assert.equal(
    accepted("/home/user/work/shot.png"),
    false,
    "a path is dropped — so an agent cannot be shown a file on disk (#125)",
  );
  assert.equal(accepted("file:///home/user/work/shot.png"), false, "and file:// too (#125)");
  assert.equal(accepted("./shot.png"), false, "a relative path too (#125)");
});

test("the drop is silent — no error is raised (#125)", () => {
  // the worse half: the prompt is delivered as text alone and the operator is
  // never told the image was discarded
  assert.match(
    api,
    /const images = \(body\.images \?\? \[\]\)\.filter\(/,
    "images are filtered, not validated with an error (#125)",
  );
  assert.doesNotMatch(
    api,
    /image.*(unsupported|not allowed|invalid image)/i,
    "there is no message telling the operator an image was discarded (#125)",
  );
});

test("an agent cannot read an image in its own workspace (#125)", () => {
  assert.match(
    tools,
    /name: "read_file"/,
    "read_file exists (#125)",
  );
  assert.match(
    tools,
    /Read a text file from the workspace/,
    "and is text-only — no tool returns image bytes (#125)",
  );
  assert.doesNotMatch(
    tools,
    /type: "image_url"/,
    "nothing in the tool layer emits an image part (#125)",
  );
});