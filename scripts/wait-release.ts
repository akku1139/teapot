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
  /**
 * If a workflow already FAILED, npm cannot possibly get this version — polling it for the full 15 minutes only
 * delays the report. MEASURED: a failed v0.37.120 publish kept this script alive for 1378s before it printed
 * "NOT YET", and the failing step it had already found was scrolled out of the tail.
 */
const alreadyFailed = results.some((r) => r.outcome.startsWith("FAILURE"));
const deadline = Date.now() + 15 * 60_000;
  let seen = "";
  /** always check npm at least once, so the report names what IS published even when a workflow already failed */
  do {
    try {
      seen = (await run("npm", ["view", "teapot-coding-agent", "version"])).stdout.trim().split("\n").pop() ?? "";
    } catch {
      seen = "";
    }
    if (seen === versionArg) break;
    if (alreadyFailed) break;
    await sleep(POLL_MS);
  } while (Date.now() < deadline);
  const failedAt = results.find((r) => r.outcome.startsWith("FAILURE"));
  results.push({
    workflow: `npm ${versionArg}`,
    outcome:
      seen === versionArg
        ? "published"
        : `NOT YET (npm shows ${seen || "nothing"})${failedAt ? ` — ${failedAt.workflow} ${failedAt.outcome}` : ""}`,
  });
}

if (args.has("--json")) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.workflow}: ${r.outcome}`);
    if (r.detail) console.log(r.detail);
  }
  /**
   * The verdict goes LAST so a `tail` always shows it. MEASURED: v0.37.120's failing step ("Run pnpm test") was
   * printed correctly and then scrolled away by the npm line, which is the one that looked like the answer.
   */
  const verdict = results.filter((r) => r.outcome.startsWith("FAILURE"));
  if (verdict.length > 0) {
    console.log(`VERDICT: NOT RELEASED — ${verdict.map((v) => `${v.workflow}${v.detail ? ` (${v.detail})` : ""}`).join("; ")}`);
  } else {
    console.log(`VERDICT: ${versionArg} published`);
  }
}

process.exit(results.some((r) => r.outcome.startsWith("FAILURE")) ? 1 : 0);
