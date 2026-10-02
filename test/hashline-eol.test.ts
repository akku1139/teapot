/**
 * #61 — "Space Bunny Alpha desperately cannot hashline-edit."
 *
 * The happy path of hashline is solid: a model reads with
 * `line_ids:"hash"`, copies a block verbatim, and `edit_file` verifies the
 * anchors and edits the resolved line span. What is broken is the EOL.
 *
 * The hashline branch resolves anchors to LINE NUMBERS, so it indexes the file
 * with `text.split("\n")` — which on a CRLF file leaves a trailing "\r" on
 * every line — and then rejoins with "\n". Every "\r" in the file was
 * therefore dropped on the way out. The edit reported success, the file still
 * parsed, and nothing said otherwise; but a single edit had silently rewritten
 * a Windows file's line endings, so the next checkout or formatter run shows
 * the whole file as changed.
 *
 * Models never emit "\r" (they send LF-separated `new_text`), so the mixed
 * endings came entirely from the join, and the damage scaled with the size of
 * the replacement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { useTempDir } from "./helpers/tmp.ts";
import { executeTool } from "../src/agent/tools.ts";

/** run the real read→copy→edit cycle a model performs */
async function readThenEdit(
  file: string,
  oldText: string | undefined,
  newText: string,
  lineIndex = 0,
): Promise<{ ok: boolean; result: string; after: string }> {
  return useTempDir("p61-", async (ws) => {
  const ctx = { cwd: ws };
  const p = path.join(ws, "a.js");
  await writeFile(p, file, "utf8");
  const call = (n: string, a: unknown) => executeTool(n, JSON.stringify(a), ctx);
  const read = await call("read_file", { path: "a.js", line_ids: "hash" });
  // the model copies one anchored line verbatim, exactly as printed
  const anchorLine = String(read.result).split("\n")[lineIndex]!;
  const edit = await call("edit_file", { path: "a.js", old_text: oldText ?? anchorLine, new_text: newText });
  return { ok: edit.ok, result: String(edit.result), after: await readFile(p, "utf8") };
  });
}

const CRLF = "function f() {\r\n  const a = 1;\r\n  const b = 2;\r\n}\r\n";
const bareLF = (s: string) => s.match(/(?<!\r)\n/g)?.length ?? 0;

/* ---------- the defect ---------- */

test("a hashline edit must not inject bare LFs into a CRLF file (#61)", async () => {
  const { ok, result, after } = await readThenEdit(CRLF, undefined, "  const a = 42;");
  assert.ok(ok, `the edit must still succeed (#61): ${result}`);
  assert.equal(
    bareLF(after),
    0,
    `a CRLF file must stay CRLF — the join dropped every \\r (#61): ${JSON.stringify(after)}`,
  );
  // line 0 is the signature, and that is the line replaced here
  assert.equal(after, "  const a = 42;\r\n  const a = 1;\r\n  const b = 2;\r\n}\r\n");
});

test("a multi-line replacement into CRLF stays CRLF throughout (#61)", async () => {
  // Damage scaled with the replacement: a 2-line insert left 2 bare LFs.
  const { ok, after } = await readThenEdit(CRLF, undefined, "  const a = 42;\n  const c = 3;");
  assert.ok(ok);
  assert.equal(
    bareLF(after),
    0,
    `a multi-line replacement must not mix endings (#61): ${JSON.stringify(after)}`,
  );
  assert.ok(after.includes("\r\n  const c = 3;"), "the new line must be present (#61)");
});

/* ---------- the opposite must not regress ---------- */

test("an LF file must stay LF (#61)", async () => {
  const { ok, after } = await readThenEdit("function f() {\n  const a = 1;\n}\n", undefined, "  const a = 42;");
  assert.ok(ok);
  assert.equal(bareLF(after), after.split("\n").length - 1, "every break is still a bare LF (#61)");
  assert.equal(after.includes("\r"), false, "no CR may be introduced into an LF file (#61)");
});

test("a CRLF file with LF new_text is the case that actually occurs (#61)", async () => {
  // Models never emit \r, so this is the real-world shape: the file is CRLF and
  // the replacement arrives as plain LF. The output must follow the FILE.
  const { after } = await readThenEdit(CRLF, undefined, "  const a = 42;", 1);
  assert.ok(after.startsWith("function f() {\r\n"), "the untouched line kept CRLF (#61)");
  assert.ok(after.includes("\r\n  const a = 42;\r\n"), "the replaced line adopted CRLF too (#61)");
});

/* ---------- it is not a blanket "convert everything" hack ---------- */

test("a CRLF file keeps its endings when nothing is inserted (#61)", async () => {
  const { after } = await readThenEdit(CRLF, undefined, "function f() {\r\n  const a = 1;");
  assert.equal(bareLF(after), 0, "even a CRLF-carrying new_text must not mix (#61)");
});

test("the untouched text around the span is byte-identical (#61)", async () => {
  // The fix must re-apply the file's EOL, not rewrite the whole file, or every
  // edit would show up as a full-file diff.
  const { after } = await readThenEdit(CRLF, undefined, "  const a = 42;");
  assert.ok(after.endsWith("  const b = 2;\r\n}\r\n"), "the tail is untouched, CRLF and all (#61)");
});
