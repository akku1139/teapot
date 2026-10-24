import type { Migration } from "./index.ts";
import { providerKeys } from "./providers.ts";
import { flatSessionLayout } from "./sessions.ts";
import { sessionTitles } from "./session-titles.ts";

/**
 * Every migration, in application order.
 *
 * Add new ones with a HIGHER `order` than everything here, and never renumber an existing one — a
 * machine that already ran it would skip it under the new number.
 *
 * Ordering rule: a migration may assume every lower `order` has run. That is what makes a
 * multi-release jump safe. If two migrations must not be reordered later, say so in both files.
 */
export const MIGRATIONS: readonly Migration[] = [providerKeys, flatSessionLayout, sessionTitles];

export { runMigrations, type Migration, type MigrationContext } from "./index.ts";
