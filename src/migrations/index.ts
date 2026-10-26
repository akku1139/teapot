
export interface Migration {
  order: number;
  id: string;
  summary: string;
  run: (ctx: MigrationContext) => boolean | Promise<boolean>;
}

export interface MigrationContext {
  configDir: string;
  raw: () => Record<string, unknown>;
  touch: () => void;
  dataDir: string;
  log: (message: string) => void;
}

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
      ctx.log(`migration ${m.id} FAILED (${(err as Error).message}) — continuing without it`);
    }
  }
  return { applied };
}

