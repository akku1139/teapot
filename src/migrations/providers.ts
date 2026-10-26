import type { Migration } from "./index.ts";
import { migrateProviderKeys } from "../master.ts";

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
      const next = migrateProviderKeys(p as never) as unknown as Record<string, unknown>;
      for (const k of Object.keys(p)) delete p[k];
      Object.assign(p, next);
      if (JSON.stringify(p) !== before) changed = true;
    }
    if (changed) ctx.touch();
    return changed;
  },
};
