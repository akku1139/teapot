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
 * so the line arrived as keystrokes and landed in the operator's document. With
 * the device ioctl that text is gone entirely, so the machinery here is only
 * about avoiding redundant syscalls on a drag — a debounce and a no-op skip.
 *
 * It used to ALSO defer while the child was producing output (`markBusy`). That
 * existed solely to make the text path rarer, and it became a bug once the ioctl
 * removed the hazard: a full-screen program redraws continuously, so the busy
 * window never expired and the resize never applied at all (#172 — "nanoとか
 * 開いたらリサイズ効いてない"). Deferring is now wrong for every path.
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
 *   - keys state by CHILD, not agent: one agent may hold up to 10 terminals,
 *     each with its own size and its own foreground program
 */
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

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
  // No /proc (macOS): ask `ps` which tty the child's descendants are on. This is what makes
  // it safe to drop the old "type `stty` into stdin" fallback — that path put a command line
  // into the terminal itself, so a foreground program (vim, less, a REPL) received it as
  // KEYSTROKES and it landed in the operator's buffer. A tty name from `ps` can be resized
  // with `stty -F`, which emits nothing into the stream.
  return ptySlaveViaPs(pid);
}

/**
 * The controlling tty of `pid` or any descendant, via `ps` (for hosts without /proc).
 *
 * `ps -o tty=` prints "ttys003" or "pts/3"; both name a device under /dev. A process with no
 * controlling terminal prints "??" (Linux) or "-", and those are skipped.
 */
function ptySlaveViaPs(pid: number): string | null {
  try {
    /**
     * Only the child's OWN tty, never one inherited from our process.
     *
     * `ps -o tty=` reports the CONTROLLING terminal, which a plain-pipe child still inherits
     * from whoever started the server — so naively taking it returns the tty of the shell that
     * launched teapot, and a resize would then ioctl THAT. Measured: a piped `/bin/sh` "resolved"
     * to the test runner's own tty. So require that the process has a tty which is NOT ours and
     * NOT our parent's, or report nothing.
     */
    const self = process.pid;
    const out = spawnSync("ps", ["-e", "-o", "pid=,ppid=,tty="], { encoding: "utf8" }).stdout ?? "";
    const rows = out
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 3 && Number.isInteger(Number(c[0])))
      .map((c) => ({ pid: Number(c[0]), ppid: Number(c[1]), tty: c[2]! }));
    const ttyOf = (p: number) => rows.find((r) => r.pid === p)?.tty;
    // the tty we and our own shell are on is inherited by children and proves nothing
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
interface TermState {
  rows: number;
  cols: number;
  timer: NodeJS.Timeout | null;
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
    const st = this.states.get(child) ?? { rows: 0, cols: 0, timer: null };
    this.states.set(child, st);
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    // already the applied size → nothing a shell could act on
    if (st.rows === rows && st.cols === cols) return;

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
    st.timer = setTimeout(apply, TERM_RESIZE_DEBOUNCE_MS);
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

/**
 * Apply a size to a child's pty — the ONLY way this codebase resizes a terminal.
 *
 * It shells out to `stty -F <slave>`, which is ioctl(TIOCSWINSZ) on the pty DEVICE. Nothing is
 * written to the child's stdin, so nothing can be typed into a foreground program.
 *
 * That distinction is the whole point (reported twice): writing `stty rows R cols C\n` into
 * stdin only works while a SHELL is reading it. When vim, less or a REPL owns the tty, the
 * PROGRAM reads, so the line arrives as KEYSTROKES and lands in the operator's document.
 *
 * When the slave cannot be resolved this does NOTHING. A resize that cannot be applied is
 * strictly better than one that types into somebody's buffer.
 *
 * `spawnFn` is injectable so a test can observe what would have been executed.
 */
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
