/**
 * Callback-style temp dirs: the directory NEVER escapes the callback, so a
 * test structurally cannot forget to clean up (the old trackTemp/cleanupTemp
 * registry relied on every author remembering both steps, and failures left
 * hundreds of stray dirs under /tmp).
 *
 *   await useTempDir("mytest-", async (dir) => { … });
 *   await useTempDirs(["ws-", "sess-"], async ([ws, sess]) => { … });
 *
 * Cleanup runs in a `finally`: on success, assertion failure, or throw.
 *
 * Everything lands under ONE root (`testTmpRoot()`), not directly in `os.tmpdir()`:
 * artifacts scattered across /tmp cannot be cleaned up without identifying them by
 * name, and name-based cleanup is how a tidying script deletes somebody else's data.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { mkdtempInRoot, testTmpRoot } from "./tmp-root.ts";

/** One unique temp dir under the shared test root; removed when `fn` settles. */
export async function useTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T> | T,
): Promise<T> {
  return useTempDirs([prefix], (dirs) => fn(dirs[0]!));
}

/** Several unique temp dirs; ALL are removed once `fn` settles. */
export async function useTempDirs<T>(
  prefixes: readonly string[],
  fn: (dirs: string[]) => Promise<T> | T,
): Promise<T> {
  const dirs: string[] = [];
  try {
    for (const p of prefixes) {
      const dir = await mkdtempInRoot(p);
      dirs.push(dir);
    }
    return await fn(dirs);
  } finally {
    for (const d of dirs.reverse()) {
      // never follow a bad registration outside the root we create in
      if (!path.resolve(d).startsWith(testTmpRoot())) continue;
      // swallow removal errors — they must not mask the test's own failure
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  }
}
