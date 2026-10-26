import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("POSIX filesystem paths");

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function mkMaster(dataDir: string, agents: any[] = []): Master {
  return new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents }, "/dev/null");
}

const sessionsRoot = (dataDir: string) => path.join(dataDir, "sessions");

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

    const before = dirsOnDisk(dataDir);
    assert.ok(before.length > 0, `precondition: agent creation must mint a session; saw ${before}`);

    const arch = await app.request("/api/agents/keeper/archive", { method: "POST" });
    assert.equal(arch.status, 200);
    const body = (await arch.json()) as { archived: boolean; ids: string[] };
    assert.equal(body.archived, true);
    assert.deepEqual(body.ids, ["keeper"], "no sub-agents, so only itself");

    const entry = m.config.agents.find((a) => a.id === "keeper");
    assert.ok(entry, "the config entry must be KEPT — that is what makes restore possible");
    assert.equal(entry.archived, true);
    assert.ok(typeof entry.archivedAt === "number", "archivedAt is used to sort the list");

    assert.deepEqual(dirsOnDisk(dataDir), before, "archiving must not delete any session");

    assert.equal(m.agents.get("keeper"), undefined, "an archived agent must not stay live");
    await m.stopAllAgents();
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
    assert.equal(
      entry.session,
      sessionBefore,
      "restore must reattach the SAME session, not mint a new one — otherwise the " +
        "history the archive was supposed to protect is unreachable again",
    );
    await m.stopAllAgents();
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
    for (const d of dirsBefore) {
      assert.equal(
        existsSync(path.join(sessionsRoot(dataDir), d)),
        false,
        `session ${d} must be erased — purge is the irreversible option`,
      );
    }
    await m.stopAllAgents();
  });
});

test("boot starts configured agents but not archived ones (#archive)", async () => {
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
    await first.stopAllAgents();

    const second = mkMaster(dataDir, first.config.agents);
    await second.start();
    try {
      assert.ok(second.agents.get("alive"), "a normal agent must still start at boot");
      assert.equal(
        second.agents.get("asleep"),
        undefined,
        "an ARCHIVED agent must not start at boot — it was put away on purpose",
      );
      const entry = second.config.agents.find((a) => a.id === "asleep");
      assert.ok(entry, "boot must not drop the archived entry from the config");
      assert.equal(entry.archived, true);
    } finally {
      await second.stopAllAgents();
    }
  });
});

test("archiving a parent archives its whole SUBTREE (#archive)", async () => {
  await useTempDirs(["arch5-root-", "arch5-ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir, [
      { id: "parent", workspace: ws!, provider: "p", model: "m" },
      { id: "child", workspace: ws!, provider: "p", model: "m", parent: "parent" },
      { id: "grandchild", workspace: ws!, provider: "p", model: "m", parent: "child" },
      { id: "other", workspace: ws!, provider: "p", model: "m" },
    ]);
    const app = buildApp(m);
    for (const id of ["parent", "child", "grandchild", "other"]) {
      try {
        await (m as any).addAgent({ id, workspace: ws, provider: "p", model: "m" });
      } catch {
      }
    }

    const res = await app.request("/api/agents/parent/archive", { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { archived: boolean; ids: string[] };

    assert.equal(
      m.config.agents.filter((a) => a.id === "grandchild")[0]?.parent,
      "child",
      "precondition: grandchild hangs off child",
    );

    assert.deepEqual(
      [...body.ids].sort(),
      ["child", "grandchild", "parent"],
      "the parent AND every descendant must be archived",
    );
    for (const id of ["parent", "child", "grandchild"]) {
      assert.equal(
        m.config.agents.find((a) => a.id === id)?.archived,
        true,
        `${id} must be marked archived`,
      );
      assert.equal(m.agents.get(id), undefined, `${id} must not stay live`);
    }
    assert.equal(
      m.config.agents.find((a) => a.id === "other")?.archived,
      undefined,
      "an unrelated agent must not be archived",
    );
  });
});

test("restoring a parent restores its subtree too (#archive)", async () => {
  await useTempDirs(["arch6-root-", "arch6-ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir, [
      { id: "p2", workspace: ws!, provider: "p", model: "m" },
      { id: "c2", workspace: ws!, provider: "p", model: "m", parent: "p2" },
    ]);
    const app = buildApp(m);

    await app.request("/api/agents/p2/archive", { method: "POST" });
    for (const id of ["p2", "c2"]) {
      assert.equal(m.config.agents.find((a) => a.id === id)?.archived, true);
    }

    const res = await app.request("/api/agents/p2/restore", { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { restored: boolean; ids: string[] };
    assert.deepEqual([...body.ids].sort(), ["c2", "p2"]);

    for (const id of ["p2", "c2"]) {
      assert.equal(
        m.config.agents.find((a) => a.id === id)?.archived,
        undefined,
        `${id} must be un-archived`,
      );
    }
  });
});
