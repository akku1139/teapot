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
  /**
   * THREE spellings, and the old check matched only the first two.
   *
   *     style="a:b"        literal
   *     style={"a:b"}      expression wrapping a literal
   *     style={{ a: b }}   OBJECT — this is what Solid actually emitted
   *
   * The regex was `/style=\{?"[^"]+"/`, so every `style={{…}}` was invisible to it. MEASURED: two
   * real violations (the actor avatar and the author name) were sitting in `rows.tsx` while this
   * test was green — the exact failure mode it exists to prevent, in the test itself.
   *
   * A data-driven value may cross as a CUSTOM PROPERTY (`style={{ "--author": colour }}`): that is
   * one property for a value the stylesheet cannot know, not a style block re-applied per row.
   */
  /**
   * NOTHING is allowed now, and the custom-property exception is gone with its last user.
   *
   * `style={{ "--author": colour }}` was sanctioned here as "one property is not a style block".
   * It was still an inline style on an element created once per row — ~1,100 of them when a session
   * opens — and the palette is a fixed set, so `toneOf()` maps it to a class instead. MEASURED after:
   * zero `[style]` elements inside the feed.
   */
  const ALLOWED_OBJECT_KEYS = /^$NEVER_MATCH$/;
  for (const rel of ROW_FILES) {
    const raw = await readFile(path.join(import.meta.dirname, "..", rel), "utf8");
    // strip comments: a fix's own explanation quotes the code it replaced
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const hits: string[] = [];
    for (const m of src.matchAll(/style=\{?"[^"]+"|style=\{\{[^}]*\}\}/g)) {
      if (ALLOWED_OBJECT_KEYS.test(m[0])) continue; // a single custom property is the sanctioned form
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
  /**
   * `opacity` on `.avatar.ghosted` faded the emoji along with the circle. The operator's point:
   * fading the circle is right, fading the character is not — a lighter emoji is just a worse
   * emoji, not a quieter row.
   */
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
