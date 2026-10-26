
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

export function shellHint(opts: {
  outcome: ShellOutcome;
  durationMs: number | undefined;
  timeoutMs: number | undefined;
  fmtDur: (ms: number | undefined) => string;
}): string {
  const parts: string[] = [];
  if (opts.outcome !== "empty") parts.push(opts.fmtDur(opts.durationMs));
  if (opts.timeoutMs) parts.push(`timeout ${Math.round(opts.timeoutMs / 1000)}s`);
  const marker = outcomeMarker(opts.outcome).replace(/^\s*·\s*/, "");
  if (marker) parts.push(marker);
  return parts.join(" · ");
}
