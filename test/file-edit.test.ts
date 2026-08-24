import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function mkMaster(dataDir: string): Master {
  return new Master(
    { port: 0, dataDir, llm: LLM, providers: {}, agents: [] },
    "/dev/null",
  );
}

test("PUT /api/agents/:id/file — write, create, conflict, binary, escape", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "fileedit-root-"));
  const ws = await mkdtemp(path.join(tmpdir(), "fileedit-ws-"));
  const m = mkMaster(dataDir);
  const app = buildApp(m);

  const r1 = await app.request("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: ws, id: "ed", start: false }),
  });
  assert.equal(r1.status, 200);
  await m.agents.get("ed")!.dispose(); // this suite never talks to an LLM

  const put = (p: string, body: unknown) =>
    app.request(`/api/agents/ed/file?path=${encodeURIComponent(p)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // 1. overwrite an existing file
  await writeFile(path.join(ws, "a.txt"), "old\n");
  let r = await put("a.txt", { content: "new content\n" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, path: "a.txt", size: "new content\n".length });
  assert.equal(await readFile(path.join(ws, "a.txt"), "utf8"), "new content\n");

  // 2. baseContent matching → allowed
  r = await put("a.txt", { content: "v2\n", baseContent: "new content\n" });
  assert.equal(r.status, 200);
  assert.equal(await readFile(path.join(ws, "a.txt"), "utf8"), "v2\n");

  // 3. baseContent stale → 409 with the current disk content
  r = await put("a.txt", { content: "clobber!\n", baseContent: "old and wrong\n" });
  assert.equal(r.status, 409);
  const conflict = (await r.json()) as { error: string; current: string };
  assert.equal(conflict.error, "file changed on disk");
  assert.equal(conflict.current, "v2\n"); // disk untouched
  assert.equal(await readFile(path.join(ws, "a.txt"), "utf8"), "v2\n");

  // 4. create a new file (nested dir included)
  r = await put("sub/dir/new.md", { content: "# hello\n" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).size, "# hello\n".length);
  assert.equal(await readFile(path.join(ws, "sub/dir/new.md"), "utf8"), "# hello\n");

  // 5. binary file refused
  const bin = Buffer.from([0x50, 0x4b, 0x00, 0x00, 0x01]);
  await mkdir(path.join(ws, "bin"), { recursive: true });
  await writeFile(path.join(ws, "bin/data.bin"), bin);
  r = await put("bin/data.bin", { content: "text" });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /binary/);

  // 6. workspace escape refused
  r = await put("../outside.txt", { content: "nope" });
  assert.equal(r.status, 400);

  // 7. missing content → 400
  r = await put("a.txt", {});
  assert.equal(r.status, 400);

  // unknown agent → 404
  const r404 = await app.request("/api/agents/nope/file?path=a.txt", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "x" }),
  });
  assert.equal(r404.status, 404);
});

test("GET /raw serves media bytes with correct mime; rejects non-media", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "raw-root-"));
  const ws = await mkdtemp(path.join(tmpdir(), "ws-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(ws, "pic.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  await writeFile(path.join(ws, "note.txt"), "hello");
  const m = mkMaster(dataDir);
  const app = buildApp(m);
  const mkAgent = await app.request("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: ws, id: "med", start: false }),
  });
  assert.equal(mkAgent.status, 200);

  const img = await app.request("/api/agents/med/raw?path=pic.png");
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  const buf = new Uint8Array(await img.arrayBuffer());
  assert.equal(buf[0], 0x89); // PNG magic

  const txt = await app.request("/api/agents/med/raw?path=note.txt");
  assert.equal(txt.status, 400); // not a previewable media kind

  const missing = await app.request("/api/agents/med/raw?path=nope.png");
  assert.equal(missing.status, 400);

  for (const a of m.agents.values()) await a.dispose();
});
