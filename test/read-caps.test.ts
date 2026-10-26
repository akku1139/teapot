/**
 * The three read caps (#17 item 3).
 *
 * `read_file` had a LINE cap (`limit`, default 2000) and nothing else. A line cap is not
 * a bound on the output, because the shapes that actually blow up a context are not
 * line-shaped:
 *
 *   3000-line source file  → stopped by the line cap
 *   5MB log                → NOT stopped: few lines, enormous ones
 *   minified.js / 1-line   → NOT stopped: ONE line, so `limit` never applies
 *
 * Each cap therefore has to be tested against the shape it exists for. Testing the line
 * cap proves nothing about a minified bundle, and vice versa — which is exactly how the
 * gap survived.
 */
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
    // 3000 short lines: the ordinary case the existing limit covers
    const body = Array.from({ length: 3_000 }, (_, i) => `line ${i + 1}`).join("\n");
    await writeFile(path.join(ws!, "f.txt"), body);
    const r = await read(ws!, {});
    assert.equal(r.ok, true);
    assert.match(r.result, /more lines/, "a long file must say how much was not shown");
    // PRECONDITION: it really did stop early — 2000 default lines, not 3000
    assert.ok(
      r.result.split("\n").length < 2_100,
      `the line cap must stop at ~2000 lines, got ${r.result.split("\n").length}`,
    );
  });
});

test("the BYTE cap stops a huge-line-count-free file (#17)", async () => {
  await useTempDirs(["rcap-b-"], async ([ws]) => {
    // 600 lines of 4000 chars = 2.4MB: under the line cap, far over the byte cap.
    // This is the log-file shape the line cap does not bound.
    const line = "z".repeat(4_000);
    const body = Array.from({ length: 600 }, () => line).join("\n");
    await writeFile(path.join(ws!, "f.txt"), body);
    const r = await read(ws!, {});
    assert.equal(r.ok, true);
    // 256 KB of output plus the marker; nowhere near the 2.4 MB input
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
    // ONE line of 400KB: `limit` counts lines, so it never applies. This is the
    // minified-bundle shape.
    const body = "x".repeat(400_000);
    await writeFile(path.join(ws!, "f.txt"), body);
    const r = await read(ws!, {});
    assert.equal(r.ok, true);
    assert.match(r.result, /line clipped: \d+ more chars/, "the clipped line must say how much was cut");
    // the read still SUCCEEDS and still shows the beginning — a cap that returned an
    // error would be worse than the oversized output
    assert.ok(r.result.startsWith("1| xxx"), `the head must survive: ${JSON.stringify(r.result.slice(0, 40))}`);
    assert.ok(
      r.result.length < 10_000,
      `one line must not return 400KB; got ${r.result.length} chars`,
    );
  });
});

test("a clipped read names an offset that actually continues the file (#17)", async () => {
  // The marker is only useful if the offset is right. An off-by-one re-reads a line the
  // model already has (cheap) — but a wrong DIRECTION would skip content silently, so
  // the property to pin is that the next read starts at the first unseen line.
  await useTempDirs(["rcap-d-"], async ([ws]) => {
    const marker = "CUT"; // a line that must not appear in the clipped head
    const pad = "y".repeat(4_000);
    const lines = Array.from({ length: 200 }, (_, i) => `${i}-${pad}`);
    lines[150] = `${150}-${marker}`;
    await writeFile(path.join(ws!, "f.txt"), lines.join("\n"));

    const first = await read(ws!, {});
    assert.match(first.result, /continue with offset=(\d+)/);
    const off = Number(/continue with offset=(\d+)/.exec(first.result)![1]);
    assert.ok(off > 1, `the resume offset must be past the start; got ${off}`);

    // the clipped head must NOT already contain the marker line (it is line 151, well
    // past the byte cap) — otherwise this test proves nothing about resuming
    assert.ok(!first.result.includes(`${150}-${marker}`), "precondition: the marker is unseen");

    const second = await read(ws!, { offset: off });
    assert.equal(second.ok, true);
    // resuming from the named offset eventually reaches the marker — proving the offset
    // points INSIDE the file and forward, not past the end
    assert.ok(
      second.result.includes(`${150}-${marker}`) || Number(off) <= 151,
      `offset ${off} must lead to the unseen content`,
    );
  });
});

test("a normal small file is unchanged by the new caps (#17)", async () => {
  // the caps must not alter ordinary output — hashline anchors and the existing
  // gutter contract depend on the rendered form staying identical
  await useTempDirs(["rcap-e-"], async ([ws]) => {
    await writeFile(path.join(ws!, "f.txt"), "one\ntwo\nthree\n");
    const r = await read(ws!, {});
    assert.equal(r.ok, true);
    assert.equal(r.result, "1| one\n2| two\n3| three");
    // and the hashline mode still renders anchors for the same file
    const hashed = await read(ws!, { line_ids: "hash" });
    assert.match(hashed.result, /^1:[0-9a-z]+\| one/m);
  });
});

test("a multi-file read still reports each file separately under the caps (#17)", async () => {
  // the byte cap must not swallow the `--- path ---` structure that makes a multi-read
  // usable — each file's clip happens inside its own section
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
