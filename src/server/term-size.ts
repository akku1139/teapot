import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export function resolvePtySlave(child: ChildProcess | null | undefined): string | null {
  const pid = child?.pid;
  if (!pid) return null;
  for (const candidate of [pid, ...childrenOf(pid), ...childrenOf(pid).flatMap(childrenOf)]) {
    const found = ptySlaveOf(candidate);
    if (found) return found;
  }
  return ptySlaveViaPs(pid);
}

function ptySlaveViaPs(pid: number): string | null {
  try {
    const self = process.pid;
    const out = spawnSync("ps", ["-e", "-o", "pid=,ppid=,tty="], { encoding: "utf8" }).stdout ?? "";
    const rows = out
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 3 && Number.isInteger(Number(c[0])))
      .map((c) => ({ pid: Number(c[0]), ppid: Number(c[1]), tty: c[2]! }));
    const ttyOf = (p: number) => rows.find((r) => r.pid === p)?.tty;
    const inherited = new Set([ttyOf(self), ttyOf(process.ppid)].filter(Boolean) as string[]);

    const seen = new Set<number>();
    const stack = [pid];
    let found: string | null = null;
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const tty = ttyOf(cur);
      if (tty && tty !== "??" && tty !== "-" && !inherited.has(tty)) found = tty;
      for (const r of rows) if (r.ppid === cur) stack.push(r.pid);
    }
    return found ? `/dev/${found}` : null;
  } catch {
    return null;
  }
}

function childrenOf(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function ptySlaveOf(pid: number): string | null {
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      let target: string;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue; 
      }
      if (target.startsWith("/dev/pts/")) return target;
    }
  } catch {
  }
  return null;
}

export const TERM_RESIZE_DEBOUNCE_MS = 250;
interface TermState {
  rows: number;
  cols: number;
  timer: NodeJS.Timeout | null;
}

export interface TermSizeSink {
  write(rows: number, cols: number): void;
}

export class TermSizeTracker {
  private states = new Map<ChildProcess, TermState>();

  request(child: ChildProcess, rows: number, cols: number, write: TermSizeSink["write"]): void {
    const st = this.states.get(child) ?? { rows: 0, cols: 0, timer: null };
    this.states.set(child, st);
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    if (st.rows === rows && st.cols === cols) return;

    const apply = () => {
      st.timer = null;
      st.rows = rows;
      st.cols = cols;
      try {
        write(rows, cols);
      } catch {
      }
    };
    st.timer = setTimeout(apply, TERM_RESIZE_DEBOUNCE_MS);
  }

  forget(child: ChildProcess): void {
    const st = this.states.get(child);
    if (st?.timer) clearTimeout(st.timer);
    this.states.delete(child);
  }

  applied(child: ChildProcess): { rows: number; cols: number } | null {
    const st = this.states.get(child);
    return st ? { rows: st.rows, cols: st.cols } : null;
  }

  disposeAll(): void {
    for (const st of this.states.values()) if (st.timer) clearTimeout(st.timer);
    this.states.clear();
  }
}

export function applyPtySize(
  child: ChildProcess | null | undefined,
  rows: number,
  cols: number,
  spawnFn: typeof spawn = spawn,
): boolean {
  if (!child || rows <= 0 || cols <= 0) return false;
  const slave = resolvePtySlave(child);
  if (!slave) return false;
  spawnFn("stty", ["-F", slave, "rows", String(rows), "cols", String(cols)], { stdio: "ignore" });
  return true;
}
