
export function fmtDur(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "?";
  const n = Math.max(0, ms);
  if (n < 1_000) return `${Math.round(n)}ms`;
  if (n < 60_000) {
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
