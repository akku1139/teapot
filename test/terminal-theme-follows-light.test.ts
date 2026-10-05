/**
 * #137 — "the terminal prompt is white and invisible in the light theme."
 *
 * ## Cause
 *
 * Every theme DOES define the terminal palette:
 *
 *     [data-theme="light"] { --term-bg: #ffffff; --term-fg: #24272f; … }
 *
 * and `themeColors()` reads those variables. But it is called ONCE, in xterm's
 * constructor, and xterm CACHES the palette it is given. So switching theme
 * updated the CSS variables — repainting every other surface — while each open
 * terminal kept the palette it was born with: light grey text on a background
 * that had become white.
 *
 * Two fixes, because there are two ways to reach the bug:
 *
 *  1. `retintTerminal()` on the REUSE path in `ensureSession()` — this is the path
 *     taken when the panel is closed and reopened, which is when a user would
 *     first notice it had "fixed itself".
 *  2. a `createEffect` that re-themes terminals ALREADY OPEN — without this the
 *     user changes theme and sees nothing happen at all until they remount.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readSource(path.join(here, "..", "frontend", "App.tsx"));
const css = readSource(path.join(here, "..", "frontend", "app.css"));

test("every light theme defines a terminal palette (#137)", () => {
  // the cause was NOT a missing variable — confirm they are all present, so this
  // cannot be "fixed" again by adding one
  const light = [...css.matchAll(/\[data-theme="([^"]+)"\][^}]*\{([^}]*)\}/g)]
    .filter(([, , body]) => body.includes("--term-bg"))
    .map(([, key]) => key);
  assert.ok(light.length > 0, "at least one themed block must set --term-bg (#137)");
  for (const key of light) {
    const block = new RegExp(`\\[data-theme="${key}"\\][^}]*\\{[^}]*\\}`).exec(css)?.[0] ?? "";
    assert.match(block, /--term-fg:\s*#[0-9a-f]{3,8}/i, `${key} must define --term-fg (#137)`);
  }
});

test("the light theme's terminal text is dark enough to read (#137)", () => {
  // the reported symptom: white-on-white. Assert the fg is actually dark for a
  // light background, rather than trusting that a light theme exists
  const m = /\[data-theme="light"\][^}]*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const bg = /--term-bg:\s*(#[0-9a-f]{3,8})/i.exec(m)?.[1];
  const fg = /--term-fg:\s*(#[0-9a-f]{3,8})/i.exec(m)?.[1];
  assert.ok(bg && fg, `light must define both (#137): bg=${bg} fg=${fg}`);
  const lum = (hex: string) => {
    const v = hex.length === 4
      ? [1, 2, 3].map((i) => parseInt(hex[i]! + hex[i]!, 16))
      : [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [r, g, b] = v.map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (Math.max(lum(bg!), lum(fg!)) + 0.05) / (Math.min(lum(bg!), lum(fg!)) + 0.05);
  assert.ok(contrast >= 4.5, `terminal text must be readable (#137); contrast ${contrast.toFixed(2)}`);
});

test("an already-open terminal is re-themed on a theme change (#137)", () => {
  const at = app.indexOf("for (const [, s] of liveTerms) retintTerminal(s);");
  assert.notEqual(at, -1, "an effect must re-theme open terminals (#137)");
  // it must be inside a createEffect that READS the theme signals, or it will
  // never re-run
  const before = app.lastIndexOf("createEffect(", at);
  assert.ok(before !== -1 && at > before, "it must be inside a createEffect (#137)");
  const block = app.slice(before, at);
  for (const sig of ["themeAuto()", "fixedTheme()", "sysPrefersLight()"]) {
    assert.match(block, new RegExp(sig.replace(/[()]/g, "\\$&")), `must read ${sig} to subscribe (#137)`);
  }
});

test("reusing a session re-themes it too (#137)", () => {
  // closing and reopening the panel must not resurrect the old palette
  const at = app.indexOf("if (s) retintTerminal(s);");
  assert.notEqual(at, -1, "the reuse path must re-theme (#137)");
});

test("retintTerminal assigns options.theme (#137)", () => {
  const at = app.indexOf("function retintTerminal");
  assert.notEqual(at, -1, "the helper must exist (#137)");
  const body = app.slice(at, app.indexOf("\n  }\n", at));
  assert.match(body, /s\.term\.options\.theme = want;/, "xterm re-themes via options.theme (#137)");
  // and it must not write when nothing changed — the effect runs on every theme
  // signal read, so an unconditional write would churn on unrelated re-renders
  assert.match(body, /if \(cur && cur\.background === want\.background/, "skip when unchanged (#137)");
});
