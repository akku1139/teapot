/**
 * Killing a spawned process tree, across platforms (#110).
 *
 * A negative pid is a POSIX process-group kill; Node's own docs (v24,
 * `doc/api/process.md`) are explicit: *"Windows platforms will throw an error if
 * the `pid` is used to kill a process group."*
 *
 * Both call sites wrapped the kill in an empty catch, and on Windows EVERY group
 * kill throws — so the throw was the normal path, not the exceptional one, and
 * the failure was silent: on timeout the tool reported a `TIMEOUT` for a process
 * that is STILL RUNNING, abort left it alive, and `bash({action:"kill"})`
 * answered "killed" while dropping a running job from the map untrackable. A
 * timeout that reports success is worse than a crash, because nothing looks wrong
 * afterwards.
 *
 * So the kill now REPORTS whether it worked, and the callers say so. Windows has
 * no group kill at all: Node cannot enumerate a process tree, and killing just
 * the direct child leaves grandchildren running. That is what a Job Object solves
 * (Codex vendors this — `codex-rs/utils/pty/src/win/job.rs`) and it needs native
 * code; until then we kill the child we have a handle on and tell the operator
 * the tree may survive.
 */
export interface KillOutcome {
  /** did we actually terminate something? */
  killed: boolean;
  /** the whole tree is gone (POSIX group) — false means grandchildren may live */
  wholeTree: boolean;
  /** why not, when killed is false */
  reason?: "no-pid" | "already-gone" | "group-unsupported" | "error";
}

/** can this platform kill a whole process group? */
export function canKillProcessGroup(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/**
 * Kill a spawned child, and its whole group where the platform allows it.
 *
 * Deliberately does NOT throw: callers are timeouts and abort handlers, where a
 * throw would replace the real message with a secondary failure.
 */
export function killTree(
  child: { pid?: number | null } | null | undefined,
  platform: NodeJS.Platform = process.platform,
): KillOutcome {
  if (!child?.pid) return { killed: false, wholeTree: false, reason: "no-pid" };

  if (!canKillProcessGroup(platform)) {
    // Windows: no group kill. Try the direct child so at least THAT stops, and
    // report that the tree is not covered rather than implying it is.
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
    process.kill(-child.pid, "SIGKILL"); // whole group
    return { killed: true, wholeTree: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM on the group can still mean the child is killable directly, and
    // EPERM is what a partially-privileged tree produces.
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

/** a sentence for the tool result, so a partial kill is never silent */
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
