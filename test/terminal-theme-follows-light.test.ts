import { test } from "node:test";
import assert from "node:assert/strict";
import { themeColors, retintTerminal, type XtermLike } from "../frontend/lib/terminal-theme.ts";

const fake = (theme?: Record<string, string>): XtermLike => ({ options: { theme } });

function withVars(vars: Record<string, string>, fn: () => void): void {
  const g = globalThis as { document?: unknown };
  const prev = g.document;
  g.document = {
    documentElement: {
      style: {},
    },
  };
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
  await withVars({}, () => {
    const c = themeColors();
    assert.ok(c.background && c.foreground, "there must always be a palette to apply");
    assert.equal(c.cursor, c.foreground, "the default caret is the foreground");
  });
});

test("re-theming a live terminal is a single write, and is skipped when nothing changed (#137)", async () => {
  await withVars({ "--term-bg": "#111", "--term-fg": "#eee" }, () => {
    const s = fake();
    retintTerminal(s);
    assert.equal(s.options.theme?.background, "#111", "a fresh session receives the palette");

    const first = s.options.theme;
    retintTerminal(s);
    assert.equal(s.options.theme, first, "an unchanged palette must not churn the terminal");
  });
});

test("a theme that predates the CURSOR fields is still retinted (#137)", async () => {
  await withVars({ "--term-bg": "#fff", "--term-fg": "#111" }, () => {
    const stale = fake({ background: "#fff", foreground: "#111" }); 
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
  await withVars({ "--term-bg": "#fff", "--term-fg": "#111" }, () => {
    const wrong = fake({ background: "#fff", foreground: "#111", cursor: "#000", cursorAccent: "#fff" });
    retintTerminal(wrong);
    assert.equal(wrong.options.theme?.cursor, "#111", "the stale caret is replaced");
  });
});
