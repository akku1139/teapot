/**
 * #139 — comments must not cite a bare `file:line`.
 *
 * Every citation this file was created for had rotted. Verified against the code:
 *
 *     master.ts:1100  ->  if (parentId) this.wakeParentWaiters(parentId);
 *     master.ts:979   ->  ids: string[] | undefined,
 *     master.ts:782   ->  }
 *     api.ts:803      ->  (a different filter than the one described)
 *     agent.ts:570    ->  (isLive() had moved to 592)
 *
 * i.e. they pointed at unrelated code and nobody noticed, because a wrong line
 * number in a comment fails silently — unlike a wrong assertion.
 *
 * Anchors are now SYMBOLS (`master.ts spawnChildFor`), which move with the code
 * they describe. One exception is allowed: a `src/...ts:42` that appears inside a
 * string literal is TEST DATA, not a citation.
 *
 * This file used to also hold the #126 error-message assertions. Those read
 * `tools.ts` / `api.ts` / `master.ts` as TEXT and matched regexes against it,
 * which pins the SPELLING of code that has to work at runtime, so they were
 * deleted. Those messages are observable through
 * `test/api-contract-behaviour.test.ts`, which makes real requests against the
 * same 400/404 paths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("no source comment cites a bare file:line (#139)", async () => {
  const { readdirSync } = await import("node:fs");
  const { fileURLToPath: f2p } = await import("node:url");
  const { readSource } = await import("./helpers/source.ts");

  const files: string[] = [];
  for (const dir of ["../src", "../frontend", "."]) {
    const base = f2p(new URL(`${dir}/`, import.meta.url));
    const walk = (d: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name === "helpers" || e.name === "node_modules") continue;
          out.push(...walk(p));
        } else if (/\.tsx?$/.test(e.name)) out.push(p);
      }
      return out;
    };
    files.push(...walk(base));
  }
  assert.ok(files.length > 10, `precondition: the scan found source (#139); ${files.length} files`);

  const offenders: string[] = [];
  const cite = /`?\b([a-zA-Z][\w.-]*\.tsx?):(\d+)\b/g;
  // this file necessarily contains the pattern it searches for
  const SELF = "error-message-quality.test.ts";
  for (const f of files) {
    if (f.endsWith(SELF)) continue;
    readSource(f)
      .split("\n")
      .forEach((l, i) => {
        const t = l.trim();
        if (!t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) return;
        // strip string literals: data inside them is not a citation
        const noStrings = t.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""');
        if (cite.test(noStrings)) offenders.push(`${f.replace(/^.*\/(src|frontend|test)\//, "$1/")}:${i + 1}`);
        cite.lastIndex = 0;
      });
  }
  assert.deepEqual(
    offenders,
    [],
    `these comments cite a line number, which rots silently (#139): ${offenders.join(", ")}`,
  );
});
