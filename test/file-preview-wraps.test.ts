import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("frontend/app.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string): string => {
  const bodies: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = m[1]!.split(",").map((s) => s.trim());
    if (selectors.includes(selector)) bodies.push(m[2]!);
  }
  return bodies.join("\n");
};

test("the preview container does not scroll horizontally (#files)", () => {
  const body = rule(".filepreview");
  assert.ok(body, ".filepreview must have its own rule");
  assert.match(body, /overflow-x:\s*hidden/, "the container must not scroll sideways (#files)");
  assert.match(body, /overflow-y:\s*auto|overflow:\s*auto/, "but a long file must still scroll vertically");
});

test("shiki's own pre and code are told to wrap (#files)", () => {
  const wrapped = [".filepreview .shiki pre", ".filepreview .shiki code"];
  for (const sel of wrapped) {
    const body = rule(sel);
    assert.ok(body, `${sel} must be styled, or shiki's own defaults win (#files)`);
    assert.match(body, /white-space:\s*pre-wrap/, `${sel} must wrap (#files)`);
  }
});

test("the code element is a BLOCK with min-width 0 — the reason it scrolled (#files)", () => {
  const body = rule(".filepreview .shiki code") + rule(".filepreview code.shiki");
  assert.match(body, /display:\s*block/, "an inline <code> has no box to wrap in — MEASURED clientWidth 0 (#files)");
  assert.match(body, /min-width:\s*0/, "and a flex/grid ancestor must be allowed to shrink it (#files)");
});

test("the code background is the THEME's surface, never shiki's white (#files)", () => {
  const container = rule(".filepreview");
  assert.match(container, /background:\s*var\(--bg/, "the preview must paint a theme surface (#files)");

  const shikiBg = [...css.matchAll(/([^{}]*\.filepreview[^{}]*\.shiki[^{}]*)\{([^}]*)\}/g)]
    .filter((m) => /background-color/.test(m[2]!))
    .map((m) => m[2]!)
    .join("\n");
  assert.match(shikiBg, /background-color:\s*transparent/, "shiki's own background must be transparent (#files)");
  assert.match(shikiBg, /!important/, "it is an inline style on the element, so the rule must win (#files)");
});
