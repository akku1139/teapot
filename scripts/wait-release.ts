#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const WORKFLOWS = ["test.yml", "windows.yml", "publish.yml"];

const args = new Set(process.argv.slice(2));
const PER_RUN_MS = Number(process.env.RELEASE_WAIT_MS ?? 45 * 60_000);
const POLL_MS = Number(process.env.RELEASE_POLL_MS ?? 20_000);
const versionArg = process.argv.slice(2).find((a) => /^\d+\.\d+\.\d+/.test(a));

const gh = async (args: string[]): Promise<string> => {
  const { stdout } = await run("gh", args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RunState = { status: string; conclusion: string };

const runState = async (id: string): Promise<RunState> => {
  const out = await gh(["run", "view", id, "--json", "status,conclusion"]);
  return JSON.parse(out) as RunState;
};

const failingSteps = async (id: string): Promise<string> => {
  try {
    const out = await gh(["run", "view", id, "--json", "jobs"]);
    const jobs = (JSON.parse(out) as { jobs: Array<{ name: string; conclusion: string; steps?: Array<{ name: string; conclusion: string }> }> }).jobs;
    return jobs
      .filter((j) => j.conclusion === "failure")
      .map((j) => {
        const step = j.steps?.find((s) => s.conclusion === "failure")?.name ?? "?";
        return `  ${j.name}: failing step "${step}"`;
      })
      .join("\n");
  } catch {
    return "  (could not read the failing steps)";
  }
};

const latestRun = async (workflow: string): Promise<string> =>
  gh(["run", "list", `--workflow=${workflow}`, "--limit", "1", "--json", "databaseId", "-q", ".[0].databaseId"]);

const results: Array<{ workflow: string; outcome: string; detail?: string }> = [];

for (const wf of WORKFLOWS) {
  const id = await latestRun(wf);
  if (!id) {
    results.push({ workflow: wf, outcome: "no run found" });
    continue;
  }
  const deadline = Date.now() + PER_RUN_MS;
  let state: RunState = { status: "queued", conclusion: "" };
  while (Date.now() < deadline) {
    state = await runState(id);
    if (state.status === "completed") break;
    await sleep(POLL_MS);
  }
  if (state.status !== "completed") {
    results.push({
      workflow: wf,
      outcome: `STILL RUNNING after ${Math.round(PER_RUN_MS / 60_000)}m (not a failure — check with: gh run view ${id})`,
    });
    continue;
  }
  if (state.conclusion === "success") results.push({ workflow: wf, outcome: "success" });
  else if (state.conclusion === "cancelled") results.push({ workflow: wf, outcome: "cancelled (superseded?)" });
  else results.push({ workflow: wf, outcome: `FAILURE (${state.conclusion})`, detail: await failingSteps(id) });
}

if (versionArg) {
  const deadline = Date.now() + 15 * 60_000;
  let seen = "";
  while (Date.now() < deadline) {
    try {
      seen = (await run("npm", ["view", "teapot-coding-agent", "version"])).stdout.trim().split("\n").pop() ?? "";
    } catch {
      seen = "";
    }
    if (seen === versionArg) break;
    await sleep(POLL_MS);
  }
  results.push({
    workflow: `npm ${versionArg}`,
    outcome: seen === versionArg ? "published" : `NOT YET (npm shows ${seen || "nothing"})`,
  });
}

if (args.has("--json")) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.workflow}: ${r.outcome}`);
    if (r.detail) console.log(r.detail);
  }
}

process.exit(results.some((r) => r.outcome.startsWith("FAILURE")) ? 1 : 0);
