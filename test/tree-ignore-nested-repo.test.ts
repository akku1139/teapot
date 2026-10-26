import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildApp } from "../src/server/api.ts";
import { Master } from "../src/master.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });

test("a nested repo's .gitignore is honoured by the tree (#ignore)", async (t) => {
  try {
    execFileSync("git", ["--version"], { encoding: "utf8" });
  } catch {
    return t.skip("git is not installed");
  }

  const workspace = mkdtempInRootSync("nested-ws-");
  const repo = path.join(workspace, "mt6589-emulator");
  mkdirSync(path.join(repo, "renode"), { recursive: true });
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, ".gitignore"), "renode/\nbuild/\n");
  writeFileSync(path.join(repo, "src", "main.c"), "int main(void){return 0;}\n");
  writeFileSync(path.join(repo, "renode", "keep.dll"), "binary\n");
  git(repo, "init", "-q");

  const dataDir = mkdtempInRootSync("nested-sd-");
  const master = new Master(
    {
      port: 0,
      dataDir,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
      providers: {},
      agents: [{ id: "probe", workspace, provider: "p", session: "s1" }],
    } as never,
    path.join(dataDir, "config.json"),
  );
  await master.start();
  const app = buildApp(master);

  const res = await app.request("/api/agents/probe/tree?path=mt6589-emulator");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { entries: { name: string; ignored?: boolean }[] };
  const byName = new Map(body.entries.map((e) => [e.name, e]));

  assert.ok(byName.has("renode"), `the listing must include renode; got ${[...byName.keys()].join(",")}`);
  assert.ok(byName.has("src"), "and an ordinary directory, so this is not a vacuous pass");

  assert.equal(
    byName.get("renode")!.ignored,
    true,
    "a directory excluded by the NESTED repo's .gitignore must be marked ignored",
  );
  assert.ok(
    !byName.get("src")!.ignored,
    "an ordinary directory must NOT be marked ignored — otherwise 'everything is ignored' would pass",
  );
  await master.stopAllAgents?.(5_000);
});
