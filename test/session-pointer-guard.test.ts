import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { useTempDir } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function writeConfig(configPath: string, realRoot: string): void {
  mkdirSync(realRoot, { recursive: true });
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

    const prev = process.env.TEAPOT_DATA_DIR;
    process.env.TEAPOT_DATA_DIR = otherRoot;
    try {
      const config = JSON.parse(before) as import("../src/master.ts").TeapotConfig;
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
    process.env.TEAPOT_DATA_DIR = root; 
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const m = new Master(config, configPath);
      for (const ac of config.agents) await m.addAgent(ac, { fresh: false });
      const after = JSON.parse(readFileSync(configPath, "utf8")) as { agents: { session: string }[] };
      assert.equal(after.agents[0]!.session, before.agents[0]!.session, "a valid pointer must survive (#143)");
    } finally {
      if (prev === undefined) delete process.env.TEAPOT_DATA_DIR;
      else process.env.TEAPOT_DATA_DIR = prev;
    }
  });
});
