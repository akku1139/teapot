/**
 * #84 — LF / CRLF / LFCR normalisation.
 *
 * `edit_file` had handled CRLF since #61, but only on its hashline path, and
 * nothing detected CR-only (old-Mac) files at all. Measured before this:
 *
 *   read_file   split on `\n` only, so a CR-only file came back as ONE line —
 *               the model could not address lines 2..n at all.
 *   write_file  wrote the model's content verbatim. Models never emit `\r`, so
 *               rewriting a CRLF file with LF content silently converted every
 *               line: one logical edit produced a whole-file diff.
 *   mixed EOL   rewritten wholesale by any LF write.
 *
 * The conservative part is deliberate: a MIXED file is detected as ambiguous and
 * left exactly as it is, because choosing a winning EOL there would itself be
 * the silent whole-file rewrite this exists to prevent. That is a real
 * limitation, so it is asserted as behaviour rather than left implicit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { symlink } from "node:fs/promises";
import { useTempDir, useTempDirs } from "./helpers/tmp.ts";
import { executeTool, detectEol, splitEolLines, applyEol } from "../src/agent/tools.ts";

const ctx = (cwd: string) => ({ cwd, defaultTimeoutMs: 5000, maxOutputBytes: 10_000 }) as never;

/* ---------- detectEol ---------- */

test("each line ending is detected unambiguously (#84)", () => {
  assert.equal(detectEol("a\nb\nc\n"), "\n", "LF (#84)");
  assert.equal(detectEol("a\r\nb\r\nc\r\n"), "\r\n", "CRLF — the Windows case (#84)");
  assert.equal(detectEol("a\rb\rc\r"), "\r", "CR only — the old-Mac case (#84)");
});

test("a MIXED file is reported as ambiguous, not guessed (#84)", () => {
  // The point of the whole exercise: picking a winner for a mixed file would
  // rewrite it wholesale, silently — the exact failure being fixed.
  assert.equal(detectEol("a\r\nb\nc\rd\r\n"), null, "mixed must yield null (#84)");
  assert.equal(detectEol("a\r\nb\n"), null, "two kinds is already ambiguous (#84)");
});

test("empty and single-line files do not throw (#84)", () => {
  assert.equal(detectEol(""), null, "empty (#84)");
  // a file with no terminator has no line ending to detect — null is correct,
  // and it means "do not normalise", which leaves single-line files alone
  assert.equal(detectEol("no newline at all"), null, "no terminator -> nothing to honour (#84)");
});

/* ---------- splitEolLines ---------- */

test("all three terminators split lines (#84)", () => {
  assert.deepEqual(splitEolLines("a\nb"), ["a", "b"]);
  assert.deepEqual(splitEolLines("a\r\nb"), ["a", "b"], "CRLF (#84)");
  assert.deepEqual(splitEolLines("a\rb"), ["a", "b"], "CR only (#84)");
  assert.deepEqual(splitEolLines("a\r\nb\rc\nd"), ["a", "b", "c", "d"], "mixed (#84)");
});

/* ---------- applyEol ---------- */

test("applyEol re-applies the file's form without doubling CR (#84)", () => {
  assert.equal(applyEol("a\nb\n", "\r\n"), "a\r\nb\r\n", "LF -> CRLF (#84)");
  assert.equal(applyEol("a\nb\n", "\r"), "a\rb\r", "LF -> CR (#84)");
  assert.equal(applyEol("a\nb\n", "\n"), "a\nb\n", "LF -> LF is a no-op (#84)");
  // already-CRLF content re-normalised must not become \r\r\n
  assert.equal(applyEol("a\r\nb\r\n", "\r\n"), "a\r\nb\r\n", "idempotent on CRLF (#84)");
  assert.equal(applyEol("a\nb\n", null), "a\nb\n", "null (ambiguous) leaves content alone (#84)");
});

/* ---------- read_file ---------- */

test("read_file addresses every line of a CR-only file (#84)", async () => {
  await useTempDir("p84r-", async (ws) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${ws}/f.txt`, "alpha\rbeta\rgamma\r", "utf8");
    const r = await executeTool("read_file", JSON.stringify({ path: "f.txt" }), ctx(ws));
    assert.match(r.result ?? "", /1\| alpha/, "line 1 (#84)");
    assert.match(r.result ?? "", /2\| beta/, "line 2 was unreachable before (#84)");
    assert.match(r.result ?? "", /3\| gamma/, "line 3 was unreachable before (#84)");
  });
});

/* ---------- write_file ---------- */

test("write_file keeps CRLF when the model sends LF (#84)", async () => {
  await useTempDir("p84w-", async (ws) => {
    const { writeFile } = await import("node:fs/promises");
    const { readFile } = await import("node:fs/promises");
    await writeFile(`${ws}/f.txt`, "a\r\nb\r\nc\r\n", "utf8");
    const r = await executeTool(
      "write_file",
      JSON.stringify({ path: "f.txt", content: "A\nB\nC\n" }),
      ctx(ws),
    );
    assert.equal(await readFile(`${ws}/f.txt`, "utf8"), "A\r\nB\r\nC\r\n", "CRLF must survive (#84)");
    assert.match(r.result ?? "", /CRLF/, "and the tool must SAY it preserved them (#84)");
  });
});

test("write_file keeps CR on a CR-only file (#84)", async () => {
  await useTempDir("p84c-", async (ws) => {
    const { writeFile, readFile } = await import("node:fs/promises");
    await writeFile(`${ws}/f.txt`, "a\rb\rc\r", "utf8");
    await executeTool("write_file", JSON.stringify({ path: "f.txt", content: "A\nB\nC\n" }), ctx(ws));
    assert.equal(await readFile(`${ws}/f.txt`, "utf8"), "A\rB\rC\r", "CR must survive (#84)");
  });
});

test("write_file creates a NEW file with the content it was given (#84)", async () => {
  await useTempDir("p84n-", async (ws) => {
    const { readFile } = await import("node:fs/promises");
    await executeTool("write_file", JSON.stringify({ path: "new.txt", content: "a\nb\n" }), ctx(ws));
    assert.equal(await readFile(`${ws}/new.txt`, "utf8"), "a\nb\n", "no existing file -> no EOL to honour (#84)");
  });
});

test("write_file leaves a MIXED file mixed rather than picking a winner (#84)", async () => {
  await useTempDir("p84m-", async (ws) => {
    const { writeFile, readFile } = await import("node:fs/promises");
    await writeFile(`${ws}/f.txt`, "a\r\nb\nc\rd\r\n", "utf8");
    await executeTool("write_file", JSON.stringify({ path: "f.txt", content: "A\nB\nC\nD\n" }), ctx(ws));
    // documented limitation: an ambiguous file is not normalised, because
    // choosing one form would itself be a silent whole-file rewrite
    assert.equal(
      await readFile(`${ws}/f.txt`, "utf8"),
      "A\nB\nC\nD\n",
      "a mixed file is left as the model wrote it (#84)",
    );
  });
});

/* ---------- edit_file ---------- */

test("edit_file keeps CR on a CR-only file (#84)", async () => {
  await useTempDir("p84e-", async (ws) => {
    const { writeFile, readFile } = await import("node:fs/promises");
    await writeFile(`${ws}/f.txt`, "a\rb\rc\r", "utf8");
    const r = await executeTool(
      "edit_file",
      JSON.stringify({ path: "f.txt", old_text: "b", new_text: "B" }),
      ctx(ws),
    );
    assert.ok(r.ok, `the edit must succeed (#84): ${r.result}`);
    assert.equal(await readFile(`${ws}/f.txt`, "utf8"), "a\rB\rc\r", "CR must survive the edit (#84)");
  });
});

test("edit_file keeps CRLF (#84 — the #61 case, still holding)", async () => {
  await useTempDir("p84e2-", async (ws) => {
    const { writeFile, readFile } = await import("node:fs/promises");
    await writeFile(`${ws}/f.txt`, "a\r\nb\r\nc\r\n", "utf8");
    await executeTool("edit_file", JSON.stringify({ path: "f.txt", old_text: "b", new_text: "B" }), ctx(ws));
    assert.equal(await readFile(`${ws}/f.txt`, "utf8"), "a\r\nB\r\nc\r\n", "CRLF must survive (#84)");
  });
});

/* ---------- the real-world payoff ---------- */

test("a one-line change on a large CRLF file stays a one-line diff (#84)", async () => {
  await useTempDirs(["p84big-", "p84out-"], async ([ws, _out]) => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\r\n") + "\r\n";
    await writeFile(`${ws}/big.txt`, body, "utf8");
    await executeTool(
      "edit_file",
      JSON.stringify({ path: "big.txt", old_text: "line 100", new_text: "LINE 100" }),
      ctx(ws!),
    );
    const after = await readFile(`${ws!}/big.txt`, "utf8");
    assert.equal((after.match(/\r\n/g) ?? []).length, 200, "every line keeps CRLF (#84)");
    assert.equal((after.match(/(?<!\r)\n/g) ?? []).length, 0, "no line silently became LF (#84)");
    assert.ok(after.includes("LINE 100"), "and the edit landed (#84)");
  });
});

test("the symlink guard still holds with the new helpers in place (#74 regression)", async () => {
  await useTempDirs(["p84s-", "p84so-"], async ([ws, out]) => {
    await symlink(out!, `${ws}/esc`, "dir");
    const r = await executeTool(
      "write_file",
      JSON.stringify({ path: "esc/pwned.txt", content: "x" }),
      ctx(ws!),
    );
    assert.equal(r.ok, false, "EOL handling must not weaken the workspace guard (#74/#84)");
  });
});
