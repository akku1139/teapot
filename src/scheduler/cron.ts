/**
 * Minimal 5-field cron matcher (minute hour day-of-month month day-of-week).
 * Also supports shorthand "every <n>s|m|h".
 * The master ticks once every 15s; matching is a handful of integer compares.
 */

export interface Schedule {
  raw: string;
  fields: [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
}

const BOUNDS: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7], // 0 and 7 are both Sunday
];

function parseField(part: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const piece of part.split(",")) {
    const [range, stepStr] = piece.split("/");
    const step = Math.max(1, Number(stepStr ?? 1) || 1);
    if (range === "*" || range === "*/" + step) {
      for (let i = min; i <= max; i += step) out.add(i);
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      if (Number.isNaN(a) || Number.isNaN(b)) throw new Error(`bad cron field: ${part}`);
      for (let i = a; i <= b; i += step) out.add(i);
    } else {
      const v = Number(range);
      if (Number.isNaN(v)) throw new Error(`bad cron field: ${part}`);
      if (!stepStr || step === 1) {
        out.add(v);
      } else {
        for (let i = v; i <= max; i += step) out.add(i);
      }
    }
  }
  return out;
}

export function parseSchedule(spec: string): Schedule {
  const every = spec.trim().match(/^every\s+(\d+)\s*(s|m|h)$/i);
  let effective = spec.trim();
  if (every) {
    const n = Number(every[1]);
    const unit = every[2].toLowerCase();
    if (unit === "s") {
      const m = Math.max(1, Math.round(n / 60));
      effective = `*/${m} * * * *`;
    } else if (unit === "m") {
      effective = `*/${n} * * * *`;
    } else {
      effective = `0 */${n} * * *`;
    }
  }
  const parts = effective.split(/\s+/);
  if (parts.length !== 5) throw new Error(`bad schedule: ${spec}`);
  return {
    raw: spec,
    fields: parts.map((p, i) => parseField(p, BOUNDS[i][0], BOUNDS[i][1])) as Schedule["fields"],
  };
}

/** Does this schedule fire at the given Date? */
export function matches(schedule: Schedule, d: Date): boolean {
  const values = [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
  for (let i = 0; i < 5; i++) {
    if (!schedule.fields[i].has(values[i])) {
      // Sunday alias: field 5 with 7 should also match day=0
      if (i === 4 && values[i] === 0 && schedule.fields[i].has(7)) continue;
      return false;
    }
  }
  return true;
}

/**
 * Next fire time after `from`, scanning minute by minute (cheap: a handful of
 * integer compares per minute). Returns null when nothing fires within ~31
 * days (e.g. a Feb-29-only cron in August).
 */
export function nextFireAt(schedule: Schedule, from = new Date()): string | null {
  const startMinute = Math.floor(from.getTime() / 60_000) + 1; // next whole minute
  const horizon = 60 * 24 * 31;
  for (let i = 0; i < horizon; i++) {
    const d = new Date((startMinute + i) * 60_000);
    if (matches(schedule, d)) return d.toISOString();
  }
  return null;
}
