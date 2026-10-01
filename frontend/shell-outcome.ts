/**
 * How a shell invocation ENDED, as shown on the timeline.
 *
 * #46: "a timed-out bash never reads as complete on the timeline."
 *
 * The bash summary line is built from the tool_result's duration and the
 * requested timeout — so a command killed by the timeout rendered as
 * `300ms · timeout 1s`. That reads exactly like a fast SUCCESS: nothing on the
 * summary line said it had been killed, and the row kept its normal (unmarked)
 * appearance. The only hint was a `· FAILED` buried in the body's result block,
 * which is below the fold for a long-running command.
 *
 * The three terminal shapes come straight from runShell():
 *   - `TIMEOUT after <n>ms. …`      the timeout fired and the group was killed
 *   - `ABORTED (harness shutdown).…` the operator stopped the agent
 *   - anything else                  a normal exit (ok, or `exit=<code>`)
 */

/** Where a tool_result's text came out; null when it is not a shell result. */
export type ShellOutcome = "timeout" | "aborted" | "exit" | "ok" | "empty";

export function shellOutcome(
  ok: boolean | undefined,
  result: string | null | undefined,
): ShellOutcome {
  const text = String(result ?? "");
  if (/^TIMEOUT after\b/.test(text)) return "timeout";
  if (/^ABORTED\b/.test(text)) return "aborted";
  if (/^exit=\d+/.test(text)) return "exit";
  if (ok === false) return "exit";
  return text.trim() ? "ok" : "empty";
}

/** True only when the harness killed the command rather than it exiting. */
export function wasKilled(outcome: ShellOutcome): boolean {
  return outcome === "timeout" || outcome === "aborted";
}

/**
 * The marker appended to a tool row's summary line.
 *
 * `· FAILED` alone is deliberately kept for non-zero exits, so the common
 * failure path reads exactly as before; only the KILLED cases — which used to
 * look like successes — get their own wording.
 */
export function outcomeMarker(outcome: ShellOutcome): string {
  switch (outcome) {
    case "timeout":
      return " · TIMED OUT";
    case "aborted":
      return " · ABORTED";
    case "exit":
      return " · FAILED";
    default:
      return "";
  }
}

/**
 * The full summary hint for a shell row, e.g.
 * `7.2m · timeout 3300s` or `300ms · timeout 1s · TIMED OUT`.
 */
export function shellHint(opts: {
  outcome: ShellOutcome;
  durationMs: number | undefined;
  timeoutMs: number | undefined;
  fmtDur: (ms: number | undefined) => string;
}): string {
  const parts: string[] = [];
  if (opts.outcome !== "empty") parts.push(opts.fmtDur(opts.durationMs));
  if (opts.timeoutMs) parts.push(`timeout ${Math.round(opts.timeoutMs / 1000)}s`);
  const marker = outcomeMarker(opts.outcome);
  if (marker) parts.push(marker.trim());
  return parts.join(" · ");
}