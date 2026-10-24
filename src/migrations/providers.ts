import type { Migration } from "./index.ts";
import { migrateProviderKeys } from "../master.ts";

/**
 * Fold a legacy single `apiKey` into an `apiKeys` array.
 *
 * `apiKey` is KEPT in step with `apiKeys[0]` rather than deleted: other readers still expect it (the
 * setup wizard, `/api/providers`, hand-edited files), and a migration that removes a field the
 * operator can see is one they will report as data loss.
 *
 * Idempotent because `apiKeys` is AUTHORITATIVE once present: re-running on a migrated entry
 * produces the same list. The single `apiKey` only SEEDS the pool when there is no list — appending
 * it as well would resurrect a credential the operator had already replaced.
 */
export const providerKeys: Migration = {
  order: 10,
  id: "providers-api-keys",
  summary: "provider apiKey → apiKeys[]",
  run(ctx) {
    const raw = ctx.raw();
    const providers = raw.providers;
    if (!providers || typeof providers !== "object") return false;
    let changed = false;
    for (const entry of Object.values(providers as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const p = entry as Record<string, unknown>;
      const before = JSON.stringify(p);
      // ONE implementation of the folding rule, shared with the runtime normaliser — a second copy
      // here is how the two drift and disagree about which key is authoritative.
      const next = migrateProviderKeys(p as never) as unknown as Record<string, unknown>;
      for (const k of Object.keys(p)) delete p[k];
      Object.assign(p, next);
      if (JSON.stringify(p) !== before) changed = true;
    }
    if (changed) ctx.touch();
    return changed;
  },
};
