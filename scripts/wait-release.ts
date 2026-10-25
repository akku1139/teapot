#!/usr/bin/env node
/**
 * Wait for the three release workflows and then for the npm version to appear.
 *
 * WHY THIS EXISTS: the loop this replaces was
 *
 *     timeout 1500 gh run watch $id --exit-status || echo "FAILED $wf"
 *
 * and `||` cannot tell a FAILED run from a watch that ran out of clock. MEASURED on v0.37.47: the
 * Windows job sat `in_progress` for over 40 minutes, the timeout fired, and the release loop
 * announced `FAILED windows.yml` — while the next commit passed the same job. That sends a session
 * into a log dive for a build that never failed.
 *
 * A run's own `status`/`conclusion` is the only authority, so this polls THAT and reports one of
 * three outcomes per workflow: success, failure (with the failing steps named), or timed out.
 *
 * Run it in a BACKGROUND bash job: waiting is the work, and foregrounding it costs the turn.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const WORKFLOWS = ["test.yml", "windows.yml", "publish.yml"];

const args = new Set(process.argv.slice(2));
const PER_RUN_MS = Number(process.env.RELEASE_WAIT_MS ?? 45 * 60_000);
const POLL_MS = Number(process.env.RELEASE_POLL_MS ?? 20_000);
/** the version to wait for on npm; when absent, only the workflows are watched */
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

/** the failing steps, so a real failure arrives with something to act on */
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
    // NOT a failure: the runner is still going and the clock ran out. Say so, and keep going —
    // a later workflow in the chain may already be done.
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

/** exit non-zero ONLY for a real failure — a timeout must not look like one */
process.exit(results.some((r) => r.outcome.startsWith("FAILURE")) ? 1 : 0);
