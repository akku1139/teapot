/**
 * Terminal resize plumbing for the web terminal (#20).
 *
 * A resize is a property of the TTY, not a command. There is no pty handle
 * to ioctl(TIOCSWINSZ) here — the shell is reached through `script` (pty) or
 * a plain pipe — so the only lever available is writing `stty rows R cols C`
 * to the child's stdin. That makes it dangerous by default:
 *
 *  1. A drag-resize emits a burst of resize events. The old code wrote an
 *     `stty` line per event.
 *  2. Worse, when an interactive program owns the tty (vim, less, a python
 *     REPL), stdin is read by the PROGRAM, not by a shell — so the text is
 *     consumed as keystrokes and the line lands in your document/session.
 *
 * `TermSizeTracker` keeps that safe and quiet:
 *   - debounces to the trailing edge of a drag, so a burst costs ONE stty
 *   - remembers the applied size and skips no-op resizes entirely
 *   - defers while the child is producing output (markBusy), because a
 *     foreground program is exactly the case where typing is harmful
 *   - keys state by CHILD, not agent: one agent may hold up to 10 terminals,
 *     each with its own size and its own foreground program
 */
import type { ChildProcess } from "node:child_process";

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
   * Request a resize. Returns the number of `stty` lines that will actually
   * be written for this call (0 while a burst is still collapsing) — exposed
   * for tests and diagnostics.
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