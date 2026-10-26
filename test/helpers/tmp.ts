import { rm } from "node:fs/promises";
import path from "node:path";
import { mkdtempInRoot, testTmpRoot } from "./tmp-root.ts";

export async function useTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T> | T,
): Promise<T> {
  return useTempDirs([prefix], (dirs) => fn(dirs[0]!));
}

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
      if (!path.resolve(d).startsWith(testTmpRoot())) continue;
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
  }
}
