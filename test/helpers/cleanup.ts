import { rm } from "node:fs/promises";
import path from "node:path";
import { testTmpRoot } from "./tmp-root.ts";

/** Temp dirs registered by tests; removed when the file's cleanup runs. */
const dirs: string[] = [];

export function trackTemp(...dirs_: string[]): void {
  dirs.push(...dirs_);
}

export async function cleanupTemp(): Promise<void> {
  for (const d of dirs) {
    // never follow a bad registration outside the root tests create in
    if (!path.resolve(d).startsWith(testTmpRoot())) continue;
    await rm(d, { recursive: true, force: true });
  }
  dirs.length = 0;
}
