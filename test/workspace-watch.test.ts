/**
 * The files panel refreshes itself because the SERVER watches the workspace.
 *
 * The panel had a ⟳ button: nothing could tell it a file had appeared. Editors do not work that way — VS Code watches the tree —
 * and the button was the fallback for a missing signal, not a feature.
 *
 * What is measured here is the signal, not the DOM:
 *
 *   - a write in the workspace reaches the subscriber (through the debounce);
 *   - a churn directory (`node_modules`) does NOT — a `pnpm install` must not repaint the tree;
 *   - one watcher serves several panels and closes when the last one releases it (an `fs.watch` handle is a real inotify/FSEvents
 *     resource, so leaking one per panel is a leak per panel).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { watchWorkspace, watchedWorkspaces } from "../src/server/workspace-watch.ts";
import { waitFor } from "./helpers/wait-for.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("fs.watch with recursive: true");

test("a file appearing in the workspace notifies the subscriber", async () => {
  const ws = mkdtempInRootSync("watch-a-");
  let hits = 0;
  const release = watchWorkspace(ws, () => {
    hits++;
  });
  try {
    // wait for the watcher to be armed before writing, or the event predates it
    await waitFor(() => watchedWorkspaces().includes(path.resolve(ws)), { what: "the watcher to be armed" });
    writeFileSync(path.join(ws, "new-file.txt"), "x");
    await waitFor(() => hits > 0, { what: "a notification for the new file" });
  } finally {
    release();
  }
});

test("a churn directory is ignored, so an install does not repaint the tree", async () => {
  const ws = mkdtempInRootSync("watch-b-");
  mkdirSync(path.join(ws, "node_modules"));
  let hits = 0;
  const release = watchWorkspace(ws, () => {
    hits++;
  });
  try {
    await waitFor(() => watchedWorkspaces().includes(path.resolve(ws)), { what: "the watcher to be armed" });
    for (let i = 0; i < 5; i++) writeFileSync(path.join(ws, "node_modules", `dep-${i}.js`), "x");
    // nothing to wait FOR: the assertion is that no notification arrives, so this is the one place a settle delay IS the test
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(hits, 0, "node_modules churn must not reach the panel");
    // and an ordinary file after it still does, so the watcher was alive the whole time
    writeFileSync(path.join(ws, "real.txt"), "x");
    await waitFor(() => hits > 0, { what: "a notification for a real file" });
  } finally {
    release();
  }
});

test("several panels share one watcher, and the last release closes it", async () => {
  const ws = mkdtempInRootSync("watch-c-");
  const a = watchWorkspace(ws, () => {});
  const b = watchWorkspace(ws, () => {});
  const key = path.resolve(ws);
  assert.equal(watchedWorkspaces().filter((w) => w === key).length, 1, "one watcher, two panels");
  a();
  assert.ok(watchedWorkspaces().includes(key), "the second panel still needs it");
  b();
  assert.ok(!watchedWorkspaces().includes(key), "the last release closes the handle");
});
