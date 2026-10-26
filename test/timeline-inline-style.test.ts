import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

const ROW_FILES = ["frontend/components/rows.tsx", "frontend/components/code.tsx"];

test("timeline row components carry no inline styles (#ui)", async () => {
  const ALLOWED_OBJECT_KEYS = /^$NEVER_MATCH$/;
  for (const rel of ROW_FILES) {
    const raw = await readFile(path.join(import.meta.dirname, "..", rel), "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const hits: string[] = [];
    for (const m of src.matchAll(/style=\{?"[^"]+"|style=\{\{[^}]*\}\}/g)) {
      if (ALLOWED_OBJECT_KEYS.test(m[0])) continue; 
      const line = src.slice(0, m.index).split("\n").length;
      hits.push(`${rel}:${line} ${m[0].slice(0, 40)}`);
    }
    assert.deepEqual(
      hits,
      [],
      "an inline style here is re-applied for EVERY row — move it to app.css and use a class " +
        "(a data-driven colour may cross as one custom property)",
    );
  }
});

test("a grouped row dims the DISC, never the glyph (#ui)", async () => {
  const css = await readFile(path.join(import.meta.dirname, "..", "frontend/app.css"), "utf8");
  const at = css.indexOf(".avatar.ghosted");
  assert.ok(at > 0, "the grouped-avatar rule must exist");
  const rule = css.slice(at, css.indexOf("}", at));
  assert.doesNotMatch(
    rule,
    /opacity\s*:/,
    "dimming the disc is done with colour — `opacity` here also fades the emoji (#ui)",
  );
  assert.match(rule, /background|border|transition/, "and it must actually dim something");
});
