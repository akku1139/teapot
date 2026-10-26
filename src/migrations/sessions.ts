import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import type { Migration } from "./index.ts";

export const flatSessionLayout: Migration = {
  order: 20,
  id: "sessions-flat-layout",
  summary: "sessions/<id>.jsonl → sessions/<id>/chat.jsonl",
  run(ctx) {
    let names: string[];
    try {
      names = readdirSync(ctx.dataDir);
    } catch {
      return false;
    }
    const root = path.join(ctx.dataDir, "sessions");
    let changed = false;
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!id || id.includes("/") || id.includes("..")) continue; 
      const legacy = path.join(ctx.dataDir, name);
      const target = path.join(root, id);
      if (existsSync(target)) continue; 
      mkdirSync(target, { recursive: true });
      renameSync(legacy, path.join(target, "chat.jsonl"));
      ctx.log(`${name} → sessions/${id}/chat.jsonl`);
      changed = true;
    }
    return changed;
  },
};
