import { rm } from "node:fs/promises";
import path from "node:path";
import { testTmpRoot } from "./tmp-root.ts";

const dirs: string[] = [];

export function trackTemp(...dirs_: string[]): void {
  dirs.push(...dirs_);
}

export async function cleanupTemp(): Promise<void> {
  for (const d of dirs) {
    if (!path.resolve(d).startsWith(testTmpRoot())) continue;
    await rm(d, { recursive: true, force: true });
  }
  dirs.length = 0;
}
