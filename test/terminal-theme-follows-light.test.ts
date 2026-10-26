/**
 * #137 — "the terminal prompt is white and invisible in the light theme".
 *
 * Replaces a file that had become pure documentation: it read `App.tsx` into an unused const and
 * contained no `test()` at all, so it protected nothing while looking like coverage. The behaviour
 * it described is testable by PRODUCTION IMPORT (this module is deliberately DOM-light: plain
 * structural types, no solid, no xterm), which is the point — a source-text assertion could not see
 * whether the cursor was ever SENT, and the cursor was exactly the field the light theme lost.
 *
 * Two reachable paths, both fixed:
 *
 *   1. `retintTerminal()` on the REUSE path — when the panel is closed and reopened, which is when
 *      the operator would first notice it had "fixed itself".
 *   2. a `createEffect` that re-themes terminals ALREADY OPEN — without it, changing the theme did
 *      nothing until the terminal was remounted.
 *
 * Path 2 lives in App.tsx and belongs in the smoke harness (it needs the real bundle). What is
 * asserted here is the contract path 2 calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { themeColors, retintTerminal, type XtermLike } from "../frontend/lib/terminal-theme.ts";

/** a fake session, which is all `retintTerminal` touches */
const fake = (theme?: Record<string, string>): XtermLike => ({ options: { theme } });

/** put the theme's variables on a fake document so `themeColors()` has something to read */
function withVars(vars: Record<string, string>, fn: () => void): void {
  const g = globalThis as { document?: unknown };
  const prev = g.document;
  g.document = {
    documentElement: {
      style: {},
    },
  };
  // happy-dom is not loaded here; stub getComputedStyle for this module's one call
  const prevGCS = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (() => ({
    getPropertyValue: (n: string) => vars[n] ?? "",
  })) as unknown as typeof globalThis.getComputedStyle;
  try {
    fn();
  } finally {
    globalThis.getComputedStyle = prevGCS;
    if (prev === undefined) delete g.document;
    else g.document = prev;
  }
}

test("a light theme's terminal gets an explicit, visible cursor (#137)", async () => {
  /**
   * `cursor` is the field a light theme loses: xterm's default cursor does not follow the palette,
   * so a near-black caret sat on a near-white background and the operator could not see where they
   * were typing. It must be SENT, not left to the library.
   */
  await withVars(
    { "--term-bg": "#ffffff", "--term-fg": "#173342" },
    () => {
      const c = themeColors();
      assert.equal(c.background, "#ffffff");
      assert.equal(c.foreground, "#173342");
      assert.equal(c.cursor, "#173342", "the cursor follows the foreground, so it is visible on white");
      assert.equal(c.cursorAccent, "#ffffff", "and the accent is the background, for contrast under the caret");
    },
  );
});

test("the cursor can be overridden per theme, and still defaults sanely (#137)", async () => {
  await withVars(
    { "--term-bg": "#000", "--term-fg": "#fff", "--term-cursor": "#f0f", "--term-cursor-accent": "#0f0" },
    () => {
      const c = themeColors();
      assert.equal(c.cursor, "#f0f", "a theme that names an accent caret keeps it");
      assert.equal(c.cursorAccent, "#0f0");
    },
  );
  // with no document at all (a non-DOM caller) the dark fallbacks apply rather than throwing
  await withVars({}, () => {
    const c = themeColors();
    assert.ok(c.background && c.foreground, "there must always be a palette to apply");
    assert.equal(c.cursor, c.foreground, "the default caret is the foreground");
  });
});

test("re-theming a live terminal is a single write, and is skipped when nothing changed (#137)", async () => {
  /**
   * The caller's effect runs on ANY theme signal read, so an unconditional write would churn on
   * unrelated re-renders — and xterm re-renders the whole viewport on a theme assignment.
   */
  await withVars({ "--term-bg": "#111", "--term-fg": "#eee" }, () => {
    const s = fake();
    retintTerminal(s);
    assert.equal(s.options.theme?.background, "#111", "a fresh session receives the palette");

    // a second call with the same palette must not reassign (identity is unchanged)
    const first = s.options.theme;
    retintTerminal(s);
    assert.equal(s.options.theme, first, "an unchanged palette must not churn the terminal");
  });
});

test("a theme that predates the CURSOR fields is still retinted (#137)", async () => {
  /**
   * THE BUG: a session themed before the cursor fields existed matched bg/fg, so an early-return
   * left a caret from the other mode forever — which is why the symptom appeared only for terminals
   * that had already been open when the theme changed.
   */
  await withVars({ "--term-bg": "#fff", "--term-fg": "#111" }, () => {
    const stale = fake({ background: "#fff", foreground: "#111" }); // no cursor keys at all
    retintTerminal(stale);
    assert.equal(
      stale.options.theme?.cursor,
      "#111",
      "the comparison must cover the cursor fields, or a stale caret survives the theme change",
    );
    assert.equal(stale.options.theme?.cursorAccent, "#fff");
  });
});

test("a caret left over from the OTHER mode is corrected (#137)", async () => {
  // same bg/fg, wrong cursor: the case a bg/fg-only comparison silently accepted
  await withVars({ "--term-bg": "#fff", "--term-fg": "#111" }, () => {
    const wrong = fake({ background: "#fff", foreground: "#111", cursor: "#000", cursorAccent: "#fff" });
    retintTerminal(wrong);
    assert.equal(wrong.options.theme?.cursor, "#111", "the stale caret is replaced");
  });
});
