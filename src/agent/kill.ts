import { spawnSync } from "node:child_process";

export interface KillOutcome {
  killed: boolean;
  wholeTree: boolean;
  reason?: "no-pid" | "already-gone" | "group-unsupported" | "error";
}

export function canKillProcessGroup(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/** how a tree kill is attempted; injectable so the win32 path is testable off Windows */
export type TreeRunner = (file: string, args: string[]) => { status: number | null };

const runTaskkill: TreeRunner = (file, args) => {
  try {
    const r = spawnSync(file, args, { stdio: "ignore", windowsHide: true });
    return { status: r.status };
  } catch {
    return { status: null };
  }
};

export function killTree(
  child: { pid?: number | null } | null | undefined,
  platform: NodeJS.Platform = process.platform,
  run: TreeRunner = runTaskkill,
): KillOutcome {
  if (!child?.pid) return { killed: false, wholeTree: false, reason: "no-pid" };

  if (!canKillProcessGroup(platform)) {
    /**
     * Windows has no process groups, and `process.kill(pid)` terminates ONLY the process you name — the
     * shell — so everything it started keeps running. That is not just a leak: the caller waits for the
     * child's stdio to close, and a surviving grandchild holds those pipes open, so the tool call never
     * returns even though the timeout fired (#190).
     *
     * `taskkill /T` walks the parent-child tree and is the only way to get all of it. If it is missing or
     * refuses, fall back to the direct kill and SAY the tree is uncovered.
     */
    const r = run("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    if (r.status === 0) return { killed: true, wholeTree: true };
    try {
      process.kill(child.pid, "SIGKILL");
      return { killed: true, wholeTree: false };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return {
        killed: false,
        wholeTree: false,
        reason: code === "ESRCH" ? "already-gone" : "error",
      };
    }
  }

  try {
    process.kill(-child.pid, "SIGKILL");
    return { killed: true, wholeTree: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      try {
        process.kill(child.pid, "SIGKILL");
        return { killed: true, wholeTree: false };
      } catch {
        return { killed: false, wholeTree: false, reason: "error" };
      }
    }
    if (code === "ESRCH") return { killed: false, wholeTree: false, reason: "already-gone" };
    return { killed: false, wholeTree: false, reason: "error" };
  }
}

export function describeKill(outcome: KillOutcome): string {
  // "tree", not "process group": on Windows the mechanism is `taskkill /T`, and the report is read by an
  // operator who cannot see which platform it came from
  if (outcome.killed && outcome.wholeTree) return "killed (whole process tree)";
  if (outcome.killed) {
    return (
      "killed the process, but its children may still be running — " +
      "a background command it started could survive this"
    );
  }
  switch (outcome.reason) {
    case "no-pid":
      return "no process handle to kill";
    case "already-gone":
      return "already exited";
    case "group-unsupported":
      return "process groups are not supported on this platform";
    default:
      return "could not be killed";
  }
}
