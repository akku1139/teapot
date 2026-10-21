/**
 * Server-side terminals.
 *
 * ## Why this exists
 *
 * A terminal used to live entirely in one browser tab: the tab owned the list, the WebSocket
 * owned the pty, and `onClose` sent SIGHUP. So a reload destroyed the shells — reported as
 * "タブをリロードしたらターミナル消失したのがちょっと嬉しくない" — and two clients could never
 * see the same terminal.
 *
 * Now the SERVER owns them, keyed by an id, exactly as it owns agents: a terminal outlives any
 * one connection, several clients can attach to the same one, and a reload re-attaches and
 * replays what it missed.
 *
 * ## The three decisions that make sharing work
 *
 * 1. **A ring buffer of output.** A client that attaches late (a reload, a second window) needs
 *    the screen as it is NOW, not a raw byte stream from the beginning. The buffer keeps the
 *    last N bytes, which is enough to repaint a terminal after any realistic scrollback.
 * 2. **A disconnect is not a close.** `onClose` detaches; the pty keeps running. Only an
 *    explicit close (or the idle reaper) ends it — otherwise a reload would still kill the
 *    shell, just one step later.
 * 3. **One pty, many writers, last-resize-wins.** Input from any client is forwarded (that is
 *    what "shared" means); a resize takes the SMALLEST attached client's geometry, because a
 *    pty has one size and shrinking to the smallest keeps every viewer readable rather than
 *    letting one large window force horizontal scrolling on the others.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

export interface TerminalInfo {
  id: string;
  agentId: string;
  title: string;
  /** attached client count — 0 means nobody is watching, not "dead" */
  clients: number;
  createdAt: number;
}

interface Term {
  id: string;
  agentId: string;
  title: string;
  child: ChildProcess;
  /** last N bytes of output, for repainting a late attacher */
  buffer: string;
  createdAt: number;
  /** the size each attached client asked for; the pty gets the smallest */
  sizes: Map<unknown, { rows: number; cols: number }>;
  exited: boolean;
  code: number | null;
}

/**
 * Applies a pty size. Injected rather than imported: the real one lives in `api.ts` (it needs
 * `resolvePtySlave` and a debounce tracker), and a module-level import would create a cycle.
 */
export type ResizeFn = (child: ChildProcess, rows: number, cols: number) => void;
let resizeFn: ResizeFn | null = null;
/**
 * Resolve the pty slave of a child. Injected for the same reason as `resizeFn`: it lives in
 * `term-size.ts` next to the debounce tracker that `api.ts` owns.
 */
export type SlaveFn = (child: ChildProcess) => string | null;
let slaveFn: SlaveFn | null = null;
/** wire the size applier once, at server construction */
export function setTerminalResize(fn: ResizeFn, slave: SlaveFn): void {
  resizeFn = fn;
  slaveFn = slave;
}

/** keep this much recent output — enough for a full repaint after a reload */
const BUFFER_BYTES = 200_000;
/** how many terminals one agent may hold, matching the UI's 10-tab cap */
const MAX_PER_AGENT = 10;
/** an idle terminal with no client attached is reaped after this long */
const IDLE_REAP_MS = 6 * 60 * 60_000;

const terms = new Map<string, Term>();
let seq = 0;

/** subscribers per terminal, so a client can attach and receive future output */
type Sink = (msg: { kind: "data"; data: string } | { kind: "exit"; code: number | null }) => void;
const sinks = new Map<string, Set<Sink>>();

function emit(id: string, msg: { kind: "data"; data: string } | { kind: "exit"; code: number | null }) {
  for (const s of sinks.get(id) ?? []) {
    try {
      s(msg);
    } catch {
      /* that client is gone; onClose will unsubscribe it */
    }
  }
}

/** append to the ring buffer, keeping the newest BUFFER_BYTES */
function append(t: Term, chunk: string) {
  t.buffer += chunk;
  if (t.buffer.length > BUFFER_BYTES) t.buffer = t.buffer.slice(-BUFFER_BYTES);
}

/**
 * Start a terminal in an agent's workspace.
 *
 * Returns `null` (with a reason) instead of throwing, so the HTTP layer can answer 400/409
 * rather than 500 — a refused request is not a server fault.
 */
export function createTerminal(
  agentId: string,
  workspace: string,
  title?: string,
): { ok: true; terminal: TerminalInfo } | { ok: false; error: string } {
  const live = [...terms.values()].filter((t) => t.agentId === agentId && !t.exited);
  if (live.length >= MAX_PER_AGENT) {
    return { ok: false, error: `too many terminals for this agent (max ${MAX_PER_AGENT})` };
  }
  const shell = process.env.SHELL || "/bin/bash";
  const hasScript = existsSync("/usr/bin/script");
  // `script` reports a 0x0 winsize, so the shell falls back to these until a client resizes
  const env = { ...process.env, TERM: "xterm-256color", COLUMNS: "100", LINES: "30" };
  // `detached` puts the pty provider and the shell it forks into their OWN process group, so
  // closing the terminal can signal the GROUP. Signalling only `script` leaves the shell (and
  // anything running inside it) alive and holding the pipes open — which kept a test file from
  // exiting for a full minute after its work was done.
  const child = hasScript
    ? spawn("script", ["-qec", shell, "/dev/null"], { cwd: workspace, env, detached: true })
    : spawn(shell, [], { cwd: workspace, env: { ...env, TERM: "dumb" }, detached: true });

  const id = `t${++seq}-${Date.now().toString(36)}`;
  const t: Term = {
    id,
    agentId,
    title: title?.trim().slice(0, 60) || `shell ${live.length + 1}`,
    child,
    buffer: "",
    createdAt: Date.now(),
    sizes: new Map(),
    exited: false,
    code: null,
  };
  terms.set(id, t);

  child.stdout?.on("data", (b: Buffer) => {
    const s = b.toString("utf8");
    append(t, s);
    emit(id, { kind: "data", data: s });
  });
  child.stderr?.on("data", (b: Buffer) => {
    const s = b.toString("utf8");
    append(t, s);
    emit(id, { kind: "data", data: s });
  });
  child.on("close", (code) => {
    t.exited = true;
    t.code = code;
    emit(id, { kind: "exit", code });
  });
  /**
   * SEED the size.
   *
   * `script` gives the pty a 0x0 winsize, so a shell genuinely reports "0 0" and wraps at zero
   * columns until something sets it. A client resize would, but the shell prints its prompt
   * first — so the very first thing the operator sees is garbage wrapping. That is why the size
   * is seeded here rather than waiting for the socket.
   *
   * The slave does not exist until `script` has forked, so poll briefly; `script` forks within a
   * few ms and the fallback (no seed at all) is harmless if it never appears.
   */
  const seed = (tries: number) => {
    if (t.exited) return;
    // stop as soon as the slave resolves: re-applying to a pty that already has this size is
    // a no-op inside the tracker, but there is no reason to keep a timer alive
    if (slaveFn?.(child)) {
      resizeFn?.(child, 30, 100);
      return;
    }
    if (tries > 0) setTimeout(() => seed(tries - 1), 50);
  };
  setTimeout(() => seed(10), 30);
  console.log(`[teapot] ⌨ terminal open: ${id} ${agentId} @ ${workspace} (${hasScript ? "pty" : "pipe"})`);
  return { ok: true, terminal: infoOf(t) };
}

function infoOf(t: Term): TerminalInfo {
  return {
    id: t.id,
    agentId: t.agentId,
    title: t.title,
    clients: sinks.get(t.id)?.size ?? 0,
    createdAt: t.createdAt,
  };
}

/** every live terminal, oldest first — the list the UI renders */
export function listTerminals(): TerminalInfo[] {
  return [...terms.values()]
    .filter((t) => !t.exited)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(infoOf);
}

/**
 * Attach a client.
 *
 * The `replay` string is the buffered backlog, so the caller can paint the screen as it is now
 * before forwarding live output. Ordering matters: the sink is registered FIRST so nothing
 * produced between "snapshot the buffer" and "start forwarding" is lost; a duplicate line is
 * harmless, a missing one leaves the terminal visibly wrong.
 */
export function attachTerminal(
  id: string,
  sink: Sink,
  size?: { rows: number; cols: number },
): { ok: true; replay: string; terminal: TerminalInfo } | { ok: false; error: string } {
  const t = terms.get(id);
  if (!t || t.exited) return { ok: false, error: `no such terminal: ${id}` };
  let set = sinks.get(id);
  if (!set) {
    set = new Set();
    sinks.set(id, set);
  }
  set.add(sink);
  if (size && size.rows > 0 && size.cols > 0) {
    t.sizes.set(sink, size);
    applySize(t);
  }
  return { ok: true, replay: t.buffer, terminal: infoOf(t) };
}

/** drop a client; the pty keeps running (a reload must not kill the shell) */
export function detachTerminal(id: string, sink: Sink): void {
  const set = sinks.get(id);
  if (!set) return;
  set.delete(sink);
  if (set.size === 0) sinks.delete(id);
}

/** one client's view of the size; the pty gets the SMALLEST of them */
export function resizeTerminal(id: string, sink: Sink, rows: number, cols: number): void {
  const t = terms.get(id);
  if (!t || t.exited) return;
  if (rows <= 0 || cols <= 0) return;
  // keyed by the SINK: that is the per-client identity, so two windows can each report their
  // own size without overwriting one another
  t.sizes.set(sink, { rows, cols });
  applySize(t);
}

function applySize(t: Term): void {
  if (t.sizes.size === 0) return;
  let rows = Infinity;
  let cols = Infinity;
  for (const s of t.sizes.values()) {
    rows = Math.min(rows, s.rows);
    cols = Math.min(cols, s.cols);
  }
  if (!Number.isFinite(rows) || !Number.isFinite(cols)) return;
  resizeFn?.(t.child, rows, cols);
}

/** close one terminal for good, reporting whether it existed */
export function closeTerminal(id: string): boolean {
  const t = terms.get(id);
  if (!t) return false;
  if (!t.exited) killGroup(t);
  terms.delete(id);
  sinks.delete(id);
  console.log(`[teapot] ⌨ terminal closed: ${id}`);
  return true;
}

/** close everything for one agent — used when the agent is archived or the master stops */
export function closeTerminalsFor(agentId: string): number {
  let n = 0;
  for (const t of [...terms.values()]) {
    if (t.agentId === agentId && closeTerminal(t.id)) n++;
  }
  return n;
}

/** close every terminal (harness shutdown / dispose) */
export function closeAllTerminals(): number {
  let n = 0;
  for (const id of [...terms.keys()]) if (closeTerminal(id)) n++;
  return n;
}

/**
 * Reap terminals nobody has attached to for a long time.
 *
 * Without this, every abandoned tab keeps a shell alive for the life of the process: the whole
 * point of making terminals outlive a disconnect is that a reload re-attaches, but a closed tab
 * never will. The window is deliberately long (6h) — a terminal is the operator's workspace,
 * and reaping one they meant to come back to is much worse than holding a sleeping pty.
 */
export function reapIdleTerminals(now = Date.now()): number {
  let n = 0;
  for (const t of [...terms.values()]) {
    const attached = (sinks.get(t.id)?.size ?? 0) > 0;
    if (attached) continue;
    if (t.exited || now - t.createdAt > IDLE_REAP_MS) {
      if (closeTerminal(t.id)) n++;
    }
  }
  return n;
}

/** test seam: forget everything without touching processes */
/**
 * Signal the whole pty process group, not just `script`.
 *
 * `script` execs/forks the shell onto the pty; killing only the process we spawned orphans the
 * shell, which then keeps running with nobody attached and keeps the parent's pipes open. The
 * group is negative-pid, which is why the spawn is `detached`.
 */
function killGroup(t: Term): void {
  const pid = t.child.pid;
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (pid) process.kill(-pid, sig);
      else t.child.kill(sig);
    } catch {
      try {
        t.child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  signal("SIGHUP");
  /**
   * SIGHUP alone is not enough to release the pty.
   *
   * `script` holds the pty MASTER open; while it does, this process cannot exit because its
   * pipes are still attached — measured as a test file sitting idle for a full minute after
   * its work was done. Escalating to SIGKILL after a short grace is what actually reaps it.
   * `unref` on the timer keeps this from being a reason to stay alive itself.
   */
  const t2 = setTimeout(() => signal("SIGKILL"), 300);
  t2.unref?.();
}

export function _resetTerminalsForTest(): void {
  for (const t of terms.values()) killGroup(t);
  terms.clear();
  sinks.clear();
  seq = 0;
}

/** forward keystrokes to a terminal; a dead pty simply drops them */
export function writeTerminal(id: string, data: string): boolean {
  const t = terms.get(id);
  if (!t || t.exited) return false;
  if (!t.child.stdin?.writable) return false;
  try {
    t.child.stdin.write(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop letting one client's window size constrain the pty.
 *
 * A detaching client must be forgotten, or its (now stale) small geometry would keep forcing
 * every remaining attached client into a narrow pty forever.
 */
export function forgetTerminalSize(id: string, sink: unknown): void {
  const t = terms.get(id);
  if (!t) return;
  t.sizes.delete(sink);
  applySize(t);
}
