/**
 * Formatting helpers shared by the chat/tool timeline.
 *
 * Kept in its own dependency-free module (no solid-js, no DOM) so they can be
 * unit-tested directly under `node --test`.
 */

/**
 * Milliseconds → a duration a human reads at a glance (#24): `431113ms` on a
 * tool row is the complaint the issue was filed about.
 *
 * A missing value renders as "?", so an event without timing data still looks
 * deliberate rather than broken.
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

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + " …" : s;
}
