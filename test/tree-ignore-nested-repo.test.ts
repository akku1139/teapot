/**
 * The file tree must report gitignored entries for a NESTED repository.
 *
 * Reported: with `~/work/tyb2` as the workspace, `mt6589-emulator/renode` was not marked ignored —
 * even though `mt6589-emulator/.gitignore` line 1 is `renode/`.
 *
 * Cause: the lookup ran `git -C <workspace> check-ignore` with workspace-relative paths. A workspace
 * is very often just a PARENT FOLDER holding several checkouts, and `git -C` on a non-repository
 * exits with "not a git repository" — which the empty-output path read as "nothing is ignored".
 * MEASURED against the real tree: the old form prints the fatal error, the new one (run from the
 * directory being listed, bare names) prints `.gitignore|1|renode/|renode|`.
 *
 * The fixture reproduces the shape exactly: a plain parent directory containing a repo whose
 * .gitignore excludes a subdirectory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildApp } from "../src/server/api.ts";
import { Master } from "../src/master.ts";

/** git needs an identity to commit; these tests only need it to initialise a repo */
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

  // the workspace is a PLAIN DIRECTORY — this is the whole point
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

  // PRECONDITION: the directory listing must actually contain what we are asking about
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
