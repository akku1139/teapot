import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

/**
 * A timeline ROW must not carry an inline `style`.
 *
 * Each `style="…"` on a row element is parsed and applied again for every row the feed creates,
 * and this feed holds ~1,100 rows on open. What reads like a one-off is actually per-row work, so
 * row details belong in the stylesheet where they are parsed once.
 *
 * Only the row components are checked. A static `style` on a one-off panel is a fine trade against
 * inventing a class for it — that is a judgement call, not a rule.
 */
const ROW_FILES = ["frontend/components/rows.tsx", "frontend/components/code.tsx"];

test("timeline row components carry no inline styles (#ui)", async () => {
  for (const rel of ROW_FILES) {
    const src = await readFile(path.join(import.meta.dirname, "..", rel), "utf8");
    const hits = [...src.matchAll(/style=\{?"[^"]+"/g)].map((m) => {
      const line = src.slice(0, m.index).split("\n").length;
      return `${rel}:${line}`;
    });
    assert.deepEqual(
      hits,
      [],
      "an inline style here is re-applied for EVERY row — move it to app.css and use a class",
    );
  }
});
