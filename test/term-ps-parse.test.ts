/**
 * The `ps` output format the pty discovery parses, in both dialects (#macos).
 *
 * Pty discovery falls back to `ps` wherever `/proc` is absent — every Darwin host — so this parse is what decides whether a
 * terminal works there at all. Two dialect differences matter and both bit the macOS job:
 *
 *   - "no terminal" is `?` on Linux and `??` on BSD;
 *   - the columns are only present if `-A` is asked for (`-e` means the environment on BSD).
 *
 * The parse is exercised through `resolvePtySlave`'s behaviour where it can be, and the accepted spellings are pinned here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/server/term-size.ts", import.meta.url), "utf8");

test("both 'no terminal' spellings are skipped, so neither becomes a device path", () => {
  assert.match(src, /tty !== "\?"/, "Linux prints `?`");
  assert.match(src, /tty !== "\?\?"/, "BSD prints `??`");
  // a bare `?`/`??` must never be turned into `/dev/?`
  for (const bad of ["?", "??", "-"]) {
    assert.ok(src.includes(`tty !== "${bad}"`), `${JSON.stringify(bad)} must be excluded`);
  }
});

test("the fallback selects every process with a flag both dialects agree on", () => {
  assert.match(src, /"-A"/, "`-A` is all-processes in both");
  assert.ok(!/\["-e"/.test(src), "`-e` is the environment on BSD");
});
