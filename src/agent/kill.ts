export interface KillOutcome {
  killed: boolean;
  wholeTree: boolean;
  reason?: "no-pid" | "already-gone" | "group-unsupported" | "error";
}

export function canKillProcessGroup(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export function killTree(
  child: { pid?: number | null } | null | undefined,
  platform: NodeJS.Platform = process.platform,
): KillOutcome {
  if (!child?.pid) return { killed: false, wholeTree: false, reason: "no-pid" };

  if (!canKillProcessGroup(platform)) {
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
  if (outcome.killed && outcome.wholeTree) return "killed (whole process group)";
  if (outcome.killed) {
    return (
      "killed the process, but this platform has no process groups — any " +
      "background children it started may still be running"
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
