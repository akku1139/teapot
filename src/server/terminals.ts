import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { toolShellFor } from "../agent/tools.ts";

export function terminalShellFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean = existsSync,
): string {
  return toolShellFor(platform, env, exists).file;
}

export interface TerminalInfo {
  id: string;
  agentId: string;
  title: string;
  clients: number;
  createdAt: number;
}

interface Term {
  id: string;
  agentId: string;
  title: string;
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
const IDLE_REAP_MS = 6 * 60 * 60_000;

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
  const env = { ...process.env, TERM: "xterm-256color", COLUMNS: "100", LINES: "30" };
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

function infoOf(t: Term): TerminalInfo {
  return {
    id: t.id,
    agentId: t.agentId,
    title: t.title,
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
