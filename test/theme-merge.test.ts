/**
 * A THEME LIST FROM THE SERVER MUST NEVER DELETE THE ONE IN THE BROWSER.
 *
 * Reported: "テーマの follow the system がオフなのにライトテーマ(システムのテーマ)の選択肢しかでない".
 *
 * The cause was the server-sync reconciliation, added in v0.36.0 with the rule "a server with
 * themes wins, because they are the durable copy". That rule is wrong in the direction that loses
 * data: MEASURED in a sandbox whose config held ONE stale light theme, seven themes in the browser
 * were replaced by that one — and because the survivor happened to be light, the appearance panel
 * offered only light themes while the appearance was dark.
 *
 * Neither side is authoritative: a theme can be made on a phone and not yet synced, and the config
 * file can hold themes from before this browser existed. The resolved list must be the UNION by id.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeThemes } from "../frontend/theme-merge.ts";
import type { CustomTheme } from "../frontend/theme-store.ts";

const PALETTE = {
  bgDarkest: "#1a1c22", bgDark: "#232630", bgMid: "#2b2e39", bgLight: "#343845",
  fg: "#e6e8ee", dim: "#9aa1b1", line: "#3a3f4d", acc: "#6aa8ff",
  ok: "#3ba55d", warn: "#e0a33e", err: "#ed4245", tool: "#9b7bff",
  termBg: "#14161b", termFg: "#d6d9e0",
};

const theme = (id: string, label = id): CustomTheme =>
  ({ id, label, mode: "dark", palette: PALETTE }) as CustomTheme;

test("a server holding ONE theme does not delete the browser's others (#themes-merge)", () => {
  // the reported case: the server had a single stale light theme, the browser had several
  const local = [theme("a"), theme("b"), theme("c")];
  const remote = [theme("stale")];
  const merged = mergeThemes(local, remote);
  const ids = merged.map((t) => t.id).sort();
  assert.deepEqual(
    ids,
    ["a", "b", "c", "stale"],
    `the union must keep every theme (got ${JSON.stringify(ids)}); replacing the local list with ` +
      `the server's is what made only one theme selectable (#themes-merge)`,
  );
});

test("the server's copy wins for an id both sides know (#themes-merge)", () => {
  // the server is the durable copy, so an edited-there theme must not be shadowed by a stale local
  const local = [theme("shared", "old label")];
  const remote = [theme("shared", "new label")];
  const merged = mergeThemes(local, remote);
  assert.equal(merged.length, 1, "the same id is one theme, not two");
  assert.equal(merged[0]!.label, "new label", "the server's copy must win for a shared id");
});

test("an empty server keeps the browser's themes (#themes-merge)", () => {
  const local = [theme("a"), theme("b")];
  assert.deepEqual(
    mergeThemes(local, []).map((t) => t.id),
    ["a", "b"],
    "an install that predates the config field answers [], and must not lose what it has",
  );
});

test("an empty browser takes the server's themes (#themes-merge)", () => {
  const remote = [theme("x"), theme("y")];
  assert.deepEqual(
    mergeThemes([], remote).map((t) => t.id),
    ["x", "y"],
    "a fresh browser must inherit the themes the config already holds",
  );
});

test("both empty stays empty (#themes-merge)", () => {
  assert.deepEqual(mergeThemes([], []), []);
});
