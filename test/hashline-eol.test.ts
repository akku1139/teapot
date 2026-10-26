import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { useTempDir } from "./helpers/tmp.ts";
import { executeTool, type ToolContext } from "../src/agent/tools.ts";

async function readThenEdit(
  file: string,
  oldText: string | undefined,
  newText: string,
  lineIndex = 0,
): Promise<{ ok: boolean; result: string; after: string }> {
  return useTempDir("p61-", async (ws) => {
  const ctx: ToolContext = { cwd: ws, defaultTimeoutMs: 5_000, maxOutputBytes: 64 * 1024 };
  const p = path.join(ws, "a.js");
  await writeFile(p, file, "utf8");
  const call = (n: string, a: unknown) => executeTool(n, JSON.stringify(a), ctx);
  const read = await call("read_file", { path: "a.js", line_ids: "hash" });
  const anchorLine = String(read.result).split("\n")[lineIndex]!;
  const edit = await call("edit_file", { path: "a.js", old_text: oldText ?? anchorLine, new_text: newText });
  return { ok: edit.ok, result: String(edit.result), after: await readFile(p, "utf8") };
  });
}

const CRLF = "function f() {\r\n  const a = 1;\r\n  const b = 2;\r\n}\r\n";
const bareLF = (s: string) => s.match(/(?<!\r)\n/g)?.length ?? 0;

test("a hashline edit must not inject bare LFs into a CRLF file (#61)", async () => {
  const { ok, result, after } = await readThenEdit(CRLF, undefined, "  const a = 42;");
  assert.ok(ok, `the edit must still succeed (#61): ${result}`);
  assert.equal(
    bareLF(after),
    0,
    `a CRLF file must stay CRLF — the join dropped every \\r (#61): ${JSON.stringify(after)}`,
  );
  assert.equal(after, "  const a = 42;\r\n  const a = 1;\r\n  const b = 2;\r\n}\r\n");
});

test("a multi-line replacement into CRLF stays CRLF throughout (#61)", async () => {
  const { ok, after } = await readThenEdit(CRLF, undefined, "  const a = 42;\n  const c = 3;");
  assert.ok(ok);
  assert.equal(
    bareLF(after),
    0,
    `a multi-line replacement must not mix endings (#61): ${JSON.stringify(after)}`,
  );
  assert.ok(after.includes("\r\n  const c = 3;"), "the new line must be present (#61)");
});

test("an LF file must stay LF (#61)", async () => {
  const { ok, after } = await readThenEdit("function f() {\n  const a = 1;\n}\n", undefined, "  const a = 42;");
  assert.ok(ok);
  assert.equal(bareLF(after), after.split("\n").length - 1, "every break is still a bare LF (#61)");
  assert.equal(after.includes("\r"), false, "no CR may be introduced into an LF file (#61)");
});

test("a CRLF file with LF new_text is the case that actually occurs (#61)", async () => {
  const { after } = await readThenEdit(CRLF, undefined, "  const a = 42;", 1);
  assert.ok(after.startsWith("function f() {\r\n"), "the untouched line kept CRLF (#61)");
  assert.ok(after.includes("\r\n  const a = 42;\r\n"), "the replaced line adopted CRLF too (#61)");
});

test("a CRLF file keeps its endings when nothing is inserted (#61)", async () => {
  const { after } = await readThenEdit(CRLF, undefined, "function f() {\r\n  const a = 1;");
  assert.equal(bareLF(after), 0, "even a CRLF-carrying new_text must not mix (#61)");
});

test("the untouched text around the span is byte-identical (#61)", async () => {
  const { after } = await readThenEdit(CRLF, undefined, "  const a = 42;");
  assert.ok(after.endsWith("  const b = 2;\r\n}\r\n"), "the tail is untouched, CRLF and all (#61)");
});
