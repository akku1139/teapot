import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
 */

/** One unique temp dir under os.tmpdir(); removed when `fn` settles. */
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
      const dir = await mkdtemp(path.join(tmpdir(), p));
      dirs.push(dir);
    }
    return await fn(dirs);
  } finally {
    for (const d of dirs.reverse()) {
      // never follow a bad registration outside /tmp
      if (!path.resolve(d).startsWith(tmpdir())) continue;
      // swallow removal errors — they must not mask the test's own failure
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  }
}
