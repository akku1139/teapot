/**
 * #16 — "make read_file able to read several files / several places at once,
 *        plus fuzzy search" (Codebuff has this)
 *
 * I could not find the reference implementation to copy, so the design follows
 * what teapot actually lacked: read_file took ONE path, and there was no
 * grep/glob tool at all, so locating code meant reading whole files one at a
 * time.
 *
 * Two additions, both OPT-IN. A call with `path` alone must keep returning
 * byte-identical output — #7's hashline anchors and the existing tests depend
 * on the exact format — which several tests below assert directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { useTempDirs } from "./helpers/tmp.ts";
import { executeTool, toolSpecs, fuzzyPathMatch } from "../src/agent/tools.ts";

const ctx = (dir: string) => ({ cwd: dir, defaultTimeoutMs: 5_000, maxOutputBytes: 10_000 });

async function seed(ws: string) {
  await writeFile(path.join(ws, "a.ts"), "AAA\nBBB\n");
  await writeFile(path.join(ws, "b.ts"), "CCC\n");
  await mkdir(path.join(ws, "src", "auth"), { recursive: true });
  await writeFile(path.join(ws, "src", "auth", "login.ts"), "LOGIN\n");
  await writeFile(path.join(ws, "README.md"), "# readme\n");
}

/* ---------- the single-file contract must not move (#16) ---------- */

test("a plain single-path read is byte-identical to before (#16)", async () => {
  await useTempDirs(["m16a-", "m16b-"], async ([ws]) => {
    await seed(ws);
    const r = await executeTool("read_file", JSON.stringify({ path: "a.ts" }), ctx(ws));
    assert.ok(r.ok, r.result);
    // exact historical format: `N| ` gutters, trailing empty line preserved
    assert.equal(r.result, "1| AAA\n2| BBB\n3| ", "single-read format changed (#16)");
  });
});

test("a missing single file still reports a readable error (#16)", async () => {
  await useTempDirs(["m16c-", "m16d-"], async ([ws]) => {
    const r = await executeTool("read_file", JSON.stringify({ path: "nope.ts" }), ctx(ws));
    assert.equal(r.ok, false);
    assert.match(r.result, /cannot read nope\.ts/);
  });
});

/* ---------- multi-file (#16) ---------- */

test("paths reads several files in one call (#16)", async () => {
  await useTempDirs(["m16e-", "m16f-"], async ([ws]) => {
    await seed(ws);
    const r = await executeTool("read_file", JSON.stringify({ paths: ["a.ts", "b.ts"] }), ctx(ws));
    assert.ok(r.ok, r.result);
    assert.match(r.result, /--- a\.ts ---/, "each file needs its own header (#16)");
    assert.match(r.result, /--- b\.ts ---/);
    assert.ok(r.result.includes("AAA") && r.result.includes("CCC"), "both bodies present (#16)");
  });
});

test("one unreadable file does not fail the others (#16)", async () => {
  await useTempDirs(["m16g-", "m16h-"], async ([ws]) => {
    await seed(ws);
    const r = await executeTool("read_file", JSON.stringify({ paths: ["a.ts", "nope.ts"] }), ctx(ws));
    assert.ok(r.ok, "the readable file must still come back (#16)");
    assert.ok(r.result.includes("AAA"), "the good file is present (#16)");
    assert.match(r.result, /ERROR.*cannot read nope\.ts/, "the bad file is reported inline (#16)");
  });
});

test("paths is bounded so one call cannot flood the context (#16)", async () => {
  await useTempDirs(["m16i-", "m16j-"], async ([ws]) => {
    await seed(ws);
    const many = Array.from({ length: 11 }, (_, i) => `f${i}.ts`);
    const r = await executeTool("read_file", JSON.stringify({ paths: many }), ctx(ws));
    assert.equal(r.ok, false, "an unbounded paths array is a way to overflow the window (#16)");
    assert.match(r.result, /too many paths/i);
  });
});

test("an empty paths array is refused, not silently a no-op (#16)", async () => {
  await useTempDirs(["m16k-", "m16l-"], async ([ws]) => {
    const r = await executeTool("read_file", JSON.stringify({ paths: [] }), ctx(ws));
    // empty array falls through to the single-path path, which then reports the
    // missing path — either way it must not claim success on nothing
    assert.equal(r.ok, false, "reading nothing must not report success (#16)");
  });
});

test("paths works with the other read options (#16)", async () => {
  await useTempDirs(["m16m-", "m16n-"], async ([ws]) => {
    await seed(ws);
    // pattern mode still applies per file
    const pat = await executeTool(
      "read_file",
      JSON.stringify({ paths: ["a.ts", "b.ts"], pattern: "A|C" }),
      ctx(ws),
    );
    assert.ok(pat.result.includes("--- a.ts ---"));
    // and hashline anchors still render (#7 must not regress)
    const hash = await executeTool(
      "read_file",
      JSON.stringify({ paths: ["a.ts"], line_ids: "hash" }),
      ctx(ws),
    );
    assert.match(hash.result, /\d+:[0-9a-f]{4}\| AAA/, "hashline still works with paths (#7+#16)");
  });
});

/* ---------- fuzzy (#16) ---------- */

test("fuzzyPathMatch matches loosely, ignoring separators and case (#16)", () => {
  assert.equal(fuzzyPathMatch("login", "src/auth/login.ts"), true);
  assert.equal(fuzzyPathMatch("lgn", "src/auth/login.ts"), true, "subsequence, gaps allowed (#16)");
  assert.equal(fuzzyPathMatch("LOGIN", "src/login.ts"), true, "case-insensitive (#16)");
  assert.equal(fuzzyPathMatch("src/auth/login.ts", "src/auth/login.ts"), true);
  assert.equal(fuzzyPathMatch("zzzz", "src/login.ts"), false, "must not match everything (#16)");
  assert.equal(fuzzyPathMatch("", "anything"), false, "an empty query must match nothing (#16)");
});

test("fuzzy finds a nested file the caller could not name exactly (#16)", async () => {
  await useTempDirs(["m16o-", "m16p-"], async ([ws]) => {
    await seed(ws);
    const r = await executeTool("read_file", JSON.stringify({ fuzzy: "login" }), ctx(ws));
    assert.ok(r.ok, r.result);
    assert.ok(r.result.includes("LOGIN"), "the located file must be read (#16)");
  });
});

test("several fuzzy matches are LISTED, not guessed (#16)", async () => {
  await useTempDirs(["m16q-", "m16r-"], async ([ws]) => {
    await seed(ws);
    const r = await executeTool("read_file", JSON.stringify({ fuzzy: "ts" }), ctx(ws));
    assert.ok(r.ok, r.result);
    assert.match(r.result, /match "ts"/, "ambiguity must be reported (#16)");
    assert.ok(r.result.includes("a.ts") && r.result.includes("b.ts"), "candidates listed (#16)");
  });
});

test("fuzzy with no match says so instead of inventing a path (#16)", async () => {
  await useTempDirs(["m16s-", "m16t-"], async ([ws]) => {
    await seed(ws);
    const r = await executeTool("read_file", JSON.stringify({ fuzzy: "zzzznope" }), ctx(ws));
    assert.equal(r.ok, false);
    assert.match(r.result, /no file matches/i);
    assert.match(r.result, /list_dir/, "should point at a way forward (#16)");
  });
});

test("fuzzy skips noise directories (#16)", async () => {
  await useTempDirs(["m16u-", "m16v-"], async ([ws]) => {
    await mkdir(path.join(ws, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(ws, "node_modules", "pkg", "target.ts"), "SHOULD NOT BE FOUND\n");
    const r = await executeTool("read_file", JSON.stringify({ fuzzy: "target" }), ctx(ws));
    assert.equal(r.ok, false, "node_modules must not be searched (#16)");
  });
});

/* ---------- the model has to be told these exist (#16) ---------- */

test("the schema and description expose both features (#16)", () => {
  const spec = toolSpecs().find((t) => t.function.name === "read_file");
  assert.ok(spec, "read_file spec missing");
  const props = spec!.function.parameters.properties as Record<string, unknown>;
  assert.ok("paths" in props, "schema must expose `paths` (#16)");
  assert.ok("fuzzy" in props, "schema must expose `fuzzy` (#16)");
  const desc = spec!.function.description;
  assert.match(desc, /paths/, "the description must mention paths (#16)");
  assert.match(desc, /fuzzy/, "the description must mention fuzzy (#16)");
});
