import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Master } from "../src/master.ts";
import { useTempDir } from "./helpers/tmp.ts";

/**
 * A missing workspace must be reported as a GHOST at boot, without anything loading the session.
 *
 * Regression: the workspace existence check was swept into the deferred "session state" bundle when
 * boot stopped reading session directories, and the ghost marker silently disappeared —
 * "critical regression: ghostが効かなくなった".
 *
 * The reason it cannot simply be lazy: `isGhost` only ever CLEARS `workspaceMissing`. Nothing else
 * SETS it, so if boot does not compute it, an agent whose workspace is gone reports as healthy forever.
 *
 * It is also not a session-directory read — it stats a path FROM config.json — so it belongs in boot.
 */
test("an agent whose workspace is gone reports as a ghost at boot (#ghost)", async () => {
  await useTempDir("ghost-", async (dataDir) => {
    const present = path.join(dataDir, "present");
    await fs.mkdir(present, { recursive: true });
    const missing = path.join(dataDir, "gone-forever");
    const sessions = path.join(dataDir, "sessions");
    for (const id of ["here", "gone"]) {
      const d = path.join(sessions, id);
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(
        path.join(d, "chat.jsonl"),
        JSON.stringify({
          v: 1, id: "e1", seq: 1, ts: "2026-01-01T00:00:00Z",
          agent: id, session: id, branch: "br0", type: "prompt", data: { source: "user", text: "hi" },
        }) + "\n",
      );
    }
    const cfgPath = path.join(dataDir, "config.json");
    const cfg = {
      port: 0,
      dataDir,
      llm: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" },
      providers: { p: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" } },
      defaultProvider: "p",
      agents: [
        { id: "here", workspace: present, provider: "p", session: "here", model: "m" },
        { id: "gone", workspace: missing, provider: "p", session: "gone", model: "m" },
      ],
    };
    await fs.writeFile(cfgPath, JSON.stringify(cfg));
    const m = new Master(cfg as never, cfgPath);
    await m.start();

    assert.equal(m.agents.get("here")?.snapshot().workspaceMissing, false, "a present workspace is not a ghost");
    assert.equal(
      m.agents.get("gone")?.snapshot().workspaceMissing,
      true,
      "a missing workspace must be flagged at boot — nothing loads the session first",
    );
    await m.stopAllAgents();
  });
});

test("the ghost check does NOT open the session directory (#ghost)", async () => {
  /**
   * The other half of the rule: the fix must not reintroduce the boot scan. An agent with no session
   * directory on disk still boots and is still classified, because the check is a stat of the workspace
   * path only.
   */
  await useTempDir("ghost2-", async (dataDir) => {
    const cfgPath = path.join(dataDir, "config.json");
    const cfg = {
      port: 0,
      dataDir,
      llm: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" },
      providers: { p: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" } },
      defaultProvider: "p",
      agents: [{ id: "solo", workspace: path.join(dataDir, "nope"), provider: "p", session: "solo", model: "m" }],
    };
    await fs.writeFile(cfgPath, JSON.stringify(cfg));
    const m = new Master(cfg as never, cfgPath);
    await m.start();
    assert.equal(m.agents.get("solo")?.snapshot().workspaceMissing, true);
    await m.stopAllAgents();
  });
});
