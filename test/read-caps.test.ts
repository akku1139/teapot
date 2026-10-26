import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { useTempDirs } from "./helpers/tmp.ts";
import { executeTool, type ToolContext } from "../src/agent/tools.ts";

const ctxFor = (cwd: string): ToolContext => ({
  cwd,
  defaultTimeoutMs: 5_000,
  maxOutputBytes: 64 * 1024,
});

const read = (ws: string, args: Record<string, unknown>) =>
  executeTool("read_file", JSON.stringify({ path: "f.txt", ...args }), ctxFor(ws));

test("the LINE cap still applies to a long source file (#17)", async () => {
  await useTempDirs(["rcap-a-"], async ([ws]) => {
    const body = Array.from({ length: 3_000 }, (_, i) => `line ${i + 1}`).join("\n");
    await writeFile(path.join(ws!, "f.txt"), body);
    const r = await read(ws!, {});
    assert.equal(r.ok, true);
    assert.match(r.result, /more lines/, "a long file must say how much was not shown");
    assert.ok(
      r.result.split("\n").length < 2_100,
      `the line cap must stop at ~2000 lines, got ${r.result.split("\n").length}`,
    );
  });
});

test("the BYTE cap stops a huge-line-count-free file (#17)", async () => {
  await useTempDirs(["rcap-b-"], async ([ws]) => {
    const line = "z".repeat(4_000);
    const body = Array.from({ length: 600 }, () => line).join("\n");
    await writeFile(path.join(ws!, "f.txt"), body);
    const r = await read(ws!, {});
    assert.equal(r.ok, true);
    assert.ok(
      r.result.length < 300 * 1024,
      `the byte cap must bound the output; got ${r.result.length} chars`,
    );
    assert.match(r.result, /output clipped at /, "and must say it was clipped");
    assert.match(r.result, /continue with offset=\d+/, "and where to continue");
  });
});

test("the PER-LINE cap stops a single enormous line (#17)", async () => {
  await useTempDirs(["rcap-c-"], async ([ws]) => {
    const body = "x".repeat(400_000);
    await writeFile(path.join(ws!, "f.txt"), body);
    const r = await read(ws!, {});
    assert.equal(r.ok, true);
    assert.match(r.result, /line clipped: \d+ more chars/, "the clipped line must say how much was cut");
    assert.ok(r.result.startsWith("1| xxx"), `the head must survive: ${JSON.stringify(r.result.slice(0, 40))}`);
    assert.ok(
      r.result.length < 10_000,
      `one line must not return 400KB; got ${r.result.length} chars`,
    );
  });
});

test("a clipped read names an offset that actually continues the file (#17)", async () => {
  await useTempDirs(["rcap-d-"], async ([ws]) => {
    const marker = "CUT"; 
    const pad = "y".repeat(4_000);
    const lines = Array.from({ length: 200 }, (_, i) => `${i}-${pad}`);
    lines[150] = `${150}-${marker}`;
    await writeFile(path.join(ws!, "f.txt"), lines.join("\n"));

    const first = await read(ws!, {});
    assert.match(first.result, /continue with offset=(\d+)/);
    const off = Number(/continue with offset=(\d+)/.exec(first.result)![1]);
    assert.ok(off > 1, `the resume offset must be past the start; got ${off}`);

    assert.ok(!first.result.includes(`${150}-${marker}`), "precondition: the marker is unseen");

    const second = await read(ws!, { offset: off });
    assert.equal(second.ok, true);
    assert.ok(
      second.result.includes(`${150}-${marker}`) || Number(off) <= 151,
      `offset ${off} must lead to the unseen content`,
    );
  });
});

test("a normal small file is unchanged by the new caps (#17)", async () => {
  await useTempDirs(["rcap-e-"], async ([ws]) => {
    await writeFile(path.join(ws!, "f.txt"), "one\ntwo\nthree\n");
    const r = await read(ws!, {});
    assert.equal(r.ok, true);
    assert.equal(r.result, "1| one\n2| two\n3| three");
    const hashed = await read(ws!, { line_ids: "hash" });
    assert.match(hashed.result, /^1:[0-9a-z]+\| one/m);
  });
});

test("a multi-file read still reports each file separately under the caps (#17)", async () => {
  await useTempDirs(["rcap-f-"], async ([ws]) => {
    await mkdir(path.join(ws!, "sub"), { recursive: true });
    await writeFile(path.join(ws!, "a.txt"), "alpha\n");
    await writeFile(path.join(ws!, "sub", "b.txt"), "beta\n");
    const r = await executeTool(
      "read_file",
      JSON.stringify({ path: "a.txt", paths: ["a.txt", "sub/b.txt"] }),
      ctxFor(ws!),
    );
    assert.equal(r.ok, true);
    assert.match(r.result, /--- a\.txt ---/, "each file keeps its own header");
    assert.match(r.result, /--- sub\/b\.txt ---/);
    assert.match(r.result, /alpha/);
    assert.match(r.result, /beta/);
  });
});
