/**
 * #110 — four routes return 500 on a malformed body where their siblings
 * return 400.
 *
 * `api.ts` reads request bodies two ways. Most routes do
 *
 *     const body = await c.req.json<T>().catch(() => null);
 *     if (!body) return c.json({ error: "invalid JSON" }, 400);
 *
 * but four call `c.req.json()` with no `.catch()`. A malformed body then throws
 * inside the handler, and with no `app.onError` anywhere the client gets a bare
 * 500. The tell is that `POST /api/agents/:id/todo` — the same shape of request —
 * answers 400 correctly.
 *
 * Severity is LOW and deliberately described as such: the process does not crash
 * (Hono contains it; two malformed requests in a row still 500, and a subsequent
 * `GET /api/version` still returns 200). The cost is diagnostic — a client bug is
 * reported to the operator as a server fault, and `POST /api/agents`'s own
 * `400 "workspace required"` path is unreachable when the body is unparseable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const api = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");

/** every `await c.req.json...` call in the file, with whether it is guarded */
function bodyReads(): { line: number; guarded: boolean; text: string }[] {
  const out: { line: number; guarded: boolean; text: string }[] = [];
  const lines = api.split("\n");
  lines.forEach((raw, i) => {
    if (!/await c\.req/.test(raw) || !/\.json/.test(raw + (lines[i + 1] ?? ""))) return;
    // `.catch(` can sit several lines below, because a multi-line generic
    // (`c.req.json<{ ... }>()`) pushes it down. One line of lookahead found the
    // guards on the SAME line only and reported guarded reads as unguarded.
    const window = lines.slice(i, i + 10).join("\n");
    const guarded = /\.catch\(/.test(window);
    out.push({ line: i + 1, guarded, text: raw.trim() });
  });
  return out;
}

test("every request-body read is guarded against malformed JSON (#110)", () => {
  const reads = bodyReads();
  assert.ok(reads.length >= 8, `precondition: found the body reads (#110); got ${reads.length}`);
  const unguarded = reads.filter((r) => !r.guarded);
  assert.deepEqual(
    unguarded.map((r) => r.line),
    [],
    `an unguarded c.req.json() turns a client bug into a 500 (#110): lines ${unguarded
      .map((r) => r.line)
      .join(", ")}`,
  );
});

test("each unguarded route is one of the four named in the report (#110)", () => {
  // pinned so a FUTURE unguarded read is a new finding, not a silent addition
  const unguarded = bodyReads().filter((r) => !r.guarded).map((r) => r.line);
  assert.deepEqual(unguarded, [], `no unguarded body reads may remain (#110); got ${JSON.stringify(unguarded)}`);
});

/*
 * REMOVED, and replaced by test/api-contract-behaviour.test.ts.
 *
 *   "an unparseable body answers 400 with a message, not 500" — matched the SOURCE
 *   for the 400 line. Mutation proved it blind: rewriting that line to return
 *   200 left the whole suite green. The test was named "the behaviour itself" and
 *   never issued a request.
 *
 *   "the four routes still validate their own fields" — asserted three error
 *   STRINGS appear somewhere in a 1,000-line file. Rewriting the guard so an empty
 *   prompt is accepted also left the suite green.
 *
 * Both now make real requests, and each mutation fails 1-2 assertions.
 *
 * The two tests that remain below — the sweep for unguarded `c.req.json()` reads,
 * and the check that no `app.onError` masks the status — are STRUCTURAL on purpose:
 * they exist to catch a NEW unguarded read anywhere in the file, which a
 * hand-written behavioural test for four known routes cannot do.
 */

test("no app.onError was masking this as a 500 (#110)", () => {
  // if one is ever added, the four routes become lower priority — but they would
  // still return the wrong STATUS, so this test stays as documentation
  assert.doesNotMatch(api, /app\.onError\(/, "there is still no global error handler (#110)");
});
