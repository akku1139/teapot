/**
 * #7 / #4 — read_file's line numbers are unfriendly, and hashline edit support.
 *
 * The problem the two issues describe together: read_file prints an `N| `
 * gutter, but edit_file's old_text must NOT contain it. So every read plants a
 * trap, and the only mitigation was a sentence in the tool description.
 *
 * Format follows the established "hashline" convention used across AI coding
 * harnesses (quangdang46/hashline, kebbbnnn/hashline, opencode-hashline,
 * pi-hashline-edit-pro, mcp-hashline-edit-server, …):
 *
 *     12:a3f1| function calculateTotal(items) {
 *
 * `LINE:HASH| content` — the line number is KEPT and a content hash ADDED as an
 * integrity anchor. Verified against those implementations rather than invented:
 * the hash covers the STRIPPED content, blank lines get a reserved hash, and a
 * repeated hash is disambiguated by proximity to the anchor's line number.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import {
  executeTool,
  hashLine,
  renderHashlines,
  parseAnchor,
  resolveAnchor,
  isHashlineBlock,
  resolveHashlineBlock,
  lineIdMode,
} from "../src/agent/tools.ts";
import { useTempDir } from "./helpers/tmp.ts";

const ctx = (dir: string) => ({ cwd: dir, defaultTimeoutMs: 5_000, maxOutputBytes: 10_000 });

const SRC = "const x = 1;\nconst y = 2;\nconst z = 3;\n";

/* ---------- the hash itself ---------- */

test("hashLine is 4 hex chars, and blank lines get a reserved anchor (#7)", () => {
  assert.match(hashLine("const x = 1;"), /^[0-9a-f]{4}$/);
  assert.equal(hashLine(""), "    ", "blank lines use a reserved 4-space anchor");
  assert.equal(hashLine("   \t "), "    ");
});

test("hashLine hashes the STRIPPED content so re-indenting keeps the anchor (#7)", () => {
  // whitespace-only changes must NOT invalidate an anchor
  assert.equal(hashLine("  const x = 1;"), hashLine("const x = 1;"));
  assert.equal(hashLine("\tconst x = 1;\t"), hashLine("const x = 1;"));
  assert.notEqual(hashLine("const x = 1;"), hashLine("const x = 2;"));
});

test("hashLine is deterministic across calls (#7)", () => {
  assert.equal(hashLine("let a = 1;"), hashLine("let a = 1;"));
});

/* ---------- the read side ---------- */

test("renderHashlines emits LINE:HASH| content (#7)", () => {
  const out = renderHashlines(["const a = 1;", "const b = 2;"], 1);
  const rows = out.split("\n");
  assert.equal(rows.length, 2);
  assert.match(rows[0]!, /^1:[0-9a-f]{4}\| const a = 1;$/);
  assert.match(rows[1]!, /^2:[0-9a-f]{4}\| const b = 2;$/);
  // the LINE NUMBER IS KEPT — that is the canonical format, and it keeps the
  // output navigable for both humans and models
  assert.match(rows[0]!, /^1:/);
});

test("renderHashlines honours a start line for paginated reads (#7)", () => {
  const out = renderHashlines(["c", "d"], 10);
  assert.match(out.split("\n")[0]!, /^10:/);
  assert.match(out.split("\n")[1]!, /^11:/);
});

test("read_file(line_ids:hash) returns the canonical format (#7)", async () => {
  await useTempDir("hl-read-", async (dir) => {
    await writeFile(path.join(dir, "a.ts"), SRC);
    const r = await executeTool("read_file", JSON.stringify({ path: "a.ts", line_ids: "hash" }), ctx(dir));
    assert.ok(r.ok, r.result);
    const rows = r.result.split("\n");
    assert.match(rows[0]!, /^1:[0-9a-f]{4}\| const x = 1;$/);
    assert.match(rows[1]!, /^2:[0-9a-f]{4}\| const y = 2;$/);
    // every content line is anchored and the hash matches the real content
    for (const row of rows) {
      const a = parseAnchor(row.slice(0, row.indexOf("|")));
      assert.ok(a, `unparseable anchor: ${row}`);
      const content = row.slice(row.indexOf("|") + 2);
      assert.equal(hashLine(content), a!.hash, `hash must match its own line: ${row}`);
    }
  });
});

test("the default read_file output is UNCHANGED (#7 is opt-in)", async () => {
  // existing tests assert on `N| `; the format must not shift under them
  await useTempDir("hl-def-", async (dir) => {
    await writeFile(path.join(dir, "a.ts"), SRC);
    const r = await executeTool("read_file", JSON.stringify({ path: "a.ts" }), ctx(dir));
    assert.equal(r.result.split("\n")[0], "1| const x = 1;");
    assert.equal(lineIdMode({}), "none");
    assert.equal(lineIdMode({ line_ids: "none" }), "none");
    assert.equal(lineIdMode({ line_ids: "hash" }), "hash");
    assert.equal(lineIdMode({ hashline: true }), "hash");
  });
});

test("pattern mode also honours line_ids:hash (#7)", async () => {
  await useTempDir("hl-pat-", async (dir) => {
    await writeFile(path.join(dir, "a.ts"), "alpha\nbeta\ngamma\nbeta\n");
    const r = await executeTool(
      "read_file",
      JSON.stringify({ path: "a.ts", pattern: "beta", line_ids: "hash" }),
      ctx(dir),
    );
    assert.ok(r.ok, r.result);
    for (const row of r.result.split("\n")) {
      if (!row.trim() || row.startsWith("(") || row === "--") continue;
      assert.match(row, /^\d+:[0-9a-f]{4}\|/, `pattern-mode row must be anchored: ${row}`);
    }
  });
});

/* ---------- the edit side: anchors round-trip verbatim ---------- */

test("a hashline block copied from read_file works as old_text VERBATIM (#4)", async () => {
  await useTempDir("hl-rt-", async (dir) => {
    const f = path.join(dir, "a.ts");
    await writeFile(f, SRC);
    const r = await executeTool("read_file", JSON.stringify({ path: "a.ts", line_ids: "hash" }), ctx(dir));
    const block = r.result.split("\n").slice(1, 3).join("\n"); // lines 2-3, anchors intact
    assert.match(block, /^2:[0-9a-f]{4}\|/, "the block really does carry anchors");

    const e = await executeTool(
      "edit_file",
      JSON.stringify({ path: "a.ts", old_text: block, new_text: "const y = 22;\nconst z = 3;" }),
      ctx(dir),
    );
    assert.ok(e.ok, e.result);
    assert.equal(await readFile(f, "utf8"), "const x = 1;\nconst y = 22;\nconst z = 3;\n");
  });
});

test("a single anchored line works as old_text (#4)", async () => {
  await useTempDir("hl-one-", async (dir) => {
    const f = path.join(dir, "a.ts");
    await writeFile(f, SRC);
    const row = (await executeTool("read_file", JSON.stringify({ path: "a.ts", line_ids: "hash" }), ctx(dir)))
      .result.split("\n")[1]!;
    const e = await executeTool("edit_file", JSON.stringify({ path: "a.ts", old_text: row, new_text: "const y = 99;" }), ctx(dir));
    assert.ok(e.ok, e.result);
    assert.match(await readFile(f, "utf8"), /const y = 99;/);
  });
});

/* ---------- the property that makes it worth having: stale rejection ---------- */

test("a stale read is REFUSED instead of editing the wrong lines (#4)", async () => {
  await useTempDir("hl-stale-", async (dir) => {
    const f = path.join(dir, "a.ts");
    await writeFile(f, SRC);
    const anchor = (await executeTool("read_file", JSON.stringify({ path: "a.ts", line_ids: "hash" }), ctx(dir)))
      .result.split("\n")[1]!; // "2:<hash>| const y = 2;"

    // the file changes under the agent between read and edit
    await writeFile(f, "const x = 1;\nconst CHANGED = 9;\n");
    const e = await executeTool("edit_file", JSON.stringify({ path: "a.ts", old_text: anchor, new_text: "X" }), ctx(dir));
    assert.equal(e.ok, false, "a stale anchor must NOT silently edit (#4)");
    assert.match(e.result, /changed since you read|stale/i, `error must say it is stale: ${e.result}`);
    assert.equal(await readFile(f, "utf8"), "const x = 1;\nconst CHANGED = 9;\n", "file must be untouched");
  });
});

test("a mistyped anchor is diagnosed as an anchor problem (#7)", async () => {
  await useTempDir("hl-typo-", async (dir) => {
    await writeFile(path.join(dir, "a.ts"), SRC);
    const e = await executeTool(
      "edit_file",
      JSON.stringify({ path: "a.ts", old_text: "3:zzzz| const z = 3;", new_text: "X" }),
      ctx(dir),
    );
    assert.equal(e.ok, false);
    // recognised as an ANCHOR that does not resolve — not "no similar text",
    // which would send the model hunting for a whitespace problem
    assert.match(e.result, /hashline block but did not resolve/i, e.result);
    // a NON-hex anchor is a different mistake from a stale read, and must not
    // be reported as one — that would send the agent hunting for an edit it
    // never lost (#7)
    assert.match(e.result, /not a valid anchor/i, `must name the real problem: ${e.result}`);
    assert.doesNotMatch(e.result, /changed since you read/i, "must not blame a stale read (#7)");
    assert.doesNotMatch(e.result, /trailing spaces/, "must not blame whitespace (#7)");
  });
});

test("a stale anchor IS reported as stale (#7)", async () => {
  await useTempDir("hl-stale2-", async (dir) => {
    const f = path.join(dir, "a.ts");
    await writeFile(f, SRC);
    const anchor = (await executeTool("read_file", JSON.stringify({ path: "a.ts", line_ids: "hash" }), ctx(dir)))
      .result.split("\n")[1]!;
    await writeFile(f, "const x = 1;\nconst CHANGED = 9;\n");
    const e = await executeTool("edit_file", JSON.stringify({ path: "a.ts", old_text: anchor, new_text: "X" }), ctx(dir));
    assert.equal(e.ok, false);
    assert.match(e.result, /changed since you read it/i, `a real stale read must say so: ${e.result}`);
    assert.doesNotMatch(e.result, /not a valid anchor/i, "a valid-but-stale anchor is not malformed");
  });
});

test("anchors survive lines shifting above them — the whole point (#4)", async () => {
  await useTempDir("hl-shift-", async (dir) => {
    const f = path.join(dir, "a.ts");
    await writeFile(f, SRC);
    const anchor = (await executeTool("read_file", JSON.stringify({ path: "a.ts", line_ids: "hash" }), ctx(dir)))
      .result.split("\n")[1]!;
    // something is INSERTED above; the anchored content is now on line 3
    await writeFile(f, "const inserted = 0;\nconst x = 1;\nconst y = 2;\nconst z = 3;\n");
    const e = await executeTool("edit_file", JSON.stringify({ path: "a.ts", old_text: anchor, new_text: "const y = 22;" }), ctx(dir));
    assert.ok(e.ok, `an anchor must survive an unrelated insert above it (#4): ${e.result}`);
    assert.match(await readFile(f, "utf8"), /const y = 22;/);
    assert.match(await readFile(f, "utf8"), /const inserted = 0;/, "the insert must survive");
  });
});

/* ---------- ambiguity ---------- */

test("a duplicated line resolves by proximity, not by luck (#4)", async () => {
  await useTempDir("hl-dup-", async (dir) => {
    const f = path.join(dir, "a.ts");
    // identical lines at 1 and 3
    await writeFile(f, "dup\nkeep\ndup\n");
    const h = hashLine("dup");
    // the anchor for the SECOND occurrence must win, not the first
    const e = await executeTool(
      "edit_file",
      JSON.stringify({ path: "a.ts", old_text: `3:${h}| dup`, new_text: "replaced" }),
      ctx(dir),
    );
    assert.ok(e.ok, e.result);
    assert.equal(await readFile(f, "utf8"), "dup\nkeep\nreplaced\n");
  });
});

test("resolveAnchor reports how it resolved (#4)", () => {
  const lines = ["dup", "keep", "dup"];
  const h = hashLine("dup");
  const one = resolveAnchor(lines, { line: 1, hash: hashLine("keep") });
  assert.ok(!("error" in one) && one.how === "unique");
  const many = resolveAnchor(lines, { line: 3, hash: h });
  assert.ok(!("error" in many) && many.index === 2, "proximity must pick line 3");
  const missing = resolveAnchor(lines, { line: 1, hash: "zzzz" });
  assert.ok("error" in missing);
});

test("an unknown hash is never resolved by falling back to a line number (#4)", () => {
  // this is the failure mode hashline exists to prevent: "close enough" edits
  const r = resolveAnchor(["a", "b"], { line: 2, hash: "zzzz" });
  assert.ok("error" in r, "an unknown hash must be an error, never a guess (#4)");
});

/* ---------- block detection ---------- */

test("isHashlineBlock only accepts fully-anchored blocks (#7)", () => {
  assert.equal(isHashlineBlock("1:a851| const a = 1;\n2:b211| const b = 2;"), true);
  // plain text that happens to contain a tab is NOT a hashline block
  assert.equal(isHashlineBlock("a\tb = 1;"), false);
  assert.equal(isHashlineBlock("const a = 1;"), false);
  assert.equal(isHashlineBlock(""), false);
});

test("plain text containing tabs still edits normally (#7)", async () => {
  await useTempDir("hl-tab-", async (dir) => {
    const f = path.join(dir, "t.ts");
    await writeFile(f, "a\tb = 1;\n");
    const e = await executeTool("edit_file", JSON.stringify({ path: "t.ts", old_text: "a\tb = 1;", new_text: "c = 2;" }), ctx(dir));
    assert.ok(e.ok, `a tab is not an anchor: ${e.result}`);
    assert.equal(await readFile(f, "utf8"), "c = 2;\n");
  });
});

test("resolveHashlineBlock refuses a block that reuses one line (#4)", () => {
  const lines = ["a", "b"];
  const r = resolveHashlineBlock(`1:${hashLine("a")}| a\n1:${hashLine("a")}| a`, lines);
  assert.ok("error" in r, "the same line twice must be refused");
});

/* ---------- blank lines ---------- */

test("blank lines round-trip through the reserved anchor (#7)", async () => {
  await useTempDir("hl-blank-", async (dir) => {
    const f = path.join(dir, "b.ts");
    await writeFile(f, "const a = 1;\n\nconst b = 2;\n");
    const r = await executeTool("read_file", JSON.stringify({ path: "b.ts", line_ids: "hash" }), ctx(dir));
    assert.match(r.result, /^2: {4}\| $/m, "a blank line gets the reserved anchor");
  });
});