/**
 * Archive is the reversible half of "remove".
 *
 * The old 🗑 remove deleted the agent's config entry while leaving `sessions/` on
 * disk. The history survived, but nothing in the UI could reach it again — the session
 * became reachable only by knowing its id and hand-editing config.json. That is a
 * destructive answer to what is usually a temporary wish ("I am done with this for
 * now"), so the two intents are now separate:
 *
 *   archive → stop it, hide it, KEEP the config entry and every session directory
 *   restore → bring it back, live, pointing at the SAME session
 *   purge   → delete the config entry AND the session directories (irreversible)
 *
 * The property worth testing is the one the old code broke: after archive→restore the
 * history is still there. A test that only checked `archived === true` would pass
 * against an implementation that had already erased the files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

// POSIX-only: POSIX filesystem paths.
markPosixOnly("POSIX filesystem paths");

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function mkMaster(dataDir: string, agents: any[] = []): Master {
  return new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents }, "/dev/null");
}

const sessionsRoot = (dataDir: string) => path.join(dataDir, "sessions");

/** the session directory names on disk — the thing archive must not destroy */
const dirsOnDisk = (dataDir: string): string[] => {
  try {
    return readdirSync(sessionsRoot(dataDir));
  } catch {
    return [];
  }
};

test("archive keeps the config entry and every session directory (#archive)", async () => {
  await useTempDirs(["arch-root-", "arch-ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const app = buildApp(m);

    const created = (await (
      await app.request("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: ws, id: "keeper", start: false }),
      })
    ).json()) as { agent: { id: string } };
    assert.equal(created.agent.id, "keeper");

    // PRECONDITION: a session must exist, or "the files survived" is vacuous
    const before = dirsOnDisk(dataDir);
    assert.ok(before.length > 0, `precondition: agent creation must mint a session; saw ${before}`);

    const arch = await app.request("/api/agents/keeper/archive", { method: "POST" });
    assert.equal(arch.status, 200);
    assert.deepEqual(await arch.json(), { archived: true });

    // the config entry is still there, flagged
    const entry = m.config.agents.find((a) => a.id === "keeper");
    assert.ok(entry, "the config entry must be KEPT — that is what makes restore possible");
    assert.equal(entry.archived, true);
    assert.ok(typeof entry.archivedAt === "number", "archivedAt is used to sort the list");

    // and nothing on disk was touched
    assert.deepEqual(dirsOnDisk(dataDir), before, "archiving must not delete any session");

    // it is not running any more
    assert.equal(m.agents.get("keeper"), undefined, "an archived agent must not stay live");
    await m.dispose?.();
  });
});

test("restore brings the SAME session back, live (#archive)", async () => {
  await useTempDirs(["arch2-root-", "arch2-ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const app = buildApp(m);
    await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: ws, id: "comeback", start: false }),
    });
    const sessionBefore = m.config.agents.find((a) => a.id === "comeback")?.session;
    assert.ok(sessionBefore, "precondition: the agent must have a bound session");

    await app.request("/api/agents/comeback/archive", { method: "POST" });
    const res = await app.request("/api/agents/comeback/restore", { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { restored: boolean; live: boolean };
    assert.equal(body.restored, true);

    const entry = m.config.agents.find((a) => a.id === "comeback");
    assert.ok(entry, "the entry must still be present after restore");
    assert.equal(entry.archived, undefined, "restore must clear the flag");
    assert.equal(entry.archivedAt, undefined);
    // THE POINT: the history is the same history, not a fresh empty session
    assert.equal(
      entry.session,
      sessionBefore,
      "restore must reattach the SAME session, not mint a new one — otherwise the " +
        "history the archive was supposed to protect is unreachable again",
    );
    await m.dispose?.();
  });
});

test("purge erases both the entry and the session directories (#archive)", async () => {
  await useTempDirs(["arch3-root-", "arch3-ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const app = buildApp(m);
    await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: ws, id: "doomed", start: false }),
    });
    const dirsBefore = dirsOnDisk(dataDir);
    assert.ok(dirsBefore.length > 0, "precondition: there must be something to delete");

    const res = await app.request("/api/agents/doomed/purge", { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { purged: boolean; dirs: number };
    assert.equal(body.purged, true);
    assert.equal(body.dirs, dirsBefore.length, `all ${dirsBefore.length} dirs must be removed`);

    assert.equal(
      m.config.agents.find((a) => a.id === "doomed"),
      undefined,
      "the config entry must be gone",
    );
    // every directory that existed before is gone from disk
    for (const d of dirsBefore) {
      assert.equal(
        existsSync(path.join(sessionsRoot(dataDir), d)),
        false,
        `session ${d} must be erased — purge is the irreversible option`,
      );
    }
    await m.dispose?.();
  });
});

test("boot starts configured agents but not archived ones (#archive)", async () => {
  // An archived entry must not be resurrected by a restart. Starting it would also
  // mint or rewrite a session for something the operator deliberately put away.
  await useTempDirs(["arch4-root-", "arch4-ws-"], async ([dataDir, ws]) => {
    const first = mkMaster(dataDir);
    const app = buildApp(first);
    for (const id of ["alive", "asleep"]) {
      await app.request("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: ws, id, start: false }),
      });
    }
    await app.request("/api/agents/asleep/archive", { method: "POST" });
    await first.dispose?.();

    // a fresh Master over the same dataDir = a restart
    const second = mkMaster(dataDir, first.config.agents);
    await second.start();
    try {
      assert.ok(second.agents.get("alive"), "a normal agent must still start at boot");
      assert.equal(
        second.agents.get("asleep"),
        undefined,
        "an ARCHIVED agent must not start at boot — it was put away on purpose",
      );
      // and the archived entry itself is untouched, so a later restore still works
      const entry = second.config.agents.find((a) => a.id === "asleep");
      assert.ok(entry, "boot must not drop the archived entry from the config");
      assert.equal(entry.archived, true);
    } finally {
      await second.dispose?.();
    }
  });
});
