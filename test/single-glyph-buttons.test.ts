/**
 * A button whose label is ONE GLYPH must be square, which means `.iconbtn`.
 *
 * The operator's proposal, after a global height fix left two of them rectangular: "1文字のをlintで検出の方がまだマシ". A
 * glyph-sized button without the class takes its width from padding, so `✕` in a `.cfgrow` came out 31x26 — and the next
 * one added will do the same. This is a lint, not a behaviour test: it reads the JSX for the SHAPE that produces the bug, and
 * the square geometry itself is verified in a real browser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

/** A label that is one visible glyph: at most two code points, no letters or digits (so "on"/"×2" are not matched). */
const ONE_GLYPH = /^[^\p{L}\p{N}\s]{1,2}$/u;

test("every one-glyph button carries .iconbtn (#254)", () => {
  const offenders: string[] = [];
  for (const file of tsxFiles(path.join(ROOT, "frontend"))) {
    const src = readFileSync(file, "utf8");
    // <button …>GLYPH</button>, allowing attributes across lines
    // the attribute run may contain `>` inside a `{…}` expression (`onclick={() => …}`), so it is parsed brace-aware
    for (const m of src.matchAll(/<button\b((?:[^>{}]|\{[^}]*\})*)>([^<>{}]{1,4})<\/button>/g)) {
      const [, attrs, rawLabel] = m as unknown as [string, string, string];
      const label = rawLabel.trim();
      if (!ONE_GLYPH.test(label)) continue;
      if (/\bclass="[^"]*\biconbtn\b/.test(attrs) || /class=\{[^}]*iconbtn/.test(attrs)) continue;
      /**
       * The two deliberate mini glyphs: a 16px ✕ on a thumbnail and a 16px ✕ in a terminal tab. Both live in a
       * 16px-tall strip where the standard 26px square would not fit, and both have their own rule that makes them
       * square at THAT size.
       */
      if (/\bclass="[^"]*\b(imgx|tabx)\b/.test(attrs)) continue;
      offenders.push(`${path.relative(ROOT, file)}: ${label}`);
    }
  }
  assert.deepEqual(offenders, [], `a one-glyph button takes its width from padding unless it is .iconbtn:\n  ${offenders.join("\n  ")}`);
});

test("the lint would actually catch a splash of one-glyph button (#254)", () => {
  // positive control: without this, a regex that matches nothing passes forever
  const sample = `<button type="button" class="danger" onclick={() => go()}>✕</button>`;
  const found = [...sample.matchAll(/<button\b((?:[^>{}]|\{[^}]*\})*)>([^<>{}]{1,4})<\/button>/g)]
    .map(([, attrs, label]) => ({ attrs: attrs!, label: label!.trim() }))
    .filter(({ label }) => ONE_GLYPH.test(label));
  assert.equal(found.length, 1, "the pattern must see this shape");
  assert.ok(!/\biconbtn\b/.test(found[0]!.attrs), "and it must recognise the missing class");
});
