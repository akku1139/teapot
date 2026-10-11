import { mkdir, mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Every test artifact lives under ONE directory, so cleanup is a single `rm -rf`.
 *
 * Tests used to call `mkdtemp(path.join(os.tmpdir(), prefix))` directly — 70 call sites
 * scattered across 26 files — which spread artifacts across /tmp and made them
 * indistinguishable from anything else on the machine. `pnpm test:clean` then has to
 * guess by name, and guessing is how you delete somebody else's data (measured: /tmp
 * held 2006 teapot fixture directories, 439 MB, and telling them apart from other
 * projects' files took a walk of every candidate).
 *
 * It is ALSO a correctness fix, not just tidiness: a container or CI runner may hand the
 * process a non-/tmp `TMPDIR`, and the removal guard below (`startsWith(tmpdir())`) is
 * only meaningful relative to the root things were actually created in.
 *
 * Override with `TEAPOT_TEST_TMP` to group a run's artifacts somewhere specific — which
 * is what makes "clean up just this run" possible.
 *
 *   const root = testTmpRoot();          // <TMPDIR>/teapot-tests/…
 *   const dir  = await mkdtemp(path.join(root, prefix));
 */

/** the shared parent of every test artifact */
export function testTmpRoot(): string {
  return process.env.TEAPOT_TEST_TMP || path.join(tmpdir(), "teapot-tests");
}

/**
 * mkdtemp under the shared root, with the root created on demand.
 *
 * A drop-in replacement for `mkdtemp(path.join(os.tmpdir(), prefix))` — same signature,
 * same uniqueness — so call sites change by one expression and keep their behaviour.
 */
export async function mkdtempInRoot(prefix: string): Promise<string> {
  const root = testTmpRoot();
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, prefix));
}

/** the same, synchronously — for module-level fixtures in tests that cannot await */
export function mkdtempInRootSync(prefix: string): string {
  const root = testTmpRoot();
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, prefix));
}

/**
 * Remove the shared root. Safe by construction: it only ever deletes the directory the
 * helpers created, and never follows a path outside it.
 *
 * Reports what it freed, because "did it clean anything" is the question after a run.
 */
export async function cleanTestTmp(): Promise<{ removed: number; bytes: number }> {
  const root = testTmpRoot();
  let removed = 0;
  let bytes = 0;
  const measure = async (p: string): Promise<number> => {
    let total = 0;
    let entries: string[];
    try {
      entries = await readdir(p);
    } catch {
      return 0;
    }
    for (const e of entries) {
      const child = path.join(p, e);
      const s = await stat(child).catch(() => null);
      if (!s) continue;
      total += s.isDirectory() ? await measure(child) : s.size;
    }
    return total;
  };
  try {
    const entries = await readdir(root);
    removed = entries.length;
    bytes = await measure(root);
  } catch {
    return { removed: 0, bytes: 0 }; // nothing there: a clean run
  }
  // the guard the whole helper exists for: only ever the root we created
  if (path.resolve(root) === path.resolve(path.join(tmpdir(), "teapot-tests")) || process.env.TEAPOT_TEST_TMP) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return { removed, bytes };
}

/**
 * A per-RUN root, so a single run's artifacts can be removed without touching another's.
 *
 * `TEAPOT_TEST_TMP` may also be set to a fixed path by CI to collect them deliberately.
 */
export async function makeRunRoot(): Promise<string> {
  const base = testTmpRoot();
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, "run-"));
}
