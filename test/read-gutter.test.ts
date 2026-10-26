import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { useTempDir } from "./helpers/tmp.ts";
import { executeTool, renderGutter, renderHashlines, gutterWidth } from "../src/agent/tools.ts";

async function read(dir: string, args: unknown): Promise<string> {
  const r = await executeTool("read_file", JSON.stringify(args), { cwd: dir } as never);
  assert.ok(r.ok, r.result);
  return r.result;
}

async function withFile<T>(name: string, body: string, fn: (dir: string) => Promise<T>): Promise<T> {
  return useTempDir("p7-", async (dir) => {
    await writeFile(path.join(dir, name), body, "utf8");
    return fn(dir);
  });
}

test("the gutter keeps one width across the 999/1000 boundary (#7)", async () => {
  const body = Array.from({ length: 1005 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  await withFile("big.txt", body, async (dir) => {
    const out = await read(dir, { path: "big.txt", offset: 997, limit: 6 });
    const rows = out.split("\n").filter((l) => /^\s*\d+\|/.test(l));
    const widths = new Set(rows.map((l) => l.indexOf("|")));
    assert.equal(
      widths.size,
      1,
      `every row in a page must share one gutter width — the block jumps otherwise (#7): ${JSON.stringify(out)}`,
    );
  });
});

test("padding is driven by the page, not the whole file (#7)", () => {
  assert.equal(gutterWidth(500_000, 3), 6, "a deep page still needs 6 digits (#7)");
  assert.equal(gutterWidth(1, 3), 1, "a short file needs one (#7)");
  assert.equal(renderGutter(["a", "b", "c"], 500_000).split("\n")[0]!.indexOf("|"), 6);
  assert.equal(renderGutter(["a", "b", "c"], 1).split("\n")[0]!.indexOf("|"), 1);
});

test("a file ending in a newline does not gain a phantom last line (#7)", async () => {
  await withFile("t.txt", "a\nb\n", async (dir) => {
    assert.equal(await read(dir, { path: "t.txt" }), "1| a\n2| b");
  });
});

test("a file WITHOUT a trailing newline is unchanged (#7)", async () => {
  await withFile("t.txt", "a\nb\n", async (dir) => {
    assert.equal((await read(dir, { path: "t.txt" })).split("\n").length, 2);
  });
  await withFile("t2.txt", "a\nb", async (dir) => {
    assert.equal(await read(dir, { path: "t2.txt" }), "1| a\n2| b");
  });
  await withFile("t3.txt", "a\n\n", async (dir) => {
    assert.equal(await read(dir, { path: "t3.txt" }), "1| a\n2| ");
  });
});

test("hashline mode has no phantom anchor either (#7)", async () => {
  await withFile("t.txt", "a\nb\n", async (dir) => {
    const out = await read(dir, { path: "t.txt", line_ids: "hash" });
    assert.equal(
      out,
      "1:292c| a\n2:2de5| b",
      `an anchor for a line that does not exist is a claim the verifier rejects (#7): ${JSON.stringify(out)}`,
    );
  });
});

test("the pure renderers agree with the tool (#7)", () => {
  assert.equal(renderGutter(["a", "b", ""], 1), "1| a\n2| b");
  assert.equal(renderHashlines(["a", "b", ""], 1), "1:292c| a\n2:2de5| b");
  assert.equal(renderGutter([], 1), "", "an empty page renders nothing (#7)");
  assert.equal(renderHashlines([], 1), "");
});

test("the last real line is the last row shown, with no phantom after it (#7)", async () => {
  await withFile("t.txt", "a\nb\n", async (dir) => {
    const rows = (await read(dir, { path: "t.txt" })).split("\n");
    assert.deepEqual(
      rows.map((r) => r.replace(/^\d+\| /, "")),
      ["a", "b"],
      `every row must be a real line of the file (#7): ${JSON.stringify(rows)}`,
    );
  });
});

test("hashline mode makes the tail copyable verbatim (#7)", async () => {
  await withFile("t.txt", "a\nb\n", async (dir) => {
    const rows = (await read(dir, { path: "t.txt", line_ids: "hash" })).split("\n");
    const r = await executeTool(
      "edit_file",
      JSON.stringify({ path: "t.txt", old_text: rows[rows.length - 1], new_text: "B" }),
      { cwd: dir } as never,
    );
    assert.ok(r.ok, `the tail anchor must be usable as old_text (#7): ${r.result}`);
  });
});

test("an offset page is numbered from the offset, not from 1 (#7)", async () => {
  const body = Array.from({ length: 50 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
  await withFile("t.txt", body, async (dir) => {
    const out = await read(dir, { path: "t.txt", offset: 10, limit: 3 });
    assert.deepEqual(
      out.split("\n").filter((l) => l.includes("|")),
      ["10| l10", "11| l11", "12| l12"],
      `offset numbering regressed (#7): ${JSON.stringify(out)}`,
    );
  });
});
