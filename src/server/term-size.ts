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
    /**
     * `ps -A`, not `ps -e`.
     *
     * On Linux both print every process; on BSD/macOS `-e` means "show the ENVIRONMENT" and the field list is ignored, so the
     * output had no pid/ppid/tty columns at all and the parse found nothing — which is why pty discovery still failed on
     * darwin after the device names and `script` argv were fixed. `-A` is "all processes" on both.
     */
    const out = spawnSync("ps", ["-A", "-o", "pid=,ppid=,tty="], { encoding: "utf8" }).stdout ?? "";
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
      /**
       * "no terminal" is `?` on Linux and `??` on BSD, so both are skipped — and `-` for a process whose tty `ps` could not
       * resolve at all.
       */
      if (tty && tty !== "?" && tty !== "??" && tty !== "-" && !inherited.has(tty)) found = tty;
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
      /**
       * A pty slave is not always under `/dev/pts`.
       *
       * Linux allocates `/dev/pts/N`; macOS allocates `/dev/ttysNNN` for the same thing. Matching only the Linux spelling made
       * `/proc`-based discovery useless on any Darwin host (it would "resolve" nothing), which is why the macOS job reported
       * `a \`script\`-wrapped shell must expose a pty slave`.
       */
      if (/^\/dev\/(?:pts\/\d+|ttys\d+)$/.test(target)) return target;
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
  /**
   * `stty -F <device>` is the GNU spelling; BSD `stty` — which is what macOS ships — takes the device as a positional
   * argument BEFORE the settings (`stty -f <device>` is the BSD flag form, and a bare device works too). GNU `stty` reads
   * `-F`, so the two cannot be one argv.
   *
   * MEASURED on the macOS job: every pty resize test failed with the device unresolved/argument rejected, while the Linux
   * job passed. `process.platform` is the honest switch here: the difference is the `stty` implementation, which follows the
   * platform, not a runtime probe that would need a successful spawn to answer.
   */
  const args =
    process.platform === "darwin"
      ? [slave, "rows", String(rows), "cols", String(cols)]
      : ["-F", slave, "rows", String(rows), "cols", String(cols)];
  spawnFn("stty", args, { stdio: "ignore" });
  return true;
}
