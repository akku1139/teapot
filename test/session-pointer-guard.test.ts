/**
 * A `TEAPOT_DATA_DIR` override that disagrees with the config's own `dataDir`
 * must make SESSION RESOLUTION READ-ONLY (#143).
 *
 * The damage this prevents is severe and silent. Session pointers in the config
 * name directories under a specific root. Point the process at a DIFFERENT root
 * and every pointer "misses", so every agent mints a fresh session in the new
 * root — and `recordSession` writes those back into the config. If the new root
 * is a test's temp directory, it is deleted moments later, leaving a config whose
 * 493 agents point at sessions that never existed.
 *
 * That is not theoretical: `test/cli-boot-and-host.test.ts` spawned the CLI with
 * `TEAPOT_DATA_DIR=<temp>` and no `TEAPOT_CONFIG`, so running the repo's own test
 * suite orphaned the session pointers on a developer's machine. CI never noticed,
 * because CI has no config file to damage.
 *
 * The test side is fixed too (every spawn now sets TEAPOT_CONFIG). This is the
 * defence in depth: the PRODUCT must not destroy a config it is describing
 * another data dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { useTempDir } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

/** a config whose agents point at session dirs under `realRoot` */
function writeConfig(configPath: string, realRoot: string): void {
  mkdirSync(realRoot, { recursive: true });
  // one agent, with a real session dir containing a log whose `agent` field
  // proves the ownership
  const sid = "worker-aaaaaaaa";
  mkdirSync(path.join(realRoot, "sessions", sid), { recursive: true });
  writeFileSync(
    path.join(realRoot, "sessions", sid, "chat.jsonl"),
    JSON.stringify({
      v: 1, id: "e1", seq: 1, ts: "2026-01-01T10:00:00.000Z", agent: "worker",
      session: sid, branch: "br0", parent: null, type: "prompt", data: { source: "user", text: "hi" },
    }) + "\n",
  );
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        dataDir: realRoot,
        llm: LLM,
        providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } },
        agents: [{ id: "worker", workspace: realRoot, provider: "p", session: sid }],
      },
      null,
      2,
    ) + "\n",
  );
}

test("a mismatched TEAPOT_DATA_DIR does not rewrite the config's session pointers (#143)", async () => {
  await useTempDir("guard-", async (tmp) => {
    const realRoot = path.join(tmp, "real");
    const otherRoot = path.join(tmp, "other");
    mkdirSync(otherRoot, { recursive: true });
    const configPath = path.join(tmp, "config.json");
    writeConfig(configPath, realRoot);
    const before = readFileSync(configPath, "utf8");

    // exactly what the test suite used to do: override the DATA DIR only
    const prev = process.env.TEAPOT_DATA_DIR;
    process.env.TEAPOT_DATA_DIR = otherRoot;
    try {
      const config = JSON.parse(before) as {
        dataDir: string;
        llm: typeof LLM;
        providers: Record<string, unknown>;
        agents: { id: string; workspace: string; provider: string; session: string }[];
      };
      // the process resolves dataDir from the env override, as the CLI does
      config.dataDir = otherRoot;
      const m = new Master(config, configPath);
      for (const ac of config.agents) await m.addAgent(ac, { fresh: false });

      assert.equal(
        readFileSync(configPath, "utf8"),
        before,
        "an env data-dir override must NOT rewrite session pointers into this config (#143)",
      );
    } finally {
      if (prev === undefined) delete process.env.TEAPOT_DATA_DIR;
      else process.env.TEAPOT_DATA_DIR = prev;
    }
  });
});

test("a MATCHING data dir still persists session pointers normally (#143)", async () => {
  await useTempDir("guard-", async (tmp) => {
    const root = path.join(tmp, "same");
    const configPath = path.join(tmp, "config.json");
    writeConfig(configPath, root);
    const before = JSON.parse(readFileSync(configPath, "utf8")) as { agents: { session: string }[] };

    const prev = process.env.TEAPOT_DATA_DIR;
    process.env.TEAPOT_DATA_DIR = root; // agrees with the file
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const m = new Master(config, configPath);
      for (const ac of config.agents) await m.addAgent(ac, { fresh: false });
      const after = JSON.parse(readFileSync(configPath, "utf8")) as { agents: { session: string }[] };
      // the recorded session is valid here, so it must simply be KEPT
      assert.equal(after.agents[0]!.session, before.agents[0]!.session, "a valid pointer must survive (#143)");
    } finally {
      if (prev === undefined) delete process.env.TEAPOT_DATA_DIR;
      else process.env.TEAPOT_DATA_DIR = prev;
    }
  });
});
