import { mkdir, mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ownedDirs = new Set<string>();
let exitHookInstalled = false;
function ownDir(dir: string): void {
  ownedDirs.add(dir);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const d of ownedDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
      }
    }
  });
}

export function testTmpRoot(): string {
  return process.env.TEAPOT_TEST_TMP || path.join(tmpdir(), "teapot-tests");
}

export async function mkdtempInRoot(prefix: string): Promise<string> {
  const root = testTmpRoot();
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, prefix));
  ownDir(dir);
  return dir;
}

export function mkdtempInRootSync(prefix: string): string {
  const root = testTmpRoot();
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, prefix));
  ownDir(dir);
  return dir;
}

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
    return { removed: 0, bytes: 0 }; 
  }
  if (path.resolve(root) === path.resolve(path.join(tmpdir(), "teapot-tests")) || process.env.TEAPOT_TEST_TMP) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return { removed, bytes };
}

export async function makeRunRoot(): Promise<string> {
  const base = testTmpRoot();
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, "run-"));
}
