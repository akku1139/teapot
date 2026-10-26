import type { Migration } from "./index.ts";
import { providerKeys } from "./providers.ts";
import { flatSessionLayout } from "./sessions.ts";
import { sessionTitles } from "./session-titles.ts";

export const MIGRATIONS: readonly Migration[] = [providerKeys, flatSessionLayout, sessionTitles];

export { runMigrations, type Migration, type MigrationContext } from "./index.ts";
