import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { executeTool, sliceText } from "../src/agent/tools.ts";

/**
 * `read_url` must be able to reach the END of a long page.
 *
 * MEASURED before `offset` existed: an Anthropic research post extracted to 17,258 chars, the tool
 * returned `… [truncated, 17258 chars total]`, and raising `limit` did not help — the read always
 * started at 0 and `clipText` caps at 80k. So the second half of a long article was unreachable except
 * by counting characters by hand.
 *
 * The trailing hint states the exact next offset, so following up is mechanical.
 */
const ctx = (dir: string) => ({ cwd: dir, stateDir: dir, defaultTimeoutMs: 60_000, maxOutputBytes: 200_000 });

test("a slice carries the exact next offset (#readurl)", () => {
  const text = "x".repeat(5000);
  const first = sliceText(text, 0, 2000);
  assert.match(first, /truncated at 2000 of 5000/);
  assert.match(first, /offset=2000/, "the caller must not have to compute it");

  const second = sliceText(text, 2000, 2000);
  assert.match(second, /truncated at 4000 of 5000/);
  assert.match(second, /offset=4000/);
  assert.match(second, /…\[from 2000\]/, "and it says where this slice began");
});

test("the last slice ends without a truncation marker (#readurl)", () => {
  const text = "y".repeat(5000);
  const last = sliceText(text, 4000, 2000);
  assert.doesNotMatch(last, /truncated/, "nothing is cut, so nothing should claim it was");
  assert.match(last, /from 4000/);
});

test("past the end is reported, not silently empty (#readurl)", () => {
  const r = sliceText("short", 999, 2000);
  assert.match(r, /nothing after offset 999/, "an empty string would look like a failed read");
});

test("offset 0 is byte-identical to the old behaviour (#readurl)", () => {
  const text = "z".repeat(30_000);
  const r = sliceText(text, 0, 20_000);
  assert.ok(r.startsWith("z".repeat(20_000)), "no leading marker for the first slice");
  assert.match(r, /truncated at 20000 of 30000/);
});

test("the real tool paginates a long page to its end (#readurl)", async () => {
  // VARIED paragraphs: Readability collapses a single repeated block, which would make the fixture
  // short and the pagination assertion vacuous
  const paras = Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i}: ${"word ".repeat(40)}end.</p>`).join("");
  const body = `<html><body><article><h1>Long page</h1>${paras}</article></body></html>`;
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
  try {
    const seen: string[] = [];
    let offset = 0;
    for (let i = 0; i < 30; i++) {
      const r = await executeTool("read_url", JSON.stringify({ url, limit: 1000, offset }), ctx("/tmp") as never);
      assert.equal(r.ok, true, r.result.slice(0, 200));
      seen.push(r.result);
      const m = /offset=(\d+)/.exec(r.result);
      if (!m) break;
      offset = Number(m[1]);
      assert.ok(offset > 0, "the marker must advance, or the loop never ends");
    }
    assert.ok(seen.length > 1, `a long page must need more than one call, got ${seen.length}`);
    // count CONTENT, not the slices' concatenation: each slice repeats a marker line
    const content = seen
      .map((r) => r.replace(/^…\[from \d+\]\n/, "").replace(/\n… \[truncated at .*$/s, ""))
      .join("");
    assert.ok(content.length > 5000, `the pages together must exceed one call's worth, got ${content.length}`);
    // the end was reached: the final slice has no truncation marker
    assert.doesNotMatch(seen.at(-1)!, /truncated at/, "pagination must terminate at the end of the text");
  } finally {
    srv.close();
  }
});
