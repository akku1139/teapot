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

test("a churn directory is ignored — where the platform NAMES the change", async () => {
  /**
   * MEASURED on the macOS job: `paths=["watch-b-71HH5b"]` — the watched root's own name, not `node_modules/dep-0.js`. FSEvents
   * reports that a change happened somewhere under the root and nothing more, so a path-based ignore list cannot apply there.
   *
   * The consequence is bounded and accepted: on macOS a `pnpm install` causes a few refetches of the directories that are on
   * screen, debounced to one per burst. It is not a correctness bug — the panel shows the truth either way — so the difference is
   * pinned here rather than papered over with a platform skip, which would hide it the next time it changes.
   *
   * (The design that removes the difference entirely is to watch only the directories the client has expanded, so the panel's
   * own view decides what is watched. That is a protocol change, not a filter.)
   */
  const ws = mkdtempInRootSync("watch-b-");
  mkdirSync(path.join(ws, "node_modules"));
  let hits = 0;
  const named: string[] = [];
  const release = watchWorkspace(ws, (changed) => {
    hits++;
    named.push(changed);
  });
  try {
    await waitFor(() => watchedWorkspaces().includes(path.resolve(ws)), { what: "the watcher to be armed" });
    for (let i = 0; i < 5; i++) writeFileSync(path.join(ws, "node_modules", `dep-${i}.js`), "x");
    // nothing to wait FOR on the "0" branch: the assertion is that no notification arrives, so settling IS the test
    await new Promise((r) => setTimeout(r, 700));

    const namesThePath = named.every((n) => n.includes("/") || n === "");
    if (!namesThePath) {
      // darwin: the events carry the root's name, so the filter is inert by construction — assert that instead of pretending
      assert.equal(
        named.every((n) => n === path.basename(ws) || n === ""),
        true,
        `a platform that cannot name the change must report the root: ${JSON.stringify(named)}`,
      );
      assert.ok(hits > 0, "and it must still notify, or a panel would never refresh on this platform");
    } else {
      assert.equal(hits, 0, `node_modules churn must not reach the panel (paths=${JSON.stringify(named)})`);
    }

    // either way, an ordinary file notifies: the watcher was alive the whole time
    const before = hits;
    writeFileSync(path.join(ws, "real.txt"), "x");
    await waitFor(() => hits > before, { what: "a notification for a real file" });
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
