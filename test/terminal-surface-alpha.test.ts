import assert from "node:assert/strict";
import test from "node:test";
import { withAlpha } from "../frontend/lib/terminal-theme.ts";

test("the terminal takes the code-block alpha, not one of its own", () => {
  /**
   * "ターミナルの背景透過はコードブロックと同じ薄さにしてほしい". The code-block surface is `--bg-darkest`, which
   * under a wallpaper is `color-mix(... var(--surface-alpha-darkest) ...)`; the terminal has to use the same
   * number rather than an eyeballed one, or the two read as different materials.
   *
   * `--surface-alpha-darkest` resolves to an EXPRESSION (`max(.35, calc(.82 - .12))`), so it cannot be parsed
   * directly — the value is measured from a painted probe instead (see `surfaceAlphaFromDom`).
   */
  assert.equal(withAlpha("#1a1c22", 0.7), "rgba(26, 28, 34, 0.7)");
  assert.equal(withAlpha("#1a1c22", 1), "#1a1c22", "no wallpaper means opaque, byte for byte the theme colour");
  assert.equal(withAlpha("rgb(26, 28, 34)", 0.5), "rgba(26, 28, 34, 0.5)");
  // an unparseable colour must not become transparent
  assert.equal(withAlpha("var(--x)", 0.5), "var(--x)");
});
