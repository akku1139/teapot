import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import type { Migration } from "./index.ts";

/**
 * Move sessions from the ≤0.5.0 flat layout (`<dataDir>/<id>.jsonl`) into
 * `<dataDir>/sessions/<id>/chat.jsonl`.
 *
 * A RENAME, not a copy-then-delete: a crash between the two would otherwise leave the history in
 * neither place. `rename` within one filesystem is atomic, so a re-run either finds the legacy file
 * (and moves it) or finds it already moved.
 *
 * Order 20: it must run before anything reads a session directory.
 */
export const flatSessionLayout: Migration = {
  order: 20,
  id: "sessions-flat-layout",
  summary: "sessions/<id>.jsonl → sessions/<id>/chat.jsonl",
  run(ctx) {
    /**
     * Scan the DATA DIR, not `config.agents`.
     *
     * A legacy log can exist for an agent that is no longer in the config (archived, removed, or a
     * config that failed to load) — and those are exactly the histories worth rescuing. Iterating
     * the config also made this a no-op whenever the config listed no agents, which is how a test
     * with an empty agent list silently stopped exercising it.
     */
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
      if (!id || id.includes("/") || id.includes("..")) continue; // never a path segment
      const legacy = path.join(ctx.dataDir, name);
      const target = path.join(root, id);
      if (existsSync(target)) continue; // already migrated; the legacy file is a leftover
      mkdirSync(target, { recursive: true });
      renameSync(legacy, path.join(target, "chat.jsonl"));
      ctx.log(`${name} → sessions/${id}/chat.jsonl`);
      changed = true;
    }
    return changed;
  },
};
