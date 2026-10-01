/**
 * Formatting helpers shared by the chat/tool timeline.
 *
 * Kept in its own dependency-free module (no solid-js, no DOM) so they can be
 * unit-tested directly under `node --test`, the same way md.js is.
 */

/**
 * Milliseconds → a duration a human reads at a glance (#24).
 *
 * Tool rows used to interpolate raw `${durationMs}ms`, so a seven-minute build
 * rendered as "431113ms · timeout 3300s" — the exact complaint from the issue.
 * Sub-second work keeps sub-second precision (the common case), seconds take
 * over quickly, and hours only appear when they are real.
 *
 * A missing value renders as "?" — the same unknown the old template produced
 * via `?? "?"`, so an event without timing data still looks deliberate.
 */
export function fmtDur(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "?";
  const n = Math.max(0, ms);
  if (n < 1_000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  if (n < 3_600_000) {
    const m = Math.floor(n / 60_000);
    const s = Math.round((n % 60_000) / 1000);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(n / 3_600_000);
  const m = Math.round((n % 3_600_000) / 60_000);
  return m ? `${h}h ${m}m` : `${h}h`;
}