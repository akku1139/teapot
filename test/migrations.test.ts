import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { runMigrations, type MigrationContext } from "../src/migrations/index.ts";
import { MIGRATIONS } from "../src/migrations/registry.ts";

const ctxFor = (dir: string, raw: Record<string, unknown>): MigrationContext => ({
  configDir: dir,
  raw: () => raw,
  touch: () => {},
  dataDir: dir,
  log: () => {},
});

/**
 * Migrations must be safe to RE-RUN and safe to run ALL AT ONCE.
 *
 * The dangerous case is not one upgrade but several at once: a machine on an old build jumping to
 * the current release runs every step in a single boot. Ordering is what makes that work, and
 * idempotency is what makes a crash mid-upgrade resumable — a step that double-applies, or one that
 * assumes another has run when it has not, corrupts a config that cannot be regenerated.
 */
test("running every migration twice changes nothing the second time (#migrate)", async () => {
  const dir = mkdtempInRootSync("migrate-");
  const sessions = path.join(dir, "sessions");
  mkdirSync(path.join(sessions, "s1"), { recursive: true });
  writeFileSync(
    path.join(sessions, "s1", "chat.jsonl"),
    `${JSON.stringify({ type: "prompt", data: { source: "user", text: "fix the login bug" } })}\n`,
  );
  const raw: Record<string, unknown> = {
    agents: [{ id: "a", workspace: "/w", session: "s1" }],
    providers: { p: { baseUrl: "http://x", apiKey: "k1" } },
  };

  const first = await runMigrations(MIGRATIONS, ctxFor(dir, raw));
  assert.ok(first.applied.includes("agents-session-title"), "the title must be derived once");
  const after1 = JSON.stringify(raw);
  const agent = (raw.agents as Record<string, unknown>[])[0]!;
  assert.equal(agent.sessionTitle, "fix the login bug", "the title comes from the first user prompt");

  const second = await runMigrations(MIGRATIONS, ctxFor(dir, raw));
  assert.deepEqual(second.applied, [], "a second pass must apply NOTHING — re-running is a no-op");
  assert.equal(JSON.stringify(raw), after1, "and must not rewrite the config");
});

test("a HAND-CHOSEN title is never overwritten (#migrate)", async () => {
  // a derived value must not clobber a chosen one — that is what makes renaming possible later
  const dir = mkdtempInRootSync("migrate-keep-");
  mkdirSync(path.join(dir, "sessions", "s1"), { recursive: true });
  writeFileSync(
    path.join(dir, "sessions", "s1", "chat.jsonl"),
    `${JSON.stringify({ type: "prompt", data: { source: "user", text: "original" } })}\n`,
  );
  const raw: Record<string, unknown> = {
    agents: [{ id: "a", workspace: "/w", session: "s1", sessionTitle: "my own name" }],
  };
  await runMigrations(MIGRATIONS, ctxFor(dir, raw));
  assert.equal((raw.agents as Record<string, unknown>[])[0]!.sessionTitle, "my own name");
});

test("a harness-only session gets NO title, and a missing log is not an error (#migrate)", async () => {
  const dir = mkdtempInRootSync("migrate-harness-");
  mkdirSync(path.join(dir, "sessions", "sub"), { recursive: true });
  writeFileSync(
    path.join(dir, "sessions", "sub", "chat.jsonl"),
    `${JSON.stringify({ type: "prompt", data: { source: "harness", text: "[harness] continue" } })}\n`,
  );
  const raw: Record<string, unknown> = {
    agents: [
      { id: "sub", workspace: "/w", session: "sub" },
      { id: "gone", workspace: "/w", session: "does-not-exist" },
    ],
  };
  await runMigrations(MIGRATIONS, ctxFor(dir, raw)); // must not throw
  const agents = raw.agents as Record<string, unknown>[];
  assert.equal(agents[0]!.sessionTitle, undefined, "a sub-agent is labelled from its id, not a prompt");
  assert.equal(agents[1]!.sessionTitle, undefined, "a missing log yields nothing rather than failing");
});

test("the flat-layout move is a RENAME, so a crash cannot lose the history (#migrate)", async () => {
  const dir = mkdtempInRootSync("migrate-flat-");
  writeFileSync(path.join(dir, "old.jsonl"), '{"type":"message"}\n');
  const raw: Record<string, unknown> = { agents: [{ id: "old", workspace: "/w" }] };
  await runMigrations(MIGRATIONS, ctxFor(dir, raw));
  assert.ok(!existsSync(path.join(dir, "old.jsonl")), "the legacy file is gone");
  const moved = path.join(dir, "sessions", "old", "chat.jsonl");
  assert.ok(existsSync(moved), "and its content is at the new location");
  assert.equal(readFileSync(moved, "utf8"), '{"type":"message"}\n', "unchanged by the move");
  // a re-run finds nothing to do
  const again = await runMigrations([...MIGRATIONS], ctxFor(dir, raw));
  assert.ok(!again.applied.includes("sessions-flat-layout"), "already migrated");
});

test("order is ascending and ids are unique, or a multi-release jump silently skips a step (#migrate)", () => {
  const ids = MIGRATIONS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "two migrations must not share an id");
  const orders = MIGRATIONS.map((m) => m.order);
  assert.deepEqual([...orders].sort((a, b) => a - b), orders, "MIGRATIONS must be declared in order");
});

test("a migration's write SURVIVES the boot flush (#migrate)", async () => {
  /**
   * MEASURED failure this guards: 37 titles derived in memory, `"sessionTitle"` in the config file:
   * 0. `start()` reset `configDirty` AFTER `runMigrations`, erasing the very flag a migration had
   * just set — and `finally` flushes only when that flag is set, so the work was silently dropped.
   *
   * A migration that reports success while its result never reaches disk is worse than one that
   * throws: the boot log says "migrated", and the next boot does it all again.
   */
  const dir = mkdtempInRootSync("migrate-flush-");
  mkdirSync(path.join(dir, "sessions", "s1"), { recursive: true });
  writeFileSync(
    path.join(dir, "sessions", "s1", "chat.jsonl"),
    `${JSON.stringify({ type: "prompt", data: { source: "user", text: "hello" } })}\n`,
  );
  const raw: Record<string, unknown> = { agents: [{ id: "a", workspace: "/w", session: "s1" }] };
  let touched = false;
  await runMigrations(MIGRATIONS, {
    ...ctxFor(dir, raw),
    touch: () => {
      touched = true;
    },
  });
  assert.ok(
    touched,
    "the migration must ASK for a write — a step that changes the config without touching it " +
      "loses its result on the next boot",
  );
});
