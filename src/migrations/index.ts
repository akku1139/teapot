/**
 * Ordered, one-way migrations for on-disk state.
 *
 * ## Why order and idempotency matter more than the transformations
 *
 * A single upgrade path is easy. The hard case is a machine that skips several releases: an
 * operator on v0.20 upgrading straight to v0.40 runs EVERY migration in between at once. Two
 * migrations that each look correct can then be wrong together — the canonical example is a future
 * `config.json` split combined with today's "store the session title in `agents[]`":
 *
 *   split first   → titles land in the new config directory, then the old file is read again and
 *                   the titles are written a second time, or to the wrong file;
 *   titles first  → the split then has to carry a field it never knew about.
 *
 * So each migration here:
 *
 *   - is **idempotent** — running it twice is a no-op, because a crash mid-upgrade must be
 *     resumable and a re-run must not double-apply;
 *   - declares an **order** — `order` is ascending, and a later step may assume every earlier one
 *     has run;
 *   - never deletes data it does not fully replace (a rename, not a delete-then-write);
 *   - reports what it did, so a boot log shows which steps actually ran.
 *
 * ## What this module is NOT
 *
 * It does not decide WHICH migrations exist — each one lives in its own file and is registered in
 * `index.ts`. Keeping them out of `master.ts` is the point: they were spread across the boot path,
 * where an ordering mistake is invisible.
 */

/** A single migration step. */
export interface Migration {
  /** ascending application order; a step may assume every lower `order` has run */
  order: number;
  /**
   * Stable identifier, recorded in the migration log. Renaming one makes an already-migrated
   * machine look unmigrated, so these are effectively permanent.
   */
  id: string;
  /** What it converts, and why — one line, shown in the boot log. */
  summary: string;
  /**
   * Apply it. MUST be idempotent and MUST NOT destroy data it cannot replace.
   * Returns true when it changed something (so the caller can log it).
   */
  run: (ctx: MigrationContext) => boolean | Promise<boolean>;
}

/** What a migration is allowed to touch. Deliberately narrow. */
export interface MigrationContext {
  /** the config file's directory — sibling files live here */
  configDir: string;
  /** where the raw parsed config lives; migrations read and rewrite this object */
  raw: () => Record<string, unknown>;
  /** mark the config dirty so it is written once at the end of the pass */
  touch: () => void;
  /** the data dir (sessions, assets, terminal scrollback) */
  dataDir: string;
  /** log one line, prefixed with the migration id */
  log: (message: string) => void;
}

/**
 * Run every registered migration in `order`, skipping nothing.
 *
 * There is no "already ran" gate on purpose: each step is idempotent, so the cheapest correct
 * policy is to always run them. A recorded version would have to be validated against a config the
 * operator may have hand-edited or restored from backup, and a wrong version claim is how a
 * migration silently does not run.
 */
export async function runMigrations(
  migrations: readonly Migration[],
  ctx: MigrationContext,
): Promise<{ applied: string[] }> {
  const applied: string[] = [];
  for (const m of [...migrations].sort((a, b) => a.order - b.order)) {
    try {
      if (await m.run(ctx)) {
        applied.push(m.id);
        ctx.log(`migrated: ${m.summary}`);
      }
    } catch (err) {
      // One broken step must not block the boot: the session data is still readable, and refusing
      // to start would be worse than starting with one conversion unmade.
      ctx.log(`migration ${m.id} FAILED (${(err as Error).message}) — continuing without it`);
    }
  }
  return { applied };
}

/**
 * ## What is deliberately NOT here
 *
 * Two migrations stay in `src/agent/agent.ts` because they are per-SESSION filesystem moves that
 * need the agent's own paths, and they already satisfy the rules above:
 *
 *   - `migrateGoalFromWorkspace` — `<workspace>/GOAL.md` → the session's goal store. Deletes the
 *     legacy file only after a successful write, so a failure re-runs.
 *   - `migrateMemoryToAgentScope` — a session's `memory.md` → the agent-wide one. APPENDS (the
 *     agent-wide file may already hold other sessions' notes), then removes the source. A missing
 *     write leaves the session copy in place.
 *
 * Moving them here would mean handing this module session paths it has no business knowing. What
 * matters is that they obey the same contract: idempotent, no data destroyed that was not
 * replaced, and ordered after the config-level steps (they run at agent start, which is later).
 */
