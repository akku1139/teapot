/**
 * A time anchor for harness-generated messages.
 *
 * Reported as "AIが時間把握するのが極めて下手": a five minute exploit, a device reboot, a progress report — and the
 * model narrating it as if no time had passed. Tool results carry `[took 12.3s]` for the call just made, but
 * nothing tells it what time it is NOW or how long it has been going, so a long wait and an instant are
 * indistinguishable in the transcript.
 *
 * Only harness-injected messages get this. It cannot go in the system prompt: that text is the provider's
 * prefix-cache anchor, and a timestamp there would invalidate the cache on every single request.
 */

/** "0s" / "45s" / "12m" / "1h12m" / "2d3h" — one unit of resolution, never more than two parts */
export function shortDuration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins ? `${hours}h${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d${remHours}h` : `${days}d`;
}

/**
 * `[harness] 21:04 · 1h12m into this session · last turn ended 3m ago`
 *
 * `startedAt` is the ISO timestamp of the session's first turn; anything unparseable simply drops that part
 * rather than injecting "NaN" into a prompt.
 */
export function turnAnchor(args: {
  now: number;
  startedAt?: string | null;
  lastTurnAt?: number | null;
}): string {
  const clock = new Date(args.now);
  const hh = String(clock.getHours()).padStart(2, "0");
  const mm = String(clock.getMinutes()).padStart(2, "0");
  const parts = [`${hh}:${mm}`];
  const start = args.startedAt ? Date.parse(args.startedAt) : Number.NaN;
  if (Number.isFinite(start) && args.now >= start) parts.push(`${shortDuration(args.now - start)} into this session`);
  if (args.lastTurnAt && args.now >= args.lastTurnAt) {
    const gap = args.now - args.lastTurnAt;
    // below a few seconds the gap is noise, not information
    if (gap >= 3_000) parts.push(`${shortDuration(gap)} since the last turn`);
  }
  return `[harness] ${parts.join(" · ")}`;
}
