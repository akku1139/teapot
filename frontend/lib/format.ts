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
  /**
   * ROUND FIRST, then split into units.
   *
   * Each branch used to floor the larger unit and round the remainder INDEPENDENTLY, so a value
   * just under a boundary rounded up to 60 of the smaller unit: `119999` rendered "1m 60s",
   * `3599999` rendered "59m 60s", and `59999` rendered "60.0s" — reported as "2分60秒とは???".
   * A duration never has 60 seconds or 60 minutes, so that output was not merely ugly, it was a
   * number that cannot exist.
   *
   * Rounding the whole duration once makes every rollover automatic: 119999 rounds to 120000,
   * which then splits into exactly 2m.
   */
  if (n < 1_000) return `${Math.round(n)}ms`;
  if (n < 60_000) {
    /**
     * FLOOR to one decimal, not round.
     *
     * Rounding to whole seconds made 59999 render "60.0s" — a value that cannot exist. Rounding
     * to the DECIMAL keeps the precision the sub-minute view is for (30.5s) and can still reach
     * "59.9s", which is under the boundary and therefore never prints 60.
     */
    const tenths = Math.floor(n / 100) / 10;
    return `${tenths.toFixed(1)}s`;
  }
  const totalSecs = Math.round(n / 1000);
  if (totalSecs < 3600) {
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const totalMins = Math.round(totalSecs / 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + " …" : s;
}

export function relTime(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const unit =
    abs < 90_000 ? `${Math.round(abs / 1000)}s`
    : abs < 5_400_000 ? `${Math.round(abs / 60_000)}m`
    : `${(abs / 3_600_000).toFixed(1)}h`;
  return ms >= 0 ? `in ${unit}` : `${unit} ago`;
}
