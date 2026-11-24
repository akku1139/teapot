import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { toolShellFor } from "../agent/tools.ts";
import { bus, type BusEvent } from "../bus.ts";

export function terminalShellFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean = existsSync,
): string {
  return toolShellFor(platform, env, exists).file;
}

/**
 * The argv that makes `script` run ONE command in a fresh pty.
 *
 * Two incompatible dialects, and passing the wrong one is silent: GNU util-linux is `script -q -e -c <command> <file>`, while
 * BSD/macOS is `script -q <file> <command…>` with no `-e` and no `-c`. BSD `script` given `-qec` reads it as the typescript
 * FILE and the shell name as something it cannot use, so the pty carries no shell at all and every terminal feature dies on
 * macOS. Exported so the tests spawn the same thing the server does — a fixture with its own copy of the GNU form tested the
 * fixture, not the product.
 */
/**
 * Which `script` dialect this host actually has, answered by TRYING it.
 *
 * The platform is not the answer: a GNU `script` can be installed on a Darwin host (and a BSD one on Linux), and the two
 * argv forms are mutually exclusive — GNU rejects positional command arguments (`unexpected number of arguments`), BSD
 * rejects `-c`. MEASURED: guessing from `process.platform` left the macOS job failing with `script` exiting 1 immediately
 * and no pty behind it, which reads as "pty discovery is broken" when the shell had never started.
 *
 * Both candidates are cheap and run ONCE per process; the first that exits 0 wins, and a host with neither gets null.
 */
let scriptDialectCache: "gnu" | "bsd" | null | undefined;

export function scriptDialect(
  spawnFn: typeof spawnSync = spawnSync,
  opts: { fresh?: boolean } = {},
): "gnu" | "bsd" | null {
  if (!opts.fresh && scriptDialectCache !== undefined) return scriptDialectCache;
  /**
   * The probe must answer "does this script UNDERSTAND this argv", not "can it allocate a pty in this process".
   *
   * A successful run needs stdin to be a terminal-ish fd: BSD `script` calls `tcgetattr(STDIN_FILENO)` and `err(1)`s unless
   * errno is ENOTTY or ENODEV, and a Node `stdio: "pipe"` is a SOCKETPAIR — so `script` dies with
   * `tcgetattr/ioctl: Operation not supported on socket` no matter which argv it was given. MEASURED: probing with
   * `stdio: "ignore"` (a real /dev/null, which IS ENOTTY) reported "bsd" while the actual spawn, with pipes, failed both
   * ways — a probe that answered a different question than the one the product asks.
   *
   * So the probe burns a BAD option instead. Both dialects reject an option they do not know, and they say WHICH in stderr:
   * BSD `script` prints `illegal option -- c` for `-c`, GNU prints `invalid option -- 'q'`-style for a form it cannot parse.
   * Neither attempt reaches the terminal setup, so the answer is the same under any stdio.
   */
  const stderrOf = (args: string[]): string => {
    const r = spawnFn("script", args, { encoding: "utf8" });
    return String(r.stderr ?? "");
  };
  const bsdSaid = stderrOf(["-c", "true"]);
  if (/illegal option -- c|invalid option -- '?c/.test(bsdSaid)) {
    // BSD: `-c` does not exist, which is the one flag the two dialects disagree about
    scriptDialectCache = "bsd";
    return scriptDialectCache;
  }
  const gnuSaid = stderrOf(["-q", "/dev/null", "--definitely-not-an-option"]);
  scriptDialectCache = /unrecognized option|invalid option/.test(gnuSaid) ? "gnu" : null;
  return scriptDialectCache;
}

/**
 * The argv for `script` that runs ONE command in a fresh pty.
 *
 * GNU takes the whole command line as ONE string (`-c "sleep 5"`); BSD takes the program and its arguments as separate
 * entries after the typescript file. Passing a single `"sleep 5"` to BSD makes it exec a program with a space in its name,
 * so the two forms cannot be built the same way — and the dialect is decided by `scriptDialect()`, which TRIES them, not by
 * `process.platform`.
 *
 * `dialect` is a parameter so a test can pin both forms without owning the host's `script`.
 */
export function scriptArgsFor(dialect: "gnu" | "bsd", command: string, args: string[] = []): string[] {
  return dialect === "bsd"
    ? ["-q", "/dev/null", command, ...args]
    : ["-qec", [command, ...args].join(" "), "/dev/null"];
}

export interface TerminalInfo {
  id: string;
  agentId: string;
  title: string;
  /** what the SHELL says its title is (OSC 0/2), if it ever says anything — see `noteTitle` */
  ptyTitle?: string;
  /** the shell's working directory — the tab label uses its basename */
  cwd?: string;
  clients: number;
  createdAt: number;
}

interface Term {
  id: string;
  agentId: string;
  title: string;
  /** what the shell said its title is (OSC 0/2) — see noteTitle */
  ptyTitle?: string;
  /** the directory the shell started in — the fallback label when /proc cannot be read */
  workspace: string;
  child: ChildProcess;
  buffer: string;
  createdAt: number;
  sizes: Map<unknown, { rows: number; cols: number }>;
  exited: boolean;
  code: number | null;
}

export type ResizeFn = (child: ChildProcess, rows: number, cols: number) => void;
let resizeFn: ResizeFn | null = null;
export type SlaveFn = (child: ChildProcess) => string | null;
let slaveFn: SlaveFn | null = null;
export function setTerminalResize(fn: ResizeFn, slave: SlaveFn): void {
  resizeFn = fn;
  slaveFn = slave;
}

const SEED_ROWS = 30;
const SEED_COLS = 100;

const BUFFER_BYTES = 200_000;
const MAX_PER_AGENT = 10;

const terms = new Map<string, Term>();
let seq = 0;

type Sink = (msg: { kind: "data"; data: string } | { kind: "exit"; code: number | null }) => void;
const sinks = new Map<string, Set<Sink>>();

function emit(id: string, msg: { kind: "data"; data: string } | { kind: "exit"; code: number | null }) {
  for (const s of sinks.get(id) ?? []) {
    try {
      s(msg);
    } catch {
    }
  }
}

function append(t: Term, chunk: string) {
  t.buffer += chunk;
  if (t.buffer.length > BUFFER_BYTES) t.buffer = t.buffer.slice(-BUFFER_BYTES);
}

/**
 * The environment a pty child gets.
 *
 * It used to carry `COLUMNS=100`/`LINES=30`, frozen at spawn. ncurses honours those variables OVER the terminal's
 * real size (`use_env(TRUE)` is its default), so a full-screen ncurses program — `nano` — ignored every resize while
 * a non-ncurses pager (`less`) followed the ioctl and worked. That is exactly the report: "lessで高さ調整が効いてるけど
 * nanoでは効いてません" (#172).
 *
 * The pty's size is authoritative and is applied with TIOCSWINSZ on attach and on every resize, so the environment must
 * not carry a competing copy of it.
 */
export function terminalEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, TERM: "xterm-256color" };
  delete env.COLUMNS;
  delete env.LINES;
  /**
   * A command the HARNESS types must not end up in the operator's history.
   *
   * `HISTCONTROL=ignorespace` is the standard way to say that: a line starting with a space is not recorded. Teapot writes
   * to the pty only for its own probing (the macOS resize fallback), and those lines are prefixed with a space because of
   * this. The operator's own typing is untouched (issue #229 is about history filling up with things they never typed).
   */
  if (!env.HISTCONTROL) env.HISTCONTROL = "ignorespace";
  return env;
}

export function createTerminal(
  agentId: string,
  workspace: string,
  title?: string,
): { ok: true; terminal: TerminalInfo } | { ok: false; error: string } {
  const live = [...terms.values()].filter((t) => t.agentId === agentId && !t.exited);
  if (live.length >= MAX_PER_AGENT) {
    return { ok: false, error: `too many terminals for this agent (max ${MAX_PER_AGENT})` };
  }
  const shell = terminalShellFor(process.platform, process.env);
  const hasScript = process.platform !== "win32" && existsSync("/usr/bin/script");
  const env = terminalEnv(process.env);
  /**
   * `script` exists in two incompatible dialects, and this used the GNU one.
   *
   * GNU util-linux: `script -q -e -c <command> <file>`. BSD/macOS: `script -q <file> <command…>` — there is no `-e`, no
   * `-c`, and the command is positional AFTER the typescript file. Passing `-qec` to BSD `script` makes it read `-qec` as
   * the file name and `shell` as a command it cannot find, so the pty never carries a usable shell and every terminal test
   * fails on macOS (`replay returns the output a client missed`, `input reaches the shell`).
   *
   * `process.platform` decides, because the dialect follows the OS: on Linux it is util-linux unless the operator installed
   * BSD script deliberately, and a runtime probe would need a successful spawn to answer.
   */
  const dialect = scriptDialect();
  const scriptArgs = dialect ? scriptArgsFor(dialect, shell) : null;
  /**
   * No usable `script` (neither dialect) is the same situation as no `script` at all: spawn the shell directly with
   * `TERM=dumb`, rather than handing `script` an argv it will reject and getting a pty that never carried a shell.
   */
  const child =
    hasScript && scriptArgs
      ? spawn("script", scriptArgs, { cwd: workspace, env, detached: true })
      : spawn(shell, [], { cwd: workspace, env: { ...env, TERM: "dumb" }, detached: true });

  const id = `t${++seq}-${Date.now().toString(36)}`;
  const t: Term = {
    id,
    workspace,
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
    noteTitle(t);
    emit(id, { kind: "data", data: s });
  });
  child.stderr?.on("data", (b: Buffer) => {
    const s = b.toString("utf8");
    append(t, s);
    noteTitle(t);
    emit(id, { kind: "data", data: s });
  });
  child.on("close", (code) => {
    t.exited = true;
    t.code = code;
    emit(id, { kind: "exit", code });
  });
  const seed = (tries: number) => {
    if (t.exited) return;
    if (slaveFn?.(child)) {
      if (t.sizes.size === 0) resizeFn?.(child, SEED_ROWS, SEED_COLS);
      return;
    }
    if (tries > 0) setTimeout(() => seed(tries - 1), 50);
  };
  setTimeout(() => seed(10), 30);
  console.log(`[teapot] ⌨ terminal open: ${id} ${agentId} @ ${workspace} (${hasScript ? "pty" : "pipe"})`);
  return { ok: true, terminal: infoOf(t) };
}

/**
 * The tab title comes from the SHELL, not from a poll.
 *
 * A program tells the terminal what to call it with `ESC ] 0 ; text BEL` (or `ESC ] 2 ; …`, or the ST-terminated
 * `ESC ] 0 ; text ESC \\`): that is what every real terminal shows in its title bar, and what `vim`, `ssh`, `htop` and a
 * plain `bash` prompt use to say where you are. Reading it out of the pty stream costs nothing and needs no timer — the
 * alternative was the client asking for the tab list every two seconds, which is exactly the "2秒間隔のポーリングはコスパ悪い"
 * (#238).
 *
 * A tab is pushed to the clients through the same bus every other update uses, and only when the text actually changed.
 */
const OSC_TITLE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

export function oscTitleFrom(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(OSC_TITLE)) last = m[1] ?? null;
  if (last === null) return null;
  const clean = last.replace(/\s+/g, " ").trim().slice(0, 60);
  return clean || null;
}

function noteTitle(t: Term): void {
  /**
   * Scan the ACCUMULATED tail, not the chunk.
   *
   * MEASURED: a pty hands over arbitrary slices, so `ESC ] 0 ; …` and its BEL routinely arrive in different chunks — the
   * shell's own prompt writes a title on every prompt, and every one of those was missed because the regex was applied to
   * one chunk at a time. The last 4KB is enough for any sane title sequence.
   */
  const clean = oscTitleFrom(t.buffer.slice(-4096));
  if (!clean || clean === t.ptyTitle) return;
  t.ptyTitle = clean;
  bus.emit("update", {
    kind: "terminal-title",
    agentId: t.agentId,
    terminalId: t.id,
    title: clean,
    cwd: shellCwd(t),
  } satisfies BusEvent);
}

/**
 * The shell's current directory, for the tab label.
 *
 * The pty is spawned through `script`, so `t.child.pid` is script's — the SHELL is its child, and it is the shell
 * whose cwd moves when the operator `cd`s. Reading `/proc/<pid>/cwd` is Linux-only and deliberately falls back to
 * the workspace: a wrong label is worse than a generic one, and this must never throw.
 */
function shellCwd(t: Term): string {
  try {
    const kids = readFileSync(`/proc/${t.child.pid}/task/${t.child.pid}/children`, "utf8").trim().split(/\s+/);
    for (const pid of kids) {
      if (!pid) continue;
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (cwd) return cwd;
    }
  } catch {
    /* not Linux, or the process is gone */
  }
  return t.workspace;
}

function infoOf(t: Term): TerminalInfo {
  return {
    id: t.id,
    agentId: t.agentId,
    title: t.title,
    ...(t.ptyTitle ? { ptyTitle: t.ptyTitle } : {}),
    cwd: shellCwd(t),
    clients: sinks.get(t.id)?.size ?? 0,
    createdAt: t.createdAt,
  };
}

export function listTerminals(): TerminalInfo[] {
  return [...terms.values()]
    .filter((t) => !t.exited)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(infoOf);
}

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

export function detachTerminal(id: string, sink: Sink): void {
  const set = sinks.get(id);
  if (!set) return;
  set.delete(sink);
  if (set.size === 0) sinks.delete(id);
}

export function resizeTerminal(id: string, sink: Sink, rows: number, cols: number): void {
  const t = terms.get(id);
  if (!t || t.exited) return;
  if (rows <= 0 || cols <= 0) return;
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

export function closeTerminal(id: string): boolean {
  const t = terms.get(id);
  if (!t) return false;
  if (!t.exited) killGroup(t);
  terms.delete(id);
  sinks.delete(id);
  console.log(`[teapot] ⌨ terminal closed: ${id}`);
  return true;
}

export function closeTerminalsFor(agentId: string): number {
  let n = 0;
  for (const t of [...terms.values()]) {
    if (t.agentId === agentId && closeTerminal(t.id)) n++;
  }
  return n;
}

export function closeAllTerminals(): number {
  let n = 0;
  for (const id of [...terms.keys()]) if (closeTerminal(id)) n++;
  return n;
}

/**
 * Close a terminal only when its PROCESS IS GONE and nobody is watching it.
 *
 * It used to also reap one that had been idle for 6 hours with no client attached — i.e. a terminal whose shell was
 * still perfectly alive disappeared because a sleeping browser had dropped its socket. Reported as
 * "全クライアントが離れたらターミナル消してる? ターミナルはサーバーが生きてる限り保持して欲しい".
 *
 * The operator's rule is the right one: a shell outlives a browser tab. Nothing here is leaked by that, because an
 * EXITED pty with no sink is still collected on the next pass.
 */
export function reapIdleTerminals(_now = Date.now()): number {
  let n = 0;
  for (const t of [...terms.values()]) {
    const attached = (sinks.get(t.id)?.size ?? 0) > 0;
    if (attached) continue;
    if (t.exited) {
      if (closeTerminal(t.id)) {
        n++;
        /**
         * Tell the UI, so the tab does not dangle.
         *
         * Reported as "長時間放置すると開いてたターミナルが消失する": the tab stayed in the strip pointing at an id
         * that no longer existed. With the idle rule gone this only fires for a REALLY exited shell, and the client
         * still removes the tab and says why.
         */
        bus.emit("update", {
          kind: "terminal-closed",
          terminalId: t.id,
          reason: "exited",
        } satisfies BusEvent);
      }
    }
  }
  return n;
}

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
      }
    }
  };
  signal("SIGHUP");
  const t2 = setTimeout(() => signal("SIGKILL"), 300);
  t2.unref?.();
}

export function _resetTerminalsForTest(): void {
  for (const t of terms.values()) killGroup(t);
  terms.clear();
  sinks.clear();
  seq = 0;
}

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

export function forgetTerminalSize(id: string, sink: unknown): void {
  const t = terms.get(id);
  if (!t) return;
  t.sizes.delete(sink);
  applySize(t);
}
