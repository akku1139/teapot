export interface Schedule {
  raw: string;
  fields: [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
}

const BOUNDS: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(part: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  const clampOrThrow = (v: number): number => {
    if (!Number.isInteger(v) || v < min || v > max)
      throw new Error(`bad cron field: ${part} (${min}-${max} expected)`);
    return v;
  };
  for (const piece of part.split(",")) {
    const [range = "", stepStr] = piece.split("/");
    const step = Math.max(1, Number(stepStr ?? 1) || 1);
    if (range === "*" || range === "*/" + step) {
      for (let i = min; i <= max; i += step) out.add(i);
    } else if (range.includes("-")) {
      const [aRaw, bRaw] = range.split("-").map(Number);
      const a = aRaw ?? min;
      const b = bRaw ?? max;
      clampOrThrow(a);
      clampOrThrow(b);
      if (a > b) throw new Error(`bad cron field: ${part} (inverted range)`);
      for (let i = a; i <= b; i += step) out.add(i);
    } else {
      const v = clampOrThrow(Number(range));
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
    const unit = (every[2] ?? "").toLowerCase();
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
    fields: parts.map((p, i) => {
      const bounds = BOUNDS[i];
      if (!bounds) throw new Error(`bad schedule: ${spec}`);
      return parseField(p, bounds[0], bounds[1]);
    }) as Schedule["fields"],
  };
}

export function matches(schedule: Schedule, d: Date): boolean {
  const values = [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
  for (let i = 0; i < 5; i++) {
    const field = schedule.fields[i];
    const value = values[i];
    if (!field || value === undefined) return false;
    if (!field.has(value)) {
      if (i === 4 && value === 0 && field.has(7)) continue;
      return false;
    }
  }
  return true;
}

export function nextFireAt(schedule: Schedule, from = new Date()): string | null {
  const startMinute = Math.floor(from.getTime() / 60_000) + 1;
  const horizon = 60 * 24 * 366;
  for (let i = 0; i < horizon; i++) {
    const d = new Date((startMinute + i) * 60_000);
    if (matches(schedule, d)) return d.toISOString();
  }
  return null;
}
