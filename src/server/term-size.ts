/**
 * Terminal resize plumbing for the web terminal (#20).
 *
 * A resize is a property of the TTY, not a command. `TermSizeTracker` decides
 * WHEN to apply one; `resolvePtySlave` finds the device to apply it TO.
 *
 * ## How the size is applied now
 *
 * `stty -F <pty-slave> rows R cols C` — an ioctl(TIOCSWINSZ) on the pty DEVICE.
 * Nothing is written to the child's stdin, so nothing can be typed into a
 * foreground program. MEASURED with `script -qec`:
 *
 *     stty -F /dev/pts/0 rows 55 cols 190
 *     readback:        55 190
 *     foreground trap: WINCH fired, no command text in the output stream
 *
 * which is the same mechanism VS Code (node-pty, native ioctl) and Alacritty
 * (owns the pty) use — neither ever issues `stty` as TEXT.
 *
 * Before this, the size was applied by WRITING `stty rows R cols C\n` into the
 * child's stdin. That is only safe when a shell is reading: when an interactive
 * program owns the tty (vim, less, a python REPL) stdin belongs to the PROGRAM,
 * so the line arrived as keystrokes and landed in the operator's document. The
 * whole design below — debounce, busy-defer, no-op skip — exists to make that
 * text rare rather than to make it harmless; with the device ioctl the text is
 * gone entirely, and the remaining machinery now only serves to avoid redundant
 * syscalls on a drag.
 *
 * ## Why the slave path has to be discovered
 *
 * `script` is spawned by us, so we hold a pipe to its stdin/stdout, not the pty
 * master. The pty slave it created is reachable as our CHILD's fd 0 on Linux
 * (/proc/<pid>/fd/0 → /dev/pts/N). Where that cannot be resolved — macOS has no
 * /proc — the caller falls back to the stdin write, so no platform loses resize;
 * it only loses the improvement.
 *
 * `TermSizeTracker` still:
 *   - debounces to the trailing edge of a drag (one ioctl per drag, not per pixel)
 *   - remembers the applied size and skips no-op resizes entirely
 *   - defers while the child is producing output (markBusy)
 *   - keys state by CHILD, not agent: one agent may hold up to 10 terminals,
 *     each with its own size and its own foreground program
 */
import type { ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

/**
 * The pty slave device behind a child, or null when it cannot be determined.
 *
 * ## Why this walks to a GRANDCHILD
 *
 * The child we spawn is `script -qec <shell> /dev/null` with piped stdio (we must
 * read its output), so the child's OWN fd 0 is a PIPE, not the pty. `script`
 * creates the pty and forks the shell onto the slave, so the device we want is
 * fd 0 of one of its children. MEASURED on util-linux 2.42:
 *
 *     script  fd0 -> pipe:[…]      (our pipes)
 *     script  fd3 -> /dev/ptmx     (the master)
 *     script  fd4 -> /dev/pts/0    (the slave, but script's own fd)
 *     shell   fd0 -> /dev/pts/0    (the shell's controlling tty — what we want)
 *
 * Any of `/dev/pts/N` found this way identifies the same pty, so the first match
 * wins. Returns null on any failure — non-Linux (no /proc), an exited child, the
 * plain-pipe fallback spawn where there is no pty at all — because a resize must
 * never throw out of a socket handler.
 */
export function resolvePtySlave(child: ChildProcess | null | undefined): string | null {
  const pid = child?.pid;
  if (!pid) return null;
  // the slave may sit on the spawned child or on ITS child (script forks the
  // shell onto the pty), so try both before giving up
  for (const candidate of [pid, ...childrenOf(pid), ...childrenOf(pid).flatMap(childrenOf)]) {
    const found = ptySlaveOf(candidate);
    if (found) return found;
  }
  return null;
}

/** pids whose parent is `pid` (empty on a host without /proc) */
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

/** `/dev/pts/N` behind any fd of `pid`, or null */
function ptySlaveOf(pid: number): string | null {
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      let target: string;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue; // fd closed between readdir and readlink — normal
      }
      // only a real pty device: a pipe readlinks as `pipe:[123]` and an anon
      // inode as `anon_inode:[…]`, neither of which accepts TIOCSWINSZ
      if (target.startsWith("/dev/pts/")) return target;
    }
  } catch {
    /* process gone, or no /proc (macOS) */
  }
  return null;
}

/** debounce window: long enough to collapse a drag, short enough to feel instant */
export const TERM_RESIZE_DEBOUNCE_MS = 250;
/** how long after output a terminal counts as "a program is running" */
export const TERM_BUSY_MS = 400;

interface TermState {
  rows: number;
  cols: number;
  timer: NodeJS.Timeout | null;
  busyUntil: number;
}

export interface TermSizeSink {
  /** apply the size; may be called with no child (already exited) */
  write(rows: number, cols: number): void;
}

export class TermSizeTracker {
  private states = new Map<ChildProcess, TermState>();

  /**
   * Request a resize; the sink write happens on the trailing edge of the
   * debounce.
   */
  request(child: ChildProcess, rows: number, cols: number, write: TermSizeSink["write"]): void {
    const st = this.states.get(child) ?? { rows: 0, cols: 0, timer: null, busyUntil: 0 };
    this.states.set(child, st);
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    // already the applied size → nothing a shell could act on
    if (st.rows === rows && st.cols === cols) return;

    const wait = Math.max(0, st.busyUntil - Date.now());
    const apply = () => {
      st.timer = null;
      st.rows = rows;
      st.cols = cols;
      try {
        write(rows, cols);
      } catch {
        /* child exited mid-debounce */
      }
    };
    st.timer = setTimeout(
      () => {
        // output may have CONTINUED past the deadline this timer was computed
        // from (markBusy only extends busyUntil — it cannot reach an already
        // pending timer). Writing now would type stty into a running program,
        // so defer to whatever busy window remains.
        const remain = st.busyUntil - Date.now();
        if (remain > 0) {
          st.timer = setTimeout(apply, remain);
          return;
        }
        apply();
      },
      wait > 0 ? wait : TERM_RESIZE_DEBOUNCE_MS,
    );
  }

  /** a child produced output — defer resizes so we never type into it */
  markBusy(child: ChildProcess, ms: number = TERM_BUSY_MS): void {
    // create the entry if absent: output usually arrives long before the first
    // resize, and dropping the signal then let the resize land in the program
    const st = this.states.get(child) ?? { rows: 0, cols: 0, timer: null, busyUntil: 0 };
    this.states.set(child, st);
    st.busyUntil = Date.now() + ms;
  }

  /** forget a child; cancels its pending resize so we can't write to a corpse */
  forget(child: ChildProcess): void {
    const st = this.states.get(child);
    if (st?.timer) clearTimeout(st.timer);
    this.states.delete(child);
  }

  /** test/diagnostic: the size currently applied for a child */
  applied(child: ChildProcess): { rows: number; cols: number } | null {
    const st = this.states.get(child);
    return st ? { rows: st.rows, cols: st.cols } : null;
  }

  /** test: cancel everything (keeps suites from leaking timers) */
  disposeAll(): void {
    for (const st of this.states.values()) if (st.timer) clearTimeout(st.timer);
    this.states.clear();
  }
}
