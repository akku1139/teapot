/**
 * #7 — "read_file's line numbers are unfriendly."
 *
 * Two concrete defects in the `N| ` gutter, both identified in the #4 thread
 * and neither since fixed:
 *
 *  1. NO WIDTH PADDING. The prefix was `${i + 1}| `, so the gutter silently
 *     widened at line 1000 and the entire block jumped sideways mid-file. That
 *     is the literal "unfriendly" complaint, and it is worst exactly where
 *     reading is hardest: a long file, deep in it.
 *  2. A PHANTOM FINAL LINE. The prefix is added AFTER `text.split("\n")`, so a
 *     file ending in a newline splits into a final "" that gets its own number.
 *     The file has 2 lines; the read claims 3. A model copying the tail
 *     verbatim hands `edit_file` an `old_text` containing a line that does not
 *     exist, and the edit fails with no visible reason.
 *
 * `line_ids:"hash"` mode had the same phantom row, which is worse there: an
 * anchor for a non-existent line is a claim the verifier will reject.
 *
 * The width is padded to the widest number IN THE PAGE, not in the file — a
 * bounded page is what the model sees, and aligning to a 500k-line file would
 * push every row of a 20-line read six characters right.
 */
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

/**
 * A workspace that is REMOVED once the test finishes.
 *
 * `useTempDir` rather than a bare `mkdtemp`: the bare version leaked a
 * directory on every single run, and because the suite is run constantly that
 * had quietly filled /tmp with hundreds of them. The helper deletes in a
 * `finally`, so it cannot leak on a failure either — which a manual rm at the
 * end of the test would.
 */
async function withFile<T>(name: string, body: string, fn: (dir: string) => Promise<T>): Promise<T> {
  return useTempDir("p7-", async (dir) => {
    await writeFile(path.join(dir, name), body, "utf8");
    return fn(dir);
  });
}

/* ---------- 1: the gutter must not jump mid-file ---------- */

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
  // A 3-line page deep inside a 500k-line file must not be indented to 6
  // digits — the model only ever sees the page.
  assert.equal(gutterWidth(500_000, 3), 6, "a deep page still needs 6 digits (#7)");
  assert.equal(gutterWidth(1, 3), 1, "a short file needs one (#7)");
  assert.equal(renderGutter(["a", "b", "c"], 500_000).split("\n")[0]!.indexOf("|"), 6);
  assert.equal(renderGutter(["a", "b", "c"], 1).split("\n")[0]!.indexOf("|"), 1);
});

/* ---------- 2: no phantom final line ---------- */

test("a file ending in a newline does not gain a phantom last line (#7)", async () => {
  await withFile("t.txt", "a\nb\n", async (dir) => {
    assert.equal(await read(dir, { path: "t.txt" }), "1| a\n2| b");
  });
});

test("a file WITHOUT a trailing newline is unchanged (#7)", async () => {
  // The trailing element is only dropped when it is the empty string a final
  // newline produces. A file whose last line is genuinely blank keeps it.
  await withFile("t.txt", "a\nb\n", async (dir) => {
    assert.equal((await read(dir, { path: "t.txt" })).split("\n").length, 2);
  });
  await withFile("t2.txt", "a\nb", async (dir) => {
    assert.equal(await read(dir, { path: "t2.txt" }), "1| a\n2| b");
  });
  await withFile("t3.txt", "a\n\n", async (dir) => {
    // one real blank line plus the newline's empty element → one numbered blank
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

/* ---------- 3: the copy→edit round trip the defect actually broke ---------- */

test("the last real line is the last row shown, with no phantom after it (#7)", async () => {
  // NOTE the `N| ` gutter is display-only — a model strips it before passing
  // old_text (the hashline mode exists precisely so it need not). So this is not
  // a copy-verbatim test; it pins that the final row of a read corresponds to
  // a line that actually exists, which the phantom row broke.
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
  // The contrast that matters: with anchors the tail CAN be pasted as-is,
  // because the anchors verify it. A phantom anchor there made the edit fail
  // with "no line matches hash" — an error naming a line that never existed.
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

/* ---------- offsets still line up ---------- */

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
