/**
 * Tool execution: file ops, shell (with process-group kill + timeout), git.
 * Tool specs are plain JSON-schema function definitions — provider-agnostic.
 */
import { spawn } from "node:child_process";
import { existsSync, promises as fs, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  discoverSkills,
  isValidSkillName,
  readSkillFile,
  saveSkill,
  SKILL_FILE,
  type SkillDef,
} from "./skills.ts";
import { isReasoningEffort } from "../model-meta.ts";
import { killTree, describeKill } from "./kill.ts";

export interface ToolContext {
  cwd: string;
  /** hard cap per command */
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  /** skill roots in priority order ([0] = workspace, wins on name clash) */
  skillRoots?: { dir: string; source: string }[];
  /** aborted on harness shutdown — kills in-flight commands immediately */
  signal?: AbortSignal;
  /** read-only persona: mutating tools are refused (enforced, not advisory) */
  readOnly?: boolean;
  /** sub-agent management hooks (wired by the master; absent → tools refuse) */
  subAgents?: {
    /** depth of THIS agent in the spawn tree (0 = top level) */
    depth: number;
    spawn(o: {
      task: string;
      context: "none" | "fork";
      name?: string;
      /** #105: per-spawn reasoning effort; falls back to the parent's */
      reasoning_effort?: string;
    }): Promise<{ id: string }>;
    list(): { id: string; status: string; goal: string }[];
    stop(ids?: string[]): Promise<{ stopped: string[] }>;
    message(id: string, text: string): Promise<void>;
    /**
     * Suspend until at least one listed sub-agent settles (finish/error/
     * stop/waiting) or the timeout lapses. Event-driven — costs nothing
     * while parked.
     */
    wait(ids: string[] | undefined, timeoutMs: number): Promise<{ note: string }>;
  };
  /**
   * Park/unpark the agent UI while a tool blocks for a long time
   * (wait_children). While parked the agent displays as idle-with-reason,
   * and any user prompt/stop wakes it immediately.
   */
  onIdlePark?: (reason: string) => void;
  onIdleUnpark?: () => void;
  /** re-arm the progress-report gate (waiting on children is not activity) */
  onProgressGateReset?: () => void;
  /**
   * The agent read a workspace file (read_file). The harness tracks the most
   * recently read files so it can re-inject them right after a compaction —
   * otherwise the model immediately re-reads the same files and burns turns.
   */
  onFileRead?: (path: string) => void;
  /**
   * A background shell (bash background=true) exited. The harness uses this
   * to notify the agent at its next turn boundary + log a timeline row —
   * without it the agent had to poll bash_output blindly to learn whether
   * (and how) a job finished.
   */
  onBackgroundExit?: (info: { id: string; code: number | null; cmd: string; durationMs: number; outputTail: string }) => void;
}

export interface ToolResult {
  ok: boolean;
  result: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated, ${s.length} bytes total]`;
}

async function readText(p: string): Promise<string> {
  return fs.readFile(p, "utf8");
}

/**
 * Line-ending handling (#84).
 *
 * A file's EOL is a property of the FILE, not of any one edit. Three forms
 * matter: LF (`\n`), CRLF (Windows, `\r\n`) and the old-Mac CR (`\r`).
 *
 * `edit_file` has handled CRLF since #61, but only on its hashline path, and
 * nothing detected CR-only files at all. Measured gaps before this:
 *
 *  - `read_file` splits on `\n` only, so a CR-only file came back as ONE line:
 *    the model could not address lines 2..n at all.
 *  - `write_file` wrote the model's content verbatim, so rewriting a CRLF file
 *    with LF content silently converted every line — a whole-file diff for what
 *    the model believed was a one-line change.
 *  - a mixed-EOL file was rewritten wholesale by any LF write.
 *
 * The detection is deliberately conservative: it reports the DOMINANT form and
 * only when the file is unambiguous. A genuinely mixed file is left alone rather
 * than homogenised, because picking a winner there would itself be a silent
 * whole-file rewrite — the very thing this is meant to prevent.
 */
export type Eol = "\n" | "\r\n" | "\r";

/**
 * The file's dominant line ending, or null when it is mixed or empty.
 *
 * `null` means "do not normalise" — see the note above.
 */
export function detectEol(text: string): Eol | null {
  if (!text) return null;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  // a bare CR is a CR not followed by LF
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const kinds = [crlf, cr, lf].filter((n) => n > 0).length;
  // one kind only -> unambiguous. Mixed -> null.
  if (kinds !== 1) return null;
  if (crlf > 0) return "\r\n";
  if (cr > 0) return "\r";
  return "\n";
}

/** Split on ANY of the three line endings, dropping the terminators. */
export function splitEolLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Re-apply `eol` to content the model supplied.
 *
 * Models emit `\n` essentially always, so a CRLF or CR file rewritten with LF
 * content would otherwise be silently converted. Untouched terminators already
 * in the right form are left alone, so this is safe to run on merged content.
 */
export function applyEol(content: string, eol: Eol | null): string {
  if (!eol || eol === "\n") return content;
  // normalise to \n first, then re-apply — avoids double-CR on "\r\n"
  return content.replace(/\r\n|\r|\n/g, eol);
}

/**
 * Optimistic-concurrency guard (#5). The model reads a file, thinks, then
 * writes — and in between, a sub-agent, a background job or the operator may
 * have changed it. Anchored edits usually fail safe (old_text is gone, so the
 * call errors), but two paths silently clobber work nobody looked at:
 * `replace_all` rewrites every occurrence present NOW, including ones that
 * appeared after the model formed its plan, and write_file/apply_patch replace
 * whole files unconditionally.
 *
 * A caller that passes `base_content` (the bytes it actually read) therefore
 * gets a refusal instead of a lost update — the same contract the web file
 * editor already enforces (see api.ts PUT /file). The check is advisory by
 * design: omitting the parameter keeps today's behaviour, so this can never
 * break a working agent loop that does not use it.
 */
function staleGuard(pathArg: string, base: unknown, current: string | null): ToolResult | null {
  if (typeof base !== "string") return null; // not supplied → no check
  if (base === current) return null; // unchanged → proceed
  const rel = pathArg;
  return {
    ok: false,
    result:
      `${rel} changed on disk since you read it — nothing was written.\n` +
      `your base_content: ${base.length} bytes, on disk now: ${current === null ? "(deleted)" : `${current.length} bytes`}.\n` +
      `Re-read ${rel}, redo the edit against the current content, and pass the fresh text as base_content.`,
  };
}

/** Read the file for a guarded write, or null when it does not exist. */
async function currentOrNull(p: string): Promise<string | null> {
  return fs.readFile(p, "utf8").catch(() => null);
}

/** Resolve a path inside the workspace; reject escapes (incl. symlink targets).
 *  KNOWN LIMIT (review finding, accepted): the check-then-open pattern has a
 *  TOCTOU window — a symlink swapped in between safeJoin() and fs.open() could
 *  point outside the workspace. Closing it needs openat(2)/O_NOFOLLOW at every
 *  call site; the operator-facing risk is low (requires workspace write access
 *  already), so we document rather than rewrite all call sites. */
export function safeJoin(cwd: string, p: string): string {
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  // symlinks inside the workspace can point anywhere — resolve the real target
  // and confine THAT too (path.resolve alone doesn't follow links)
  //
  // #74: the old code resolved `abs` and swallowed a throw, treating failure as
  // "fine". That is exactly backwards, and the failure is the NORMAL case:
  // `realpathSync` throws ENOENT for a file that does not exist yet, which is
  // every write_file creating something new. So `real` stayed as the LEXICAL
  // path — which is inside the workspace — and the symlink guard never ran.
  //
  // Demonstrated: with `esc -> /outside` (a real directory), safeJoin allowed
  // `esc/pwned.txt` and write_file wrote straight through it, landing outside
  // the workspace. The dangling case happened to fail later with ENOTDIR, which
  // is luck, not a control.
  //
  // So on ENOENT/ENOTDIR, resolve the nearest EXISTING ancestor instead of
  // giving up. That still catches the escape — the ancestor IS the symlink —
  // while allowing genuinely new files inside the workspace.
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      // Walk up one component at a time. A component that is itself a SYMLINK
      // must be resolved even when its target does not exist — realpathSync
      // throws ENOENT for the dangling link itself, so naively walking to the
      // first existing ancestor steps OVER the symlink and loses it. So read
      // the link and check its target directly.
      let probe = path.dirname(abs);
      for (;;) {
        try {
          real = realpathSync(probe);
          break;
        } catch (inner) {
          if ((inner as NodeJS.ErrnoException).code !== "ENOENT") break;
          // this component is a dangling symlink: resolve where it POINTS
          try {
            const target = readlinkSync(probe);
            real = path.isAbsolute(target) ? target : path.resolve(path.dirname(probe), target);
            break;
          } catch {
            /* not a symlink after all — keep walking */
          }
          const next = path.dirname(probe);
          if (next === probe) break; // reached the filesystem root
          probe = next;
        }
      }
      // keep the un-resolved tail so the comparison below sees the full path
      const tail = path.relative(probe, abs);
      if (tail && !tail.startsWith("..")) real = path.join(real, tail);
    }
  }
  const relReal = path.relative(cwd, real);
  if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
    throw new Error(`path escapes workspace via symlink: ${p}`);
  }
  return abs;
}

interface BgShell {
  id: string;
  cmd: string;
  child: import("node:child_process").ChildProcess;
  out: string;
  truncated: boolean;
  startedAt: number;
  exited: boolean;
  code: number | null;
}
/** per-workspace background shells (key: workspace path) */
const bgShellsByWs = new Map<string, Map<string, BgShell>>();
let bgSeq = 0;
/** how much of each job's output has already been handed to the model */
const bgReadCursors = new Map<string, number>();

function bgMapFor(cwd: string): Map<string, BgShell> {
  let m = bgShellsByWs.get(cwd);
  if (!m) {
    m = new Map();
    bgShellsByWs.set(cwd, m);
  }
  return m;
}

/**
 * Environment for every shell the agent runs.
 *
 * `PWD` is deliberately removed: the server's own PWD would contradict the
 * `cwd` we spawn with, so a command trusting `$PWD` would act on the wrong
 * directory (#34). `bash` re-creates PWD from its actual cwd.
 */
function shellEnv(): NodeJS.ProcessEnv {
  const { PWD: _pwd, ...rest } = process.env;
  return { ...rest, TERM: "dumb", GIT_PAGER: "cat", PAGER: "cat" };
}

/**
 * Human-readable elapsed-time suffix appended to a shell result so the MODEL
 * sees how long a command actually took (#26). Only the operator saw it — the
 * model happily re-issued commands that ran for tens of minutes.
 *
 * Kept terse and single-line: it rides along with the tool output, and mirrors
 * what bash_output already prints for a still-running job.
 */
export function elapsed(t0: number, now = Date.now()): string {
  return `\n[took ${((now - t0) / 1000).toFixed(1)}s]`;
}

function startBackgroundShell(cmd: string, ctx: ToolContext): string {
  const map = bgMapFor(ctx.cwd);
  // opportunistic cleanup of long-dead jobs so the map can't grow forever
  for (const [id, sh] of map) {
    if (sh.exited && Date.now() - sh.startedAt > 30 * 60_000 && !map.delete(id)) void id;
  }
  const id = `bg${++bgSeq}`;
  // plain `-c`, not `-lc`: a login shell sources ~/.bash_profile, whose `cd`
  // would move background jobs out of the workspace (#34)
  const child = spawn("/bin/bash", ["-c", cmd], {
    cwd: ctx.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: shellEnv(),
  });
  const sh: BgShell = {
    id, cmd, child,
    out: "", truncated: false,
    startedAt: Date.now(), exited: false, code: null,
  };
  const collect = (chunk: Buffer) => {
    if (sh.out.length < 200_000) sh.out += chunk.toString("utf8");
    else sh.truncated = true;
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  // "exit" (process gone) and "close" (all stdio drained) are DIFFERENT events.
  // A backgrounded grandchild that inherits stdout — `npm run dev &`,
  // `docker compose up &`, a script that forks a watcher — keeps the pipe open,
  // so "close" can stay pending long after the shell itself is dead. Keying
  // the exit state off "close" alone left such jobs marked running FOREVER:
  // hasRunningBgShells() said yes, the auto-continue loop kept breaking out on
  // "background job still running", and the agent sat in "running" with the
  // job long dead and no notification ever delivered (#23).
  //
  // So: "exit" is authoritative for state and for the completion
  // notification; "close" only means "output finally drained" and is used to
  // capture the tail. The notify() helper keeps this exactly-once.
  let exitNotified = false;
  const notify = (code: number | null) => {
    sh.exited = true;
    if (code !== null) sh.code = code;
    if (exitNotified) return;
    exitNotified = true;
    // tell the harness so the agent learns the outcome WITHOUT polling
    try {
      ctx.onBackgroundExit?.({
        id,
        code: sh.code,
        cmd,
        durationMs: Date.now() - sh.startedAt,
        outputTail: sh.out.slice(-2000),
      });
    } catch {
      /* notification is best-effort */
    }
  };
  child.on("exit", (code) => notify(code));
  child.on("close", (code) => notify(code));
  map.set(id, sh);
  return id;
}

/** Heuristic: did this provider error mean "prompt exceeded the context window"?
 *  Wording varies by provider (OpenRouter/OpenAI/Anthropic/local servers). */
export function isContextOverflow(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? "").toLowerCase();
  return (
    /context (length|window|limit)|too many tokens|prompt is too long|max.{0,12}tokens.{0,20}(exceed|surpass)|request too large|payload too large|exceeds.{0,20}limit/.test(
      msg,
    ) ||
    /\b(400|413)\b.*token/.test(msg) ||
    // #50: some gateways answer an over-long request with HTTP 200 and put the
    // real diagnosis in the body, which llm.ts now surfaces after the "no
    // choices" prefix. Without this the compact-and-retry recovery never
    // recognised it and the turn simply failed.
    /no choices:[\s\S]{0,300}context (length|window|limit)/.test(msg)
  );
}

/** Any background shell still running for this workspace? The auto-continue
 *  loop consults this before nudging a finished round: an agent that parked
 *  its work on `bash(background=true)` — dev server, watcher, long build —
 *  must NOT be nagged with "Continue working toward the current goal". The
 *  job's exit notification will wake the agent on its own. */
export function hasRunningBgShells(cwd: string): boolean {
  const m = bgShellsByWs.get(cwd);
  if (!m) return false;
  for (const sh of m.values()) {
    // opportunistic cleanup mirrors startBackgroundShell's
    if (sh.exited && Date.now() - sh.startedAt > 30 * 60_000) {
      m.delete(sh.id);
      continue;
    }
    if (!sh.exited) return true;
  }
  return false;
}

/** Run a command in its own process group; kill the whole group on timeout. */
function runShell(cmd: string, ctx: ToolContext, timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // `bash -l` sources /etc/profile + ~/.bash_profile, either of which may
    // `cd` somewhere — which silently moved every later relative path out of
    // the workspace (#34). Plain `-c` starts in ctx.cwd and stays there.
    const child = spawn("/bin/bash", ["-c", cmd], {
      cwd: ctx.cwd,
      detached: true, // own process group
      stdio: ["ignore", "pipe", "pipe"],
      env: shellEnv(),
    });
    let out = "";
    let done = false;
    let killReason: string | null = null;
    const collect = (chunk: Buffer) => {
      if (out.length < ctx.maxOutputBytes) out += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    // #110: the kill REPORTS whether it worked. It used to swallow every failure
    // as "already gone", and on Windows a group kill throws ALWAYS — so a timeout
    // would report `TIMEOUT after …ms` for a process that was still running, and
    // shutdown would leave it alive. A timeout that claims success is worse than
    // a crash, because nothing afterwards looks wrong.
    const killGroup = () => killTree(child);

    const timer = setTimeout(() => {
      killReason = `TIMEOUT after ${timeoutMs}ms — ${describeKill(killGroup())}`;
    }, timeoutMs);
    // harness shutdown must not wait out a long-running command
    const onAbort = () => {
      killReason = `ABORTED (harness shutdown) — ${describeKill(killGroup())}`;
    };
    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      if (!done) {
        done = true;
        resolve({ ok: false, result: `spawn error: ${err.message}${elapsed(t0)}` });
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      if (done) return;
      done = true;
      if (killReason) {
        resolve({
          ok: false,
          result: `${killReason}. Partial output:\n${clip(out.trim() || "(no output)", ctx.maxOutputBytes)}${elapsed(t0)}`,
        });
        return;
      }
      resolve({
        ok: code === 0,
        result:
          (code === 0 ? "" : `exit=${code}${signal ? ` signal=${signal}` : ""}\n`) +
          clip(out.trim() || "(no output)", ctx.maxOutputBytes) +
          // the model, not just the operator, needs to know a command was slow —
          // otherwise it happily re-issues something that takes 40 minutes (#26)
          elapsed(t0),
      });
    });
  });
}

/** 1-based line number of each occurrence of needle in text. */
function matchLines(text: string, needle: string): number[] {
  const out: number[] = [];
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    out.push(text.slice(0, idx).split("\n").length);
    idx = text.indexOf(needle, idx + Math.max(needle.length, 1));
  }
  return out;
}

/**
 * Fuzzy-but-safe locator: find windows of lines equal to the pattern after
 * trimming trailing whitespace on each side. Returns 0-based start line hits.
 */
function trailingWsMatches(srcLines: string[], patLines: string[]): number[] {
  const hits: number[] = [];
  for (let i = 0; i + patLines.length <= srcLines.length; i++) {
    let ok = true;
    for (let j = 0; j < patLines.length; j++) {
      if (srcLines[i + j]!.trimEnd() !== patLines[j]!.trimEnd()) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

/* ---------- read_url cache ---------- */
const URL_CACHE_TTL_MS = 3_600_000;
const urlCache = new Map<string, { at: number; text: string }>();

function clipText(s: string, max: number): string {
  const n = Math.max(1000, Math.min(max, 80_000));
  return s.length <= n ? s : `${s.slice(0, n)}\n… [truncated, ${s.length} chars total]`;
}

/**
 * Patterns that backtrack catastrophically (#93).
 *
 * A nested quantifier — a quantified group whose body is itself quantified, or
 * alternation that can match the same text more than one way — makes the engine
 * explore exponentially many splits. Measured on this codebase: `(a+)+b` against
 * 28 characters of "a" took 3.8s, roughly DOUBLING per character added, and a
 * 40-character line would run for days.
 *
 * There is no timeout on this path: `ctx.defaultTimeoutMs` guards `bash` only,
 * so the scan is a synchronous `re.test(line)` with nothing able to interrupt it.
 * The agent process blocks and takes the UI and every other agent with it.
 *
 * A model is poorly placed to reason about backtracking cost and nothing tells it
 * not to try, so the pattern is checked rather than trusted. This rejects the
 * SHAPE rather than trying to bound the runtime, because a synchronous regex
 * cannot be abandoned once `test` starts — the only reliable protection is to
 * never compile one.
 */
const BACKTRACKING_PATTERNS: { re: RegExp; why: string }[] = [
  // (a+)+  (a*)*  (a+)*  (a?)* … — a quantifier wrapping another quantifier
  { re: /\([^()]*[+*}][^()]*\)\s*[+*{]/, why: "a quantifier nested inside another quantifier" },
  // (a|a)+ — alternation whose branches can match the SAME text. Distinct
  // branches like (foo|bar)+ are fine and common, so this only fires when two
  // branches are literally identical, which is the shape that explodes.
  { re: /\(([^()|]*)\|\1\)\s*[+*{]/, why: "an alternation with identical branches inside a quantifier" },
  // (.*)*  (.+)+ — a wildcard quantified inside a quantifier
  { re: /\(\s*[.][*+]\s*\)\s*[+*{]/, why: "a wildcard quantified inside a quantifier" },
];

/** Above this, the O(lines x pattern) scan itself becomes the cost. */
const MAX_PATTERN_LENGTH = 1000;

/**
 * Compile a model-supplied regex, refusing ones that can backtrack
 * catastrophically.
 *
 * Returns an error STRING rather than a RegExp so every existing call site —
 * which already handles that shape for an invalid pattern — needs no change.
 */
function compileRegex(pattern: string, ignoreCase: boolean): RegExp | string {
  if (pattern.length > MAX_PATTERN_LENGTH)
    return `pattern too long (${pattern.length} chars, max ${MAX_PATTERN_LENGTH}) — narrow it, or grep for a literal substring instead`;
  for (const { re, why } of BACKTRACKING_PATTERNS) {
    if (re.test(pattern))
      return `pattern rejected: ${why} — that shape backtracks exponentially and would freeze the agent (e.g. "(a+)+b" against 28 characters takes 3.8s). Use a literal search, or simplify the pattern.`;
  }
  try {
    return new RegExp(pattern, ignoreCase ? "i" : "");
  } catch (e) {
    return `invalid regex: ${(e as Error).message}`;
  }
}

/* ---------- apply_patch (Codex-style) ----------
 * Port of the essentials of openai/codex apply-patch:
 *   *** Begin Patch
 *   *** Add File: path            (+lines follow)
 *   *** Delete File: path
 *   *** Update File: path         (*** Move to: dest = rename)
 *   @@ context hint               (single line to seek first)
 *    context / -removed / +added
 *   *** End of File               (anchor hunk at EOF)
 *   *** End Patch
 * Chunks are located with decreasing strictness (exact → rstrip → trim →
 * unicode-normalized), applied in order against a moving line index, and the
 * whole patch is validated BEFORE any byte is written.
 */

interface UpdateChunk {
  changeContext: string | null;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}
type PatchOp =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; movePath: string | null; chunks: UpdateChunk[] };

/** Codex seek_sequence: find pattern lines at/after `start`, loosening match rules stepwise. */
function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;
  const searchStart =
    eof && lines.length >= pattern.length ? Math.max(start, lines.length - pattern.length) : start;

  const eqExact = (a: string, b: string) => a === b;
  const eqRstrip = (a: string, b: string) => a.trimEnd() === b.trimEnd();
  const eqTrim = (a: string, b: string) => a.trim() === b.trim();
  // typographic dashes/quotes/spaces → ASCII, mirroring codex's final pass
  const normalise = (s: string) =>
    s
      .trim()
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .replace(/[\u2018-\u201B]/g, "'")
      .replace(/[\u201C-\u201F]/g, '"')
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
  const eqNorm = (a: string, b: string) => normalise(a) === normalise(b);

  for (const eq of [eqExact, eqRstrip, eqTrim, eqNorm]) {
    for (let i = searchStart; i + pattern.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < pattern.length; j++) {
        if (!eq(lines[i + j]!, pattern[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }
  return null;
}

function parsePatch(patch: string): PatchOp[] | string {
  let text = patch.trim();
  // lenient: strip a heredoc wrapper (<<EOF … EOF), as models sometimes emit one
  const lines0 = text.split("\n");
  if (
    lines0.length >= 4 &&
    ["<<EOF", "<<'EOF'", '<<"EOF"'].includes(lines0[0]!.trim()) &&
    lines0[lines0.length - 1]!.trimEnd().endsWith("EOF")
  ) {
    text = lines0.slice(1, -1).join("\n").trim();
  }
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines[0]?.trim() !== "*** Begin Patch") return `invalid patch: The first line must be '*** Begin Patch'`;

  // Backslash-corruption tripwire: models occasionally emit "\u0000" where a
  // literal backslash belonged (a provider-side JSON escaping failure, seen
  // live as 90× "\u0000sqrt{12}" in a LaTeX-heavy patch). Applying that
  // verbatim writes broken source; the model then burns turns repairing the
  // file (or discards its own work). Reject with an actionable message —
  // retrying the SAME patch won't help, so say what will.
  if (text.includes("\\u0000")) {
    const count = (text.match(/\\u0000/g) ?? []).length;
    return (
      `invalid patch: contains ${count} × "\\u0000" — this is mangled backslash output, not real content. ` +
      `Your escaping was corrupted in transit. Do NOT re-send the same patch and do NOT try to fix the file afterward; ` +
      `instead re-emit the patch with proper backslashes (e.g. \\sqrt), keeping it otherwise identical. ` +
      `If \\u0000 persists across retries, use write_file for new content or bash+python for edits instead.`
    );
  }
  if (lines[lines.length - 1]?.trim() !== "*** End Patch")
    return `invalid patch: The last line must be '*** End Patch'`;

  const ops: PatchOp[] = [];
  let i = 1;
  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trim();
    if (t === "*** End Patch") break;
    if (!t || t.startsWith("*** Environment ID:")) {
      i++;
      continue;
    }

    let m = t.match(/^\*\*\* Add File: (.+)$/);
    if (m) {
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.startsWith("+")) body.push(lines[i++]!.slice(1));
      if (body.length === 0) return `invalid patch: Add File hunk for '${m[1].trim()}' has no + lines`;
      ops.push({ kind: "add", path: m[1].trim(), contents: body.join("\n") + "\n" });
      continue;
    }
    m = t.match(/^\*\*\* Delete File: (.+)$/);
    if (m) {
      ops.push({ kind: "delete", path: m[1].trim() });
      i++;
      continue;
    }
    m = t.match(/^\*\*\* Update File: (.+)$/);
    if (m) {
      const filePath = m[1].trim();
      let movePath: string | null = null;
      i++;
      const mv = lines[i]?.trim().match(/^\*\*\* Move to: (.+)$/);
      if (mv) {
        movePath = mv[1].trim();
        i++;
      }
      const chunks: UpdateChunk[] = [];
      let cur: UpdateChunk | null = null;
      const flush = () => {
        if (cur) chunks.push(cur);
        cur = null;
      };
      while (i < lines.length && !lines[i]!.trim().startsWith("*** ")) {
        const l = lines[i]!;
        if (l.startsWith("@@")) {
          flush();
          cur = { changeContext: l.slice(2).trim() || null, oldLines: [], newLines: [], isEndOfFile: false };
          i++;
          continue;
        }
        if (l.startsWith("+") || l.startsWith("-") || l.startsWith(" ")) {
          cur ??= { changeContext: null, oldLines: [], newLines: [], isEndOfFile: false }; // implicit first chunk
          if (l.startsWith("+")) cur.newLines.push(l.slice(1));
          else if (l.startsWith("-")) cur.oldLines.push(l.slice(1));
          else {
            cur.oldLines.push(l.slice(1));
            cur.newLines.push(l.slice(1));
          }
          i++;
          continue;
        }
        if (l.trim() === "*** End of File") {
          if (!cur) return `invalid patch: *** End of File outside a hunk in '${filePath}'`;
          cur.isEndOfFile = true;
          i++;
          continue;
        }
        if (!l.trim()) {
          i++;
          continue; // blank between hunks
        }
        return `invalid patch: bad line in Update File '${filePath}': "${l.slice(0, 60)}" (expected ' ', '-', '+' or '@@')`;
      }
      flush();
      if (chunks.length === 0) return `invalid patch: Update File hunk for path '${filePath}' is empty`;
      ops.push({ kind: "update", path: filePath, movePath, chunks });
      continue;
    }
    return `invalid patch: unrecognized directive "${t.slice(0, 60)}"`;
  }
  return ops;
}

/** Compute the updated content of one file (no I/O writes). Error string on failure. */
async function deriveUpdate(
  p: string,
  displayPath: string,
  chunks: UpdateChunk[],
): Promise<{ content: string; note: string } | string> {
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch {
    return `Failed to read file to update ${displayPath}`;
  }
  const hadCrlf = raw.includes("\r\n");
  const originalLines = raw.split("\n");
  if (originalLines.at(-1) === "") originalLines.pop(); // trailing newline → diff-standard line list

  const replacements: [number, number, string[]][] = [];
  let lineIndex = 0;
  for (const ch of chunks) {
    if (ch.changeContext != null) {
      const idx = seekSequence(originalLines, [ch.changeContext], lineIndex, false);
      if (idx == null) return `Failed to find context '${ch.changeContext}' in ${displayPath}`;
      lineIndex = idx + 1;
    }
    let pattern = ch.oldLines;
    let newSlice = ch.newLines;
    if (pattern.length === 0) {
      // codex semantics: a chunk with no context/removed lines appends at end of file
      replacements.push([originalLines.length, 0, newSlice]);
      continue;
    }
    let found = seekSequence(originalLines, pattern, lineIndex, ch.isEndOfFile);
    if (found == null && pattern.at(-1) === "") {
      // trailing "" usually represents the file's final newline sentinel
      const p2 = pattern.slice(0, -1);
      const n2 = newSlice.at(-1) === "" ? newSlice.slice(0, -1) : newSlice;
      found = seekSequence(originalLines, p2, lineIndex, ch.isEndOfFile);
      if (found != null) {
        pattern = p2;
        newSlice = n2;
      }
    }
    if (found == null)
      return (
        `Failed to find expected lines in ${displayPath}:\n${pattern.join("\n")}\n` +
        `(re-read the file and regenerate the patch)`
      );
    replacements.push([found, pattern.length, newSlice]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((a, b) => b[0] - a[0]); // descending so earlier edits keep indices valid
  const out = originalLines.slice();
  for (const [startIdx, oldLen, seg] of replacements) out.splice(startIdx, oldLen, ...seg);
  if (out.at(-1) !== "") out.push("");
  return { content: out.join("\n"), note: hadCrlf ? " (CRLF→LF)" : "" };
}

async function applyPatch(patch: string, ctx: ToolContext): Promise<ToolResult> {
  const ops = parsePatch(patch);
  if (typeof ops === "string") return { ok: false, result: ops };
  if (ops.length === 0) return { ok: false, result: "patch contains no file operations" };

  // resolve every path up front (workspace confinement + duplicate guard)
  const seen = new Set<string>();
  interface Resolved {
    op: PatchOp;
    abs: string;
    absMove?: string;
  }
  const resolved: Resolved[] = [];
  try {
    for (const op of ops) {
      const abs = safeJoin(ctx.cwd, op.path);
      if (seen.has(abs)) return { ok: false, result: `path touched twice in one patch: ${op.path}` };
      seen.add(abs);
      const r: Resolved = { op, abs };
      if (op.kind === "update" && op.movePath) {
        r.absMove = safeJoin(ctx.cwd, op.movePath);
        if (r.absMove === abs) return { ok: false, result: `Move to: destination equals source (${op.path})` };
        seen.add(r.absMove);
      }
      resolved.push(r);
    }
  } catch (e) {
    return { ok: false, result: (e as Error).message };
  }

  // phase 1 — validate everything, write nothing
  const writes: { abs: string; content: string }[] = [];
  const deletes: string[] = [];
  const summary: string[] = [];
  try {
    for (const { op, abs, absMove } of resolved) {
      if (op.kind === "add") {
        if (existsSync(abs)) return { ok: false, result: `Add File: ${op.path} already exists` };
        writes.push({ abs, content: op.contents });
        summary.push(`A ${op.path} (+${op.contents.split("\n").length - 1})`);
      } else if (op.kind === "delete") {
        if (!existsSync(abs)) return { ok: false, result: `Delete File: ${op.path} not found` };
        deletes.push(abs);
        summary.push(`D ${op.path}`);
      } else {
        const r = await deriveUpdate(abs, op.path, op.chunks);
        if (typeof r === "string") return { ok: false, result: r };
        const dest = absMove ?? abs;
        if (absMove && existsSync(absMove))
          return { ok: false, result: `Move to: destination already exists (${op.movePath})` };
        writes.push({ abs: dest, content: r.content });
        if (absMove) deletes.push(abs);
        summary.push(`${absMove ? "R" : "U"} ${op.path}${absMove ? ` → ${op.movePath}` : ""} (${op.chunks.length} hunk${op.chunks.length > 1 ? "s" : ""})${r.note}`);
      }
    }
  } catch (e) {
    return { ok: false, result: `patch validation failed: ${(e as Error).message}` };
  }

  // phase 2 — commit.
  //
  // Phase 1 validates every hunk in memory, so a CONTENT mismatch never
  // lands halfway. An I/O failure still could: the old loop wrote straight
  // to the final paths, so a failure on write k of n left writes 1..k-1
  // already on disk while the tool reported "patch failed". apply_patch is
  // documented as atomic, so make the commit phase live up to it:
  //   1. back up the current bytes of every path we are about to change
  //   2. write each new file to a sibling temp file, then rename() over the
  //      target (rename within a directory is atomic, so a reader never
  //      observes a half-written file)
  //   3. on ANY failure, restore the backups and remove temp files
  // Deletes are only performed once every write has landed, and a failed
  // delete is now reported instead of silently swallowed.
  const backups = new Map<string, string | null>();
  const temps: string[] = [];
  try {
    for (const w of writes) {
      if (!backups.has(w.abs)) backups.set(w.abs, await fs.readFile(w.abs, "utf8").catch(() => null));
      await fs.mkdir(path.dirname(w.abs), { recursive: true });
      const tmp = `${w.abs}.teapot-patch-${process.pid}-${temps.length}.tmp`;
      temps.push(tmp);
      await fs.writeFile(tmp, w.content, "utf8");
      await fs.rename(tmp, w.abs);
    }
  } catch (e) {
    await rollbackWrites(backups, temps);
    return {
      ok: false,
      result:
        `patch commit failed and was rolled back (no files changed): ${(e as Error).message}\n` +
        "re-read the files and regenerate the patch",
    };
  }

  // writes are in — now the deletes. A delete that fails is a real, visible
  // inconsistency (the old content moved/updated but the source survived),
  // so roll the whole patch back rather than report a false success.
  const removed: string[] = [];
  try {
    for (const d of deletes) {
      await fs.rm(d);
      removed.push(d);
    }
  } catch (e) {
    for (const d of removed) {
      const orig = await fs.readFile(d, "utf8").catch(() => null);
      if (orig !== null) await fs.writeFile(d, orig, "utf8").catch(() => {});
    }
    await rollbackWrites(backups, temps);
    return {
      ok: false,
      result: `patch commit failed and was rolled back (no files changed): ${(e as Error).message}`,
    };
  }
  return { ok: true, result: `patch applied:\n${summary.join("\n")}` };
}

/**
 * Undo a partially committed patch: restore each target's original bytes
 * (null = it did not exist before, so remove the file we created) and clean
 * up any temp file that never made it through its rename.
 */
async function rollbackWrites(
  backups: Map<string, string | null>,
  temps: string[],
): Promise<void> {
  for (const t of temps) await fs.rm(t, { force: true }).catch(() => {});
  for (const [abs, orig] of backups) {
    if (orig === null) await fs.rm(abs, { force: true }).catch(() => {});
    else await fs.writeFile(abs, orig, "utf8").catch(() => {});
  }
}

/* ---------- hashline: stable, verifiable line anchors (#7 / #4) ----------
 *
 * The default `N| ` gutter is a trap: read_file prints it, but edit_file's
 * old_text must NOT contain it — so the model strips the gutter by hand on
 * every read, and the only mitigation is a sentence in the tool description.
 *
 * Format follows the established "hashline" convention used across AI coding
 * harnesses (quangdang46/hashline, kebbbnnn/hashline, opencode-hashline,
 * pi-hashline-edit-pro, …) so anchors read the same everywhere:
 *
 *     12:a3f1| function calculateTotal(items) {
 *
 * i.e. `LINE:HASH| content` — the line number is KEPT (humans and models both
 * navigate by line) and the content hash is ADDED as an integrity anchor.
 *
 * Design points taken from those implementations rather than invented:
 *  - the hash covers the STRIPPED content, so re-indenting a line does not
 *    invalidate its anchor;
 *  - blank/whitespace-only lines get a fixed reserved hash;
 *  - when a hash occurs more than once, the anchor's line number disambiguates
 *    via PROXIMITY search, instead of silently taking the first match.
 */

const HASH_BLANK = "    "; // 4 spaces: reserved, cannot collide with a hex hash
// A real hash is 4 HEX chars, but the shape also accepts other 4-8 char
// alphanumerics: a model that mistypes or invents an anchor is common enough
// that we should still recognise the SHAPE and say "that anchor is malformed"
// rather than falling through to "no similar text found" (#7).
const ANCHOR_RE = /^\s*(\d+):([0-9a-z]{4,8}| {4})\|/;

/** 4-char content hash (FNV-1a 32-bit → hex), of the STRIPPED line */
export function hashLine(content: string): string {
  const stripped = content.trim();
  if (!stripped) return HASH_BLANK;
  let h = 0x811c9dc5;
  for (let i = 0; i < stripped.length; i++) {
    h ^= stripped.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(-4);
}

/** `LINE:HASH| content` for each line, 1-indexed */
export function renderHashlines(lines: string[], startLine = 1): string {
  // same trailing-newline rule as renderGutter (#7): a file ending in "\n"
  // splits into a final "" that is not a line, and an anchor for it is a lie
  // the model can copy into an edit that then never verifies
  const body = lines.length && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  return body
    .map((l, i) => `${startLine + i}:${hashLine(l)}| ${l}`)
    .join("\n");
}

/**
 * Width of the `N| ` gutter for a page, so every line in it lines up.
 *
 * #7: the prefix had no padding, so the gutter silently widened at line 1000
 * and the whole block jumped sideways mid-file — the exact "unfriendly line
 * numbers" complaint. Padding to the widest number IN THE PAGE is enough: a
 * page is a bounded window, and aligning to the file's total length would
 * push every line of a 20-line read of a 500k-line file 6 characters right.
 */
export function gutterWidth(startLine: number, count: number): number {
  return String(Math.max(0, startLine - 1) + count).length;
}

/**
 * The default `N| ` display, with a stable gutter width and no phantom line.
 *
 * #7, second half: the prefix was added AFTER `text.split("\n")`, so a file
 * ending in a newline produced a final numbered row for a line that does not
 * exist. A model that copies the tail verbatim then hands `edit_file` an
 * old_text with a phantom line in it, and the edit fails for no visible reason.
 * A trailing empty element is dropped, which is what the reader means.
 */
export function renderGutter(lines: string[], startLine = 1): string {
  // a trailing newline splits into a final "" — not a line of the file
  const body = lines.length && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  if (!body.length) return "";
  const w = gutterWidth(startLine, body.length);
  return body.map((l, i) => `${String(startLine + i).padStart(w)}| ${l}`).join("\n");
}

/** parse a `LINE:HASH` anchor; returns null when the text is not an anchor */
export function parseAnchor(anchor: string): { line: number; hash: string } | null {
  const m = /^\s*(\d+):([0-9a-z]{4,8}| {4})\s*$/.exec(anchor);
  if (!m) return null;
  return { line: Number(m[1]), hash: m[2] };
}

/**
 * Locate the line an anchor refers to.
 *
 * The hash is authoritative; the line number only disambiguates when the same
 * content appears twice (proximity search). Falling back to "nearest line" for
 * an unknown hash is deliberately NOT done — that would silently edit the wrong
 * line, which is the entire failure mode hashline exists to prevent.
 */
export function resolveAnchor(
  lines: string[],
  anchor: { line: number; hash: string },
): { index: number; how: string } | { error: string } {
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) if (hashLine(lines[i]!) === anchor.hash) hits.push(i);
  if (!hits.length)
    return {
      error: /^[0-9a-f]{4}$/.test(anchor.hash) || anchor.hash === HASH_BLANK
        ? `no line matches hash ${anchor.hash} — the file changed since you read it (re-read it)`
        : // distinguish "you invented/mistyped this anchor" from "the file moved",
          // which sends the agent to fix the right thing (#7)
          `hash ${JSON.stringify(anchor.hash)} is not a valid anchor (expected 4 hex chars) — re-read the file and copy the anchor verbatim`,
    };
  if (hits.length === 1) return { index: hits[0]!, how: "unique" };
  const target = anchor.line - 1;
  const best = hits.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
  return { index: best, how: `ambiguous, resolved by proximity to line ${anchor.line}` };
}

/** Is this whole block a hashline block (every line carries an anchor)? */
export function isHashlineBlock(block: string): boolean {
  const rows = block.split("\n").filter((l) => l !== "");
  if (!rows.length) return false;
  return rows.every((l) => ANCHOR_RE.test(l));
}

/**
 * Turn a copied hashline block back into file content.
 *
 * The anchors are verified against the CURRENT file, so a stale read is
 * refused instead of editing the wrong bytes — the whole point of the format.
 */
export function resolveHashlineBlock(
  block: string,
  lines: string[],
): { text: string; indices: number[]; notes: string[] } | { error: string } {
  const rows = block.split("\n").filter((l) => l !== "");
  const picked: number[] = [];
  const content: string[] = [];
  const notes: string[] = [];
  const used = new Set<number>();
  for (const row of rows) {
    const a = parseAnchor(row.slice(0, row.indexOf("|")));
    if (!a) return { error: `not a valid hashline anchor: ${row.slice(0, 12)}…` };
    const r = resolveAnchor(lines, a);
    if ("error" in r) return { error: r.error };
    if (used.has(r.index))
      return { error: `anchor ${a.line}:${a.hash} resolves to a line already used in this block` };
    used.add(r.index);
    picked.push(r.index);
    content.push(lines[r.index]!);
    if (r.how !== "unique") notes.push(r.how);
  }
  if (!picked.length) return { error: "empty hashline block" };
  return { text: content.join("\n"), indices: picked, notes };
}

/** normalize the read_file line-reference argument */
export function lineIdMode(args: Record<string, unknown>): "none" | "hash" {
  const v = args.line_ids ?? args.hashline;
  if (v === true) return "hash";
  const s = String(v ?? "").trim().toLowerCase();
  return s === "hash" || s === "hashline" || s === "true" ? "hash" : "none";
}

export const TOOLS: ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read a text file from the workspace. Returns numbered lines (`N| ` prefixes are display-only — never copy them into edit_file). " +
      "With `line_ids:\"hash\"` it instead returns `LINE:HASH| content` anchors (the hashline format used by other coding harnesses), " +
      "which edit_file accepts VERBATIM and re-verifies against the file — so prefer it when you intend to edit what you just read. " +
      "Pass `paths` (max 10) to read SEVERAL files in one call instead of one call per file; " +
      "pass `fuzzy` when you do not know the exact path. " +
      "With `pattern`, acts like grep: only matching lines (JS regex, optional `ignore_case`) plus `context` surrounding lines are returned. " +
      "A negative `offset` counts from the end (-30 → last 30 lines, or last 30 matches in pattern mode).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root" },
        offset: { type: "number", description: "1-indexed start line (negative = from end)" },
        limit: { type: "number", description: "Max lines (or max matches in pattern mode)" },
        pattern: { type: "string", description: "JS regex — return only matching lines (+context) instead of the whole file" },
        context: { type: "number", description: "context lines around each pattern match (max 5)" },
        ignore_case: { type: "boolean", description: "case-insensitive pattern matching" },
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Read SEVERAL files in one call (max 10) instead of one call per file. " +
            "Each comes back under its own `--- path ---` header, and a file that " +
            "cannot be read is reported inline without failing the others.",
        },
        fuzzy: {
          type: "string",
          description:
            "Read the file when you do not know its exact path. Matches loosely " +
            "(characters in order, ignoring separators and case); if several files " +
            "match it lists them so you can pick the right one with `path`.",
        },
        line_ids: {
          type: "string",
          enum: ["none", "hash"],
          description:
            "'hash' → `LINE:HASH| content` anchors that you can hand to edit_file VERBATIM; " +
            "the hash is verified against the file, so a stale read is refused instead of editing the wrong lines. " +
            "'none' (default) → `N| ` gutters, which are display-only and must be stripped by hand.",
        },
      },
      required: ["path"],
    },
    async run(args, ctx) {
      // #16: MULTI-FILE and FUZZY reads.
      //
      // Both are opt-in and handled HERE rather than by restructuring this
      // tool: `paths` re-enters executeTool once per file, and `fuzzy` locates
      // a file then re-enters it. Nothing about the single-file path below
      // changes, so its output stays byte-identical — which #7's hashline
      // anchors and the existing tests both depend on.
      if (Array.isArray(args.paths) && args.paths.length) {
        const wanted = (args.paths as unknown[])
          .map((v) => str(v).trim())
          .filter(Boolean);
        if (!wanted.length) return { ok: false, result: "paths must contain at least one path" };
        if (wanted.length > MAX_MULTI_READ) {
          return {
            ok: false,
            result: `too many paths (${wanted.length}); the maximum is ${MAX_MULTI_READ} — read fewer files per call`,
          };
        }
        const chunks: string[] = [];
        for (const rel of wanted) {
          const r = await executeTool("read_file", JSON.stringify({ ...args, path: rel, paths: undefined }), ctx);
          // one bad file must not sink the others: report it inline
          chunks.push(`--- ${rel} ---\n${r.ok ? r.result : `ERROR: ${r.result}`}`);
        }
        return { ok: true, result: chunks.join("\n\n") };
      }
      if (args.fuzzy) return fuzzyRead(str(args.fuzzy), ctx, args as Record<string, unknown>);
      const p = safeJoin(ctx.cwd, str(args.path));
      let text: string;
      try {
        text = await readText(p);
      } catch (err) {
        // name the file, not just the errno: a multi-file read reports each bad
        // path inline, and "ENOENT … /tmp/xyz/nope.ts" leaves the model to work
        // out which of the paths it asked for (#16)
        const code = (err as NodeJS.ErrnoException).code;
        return {
          ok: false,
          result: code === "ENOENT" ? `cannot read ${str(args.path)}: no such file` : `cannot read ${str(args.path)}: ${(err as Error).message}`,
        };
      }
      ctx.onFileRead?.(str(args.path));
      // #84: split on ALL THREE line endings. A CR-only (old-Mac) file used to
      // come back as a single line, so the model could not address lines 2..n at
      // all — and a CRLF file left a trailing "\r" on every line, which then
      // had to be stripped again by every consumer.
      const lines = splitEolLines(text);
      // #7/#4: opt-in hashline output. Default stays the historical `N| ` so
      // nothing that depends on it changes until the mode is chosen.
      const idMode = lineIdMode(args as Record<string, unknown>);

      // grep mode
      if (typeof args.pattern === "string" && args.pattern !== "") {
        const re = compileRegex(args.pattern, args.ignore_case === true);
        if (typeof re === "string") return { ok: false, result: re };
        const idxs: number[] = [];
        for (let i = 0; i < lines.length; i++) if (re.test(lines[i]!)) idxs.push(i);
        if (idxs.length === 0) return { ok: true, result: `(no matches for /${args.pattern}/)` };

        let off = num(args.offset, 1);
        off = off < 0 ? Math.max(0, idxs.length + off) : Math.max(0, off - 1);
        const lim = Math.min(num(args.limit, 100), 1000);
        const page = idxs.slice(off, off + lim);

        const cN = Math.max(0, Math.min(num(args.context, 0), 5));
        const regions: [number, number][] = [];
        for (const m of page) {
          const s = Math.max(0, m - cN);
          const e = Math.min(lines.length - 1, m + cN);
          const last = regions[regions.length - 1];
          if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
          else regions.push([s, e]);
        }
        const parts = regions.map(([s, e]) =>
          idMode === "hash"
            ? renderHashlines(lines.slice(s, e + 1), s + 1)
            : renderGutter(lines.slice(s, e + 1), s + 1),
        );
        let result = parts.join("\n--\n");
        if (idxs.length > page.length || off > 0)
          result += `\n(${off + 1}–${off + page.length} of ${idxs.length} matches)`;
        return { ok: true, result };
      }

      // plain mode
      let off = num(args.offset, 1);
      off = off < 0 ? Math.max(0, lines.length + off) : Math.max(0, off - 1);
      const lim = num(args.limit, 2000);
      const pageLines = lines.slice(off, off + lim);
      const slice =
        idMode === "hash" ? renderHashlines(pageLines, off + 1) : renderGutter(pageLines, off + 1);
      // the phantom trailing line is dropped for the count too, or a file that
      // ends in a newline always reports one line more than it has
      const total = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      const more = off + lim < total ? `\n... (${total - off - lim} more lines)` : "";
      return { ok: true, result: slice + more };
    },
  },
  {
    name: "write_file",
    description:
      "Create ONE new file, or replace a file's entire content (parent dirs auto-created). " +
      "Creating files as part of a larger batch of edits → one apply_patch instead. " +
      "Partial changes to an existing file → edit_file. " +
      "Pass base_content (the bytes you read) when rewriting a file that may have changed under you — the write is refused rather than clobbering a concurrent edit.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        base_content: {
          type: "string",
          description:
            "Optional: the exact bytes you read before writing. The write is REFUSED if the file changed since — re-read and retry instead of clobbering someone else's edit.",
        },
      },
      required: ["path", "content"],
    },
    async run(args, ctx) {
      // content must be a real string: a non-string (object/array from bad
      // model output) coerced to "[object Object]" or silently truncated —
      // worse, an undefined slipped past required and WIPED the file
      if (typeof args.content !== "string") {
        return {
          ok: false,
          result:
            "content must be a string (got " +
            (args.content === null ? "null" : typeof args.content) +
            ") — nothing was written",
        };
      }
      const p = safeJoin(ctx.cwd, str(args.path));
      const stale = staleGuard(str(args.path), args.base_content, await currentOrNull(p));
      if (stale) return stale;
      await fs.mkdir(path.dirname(p), { recursive: true });
      // #84: a file's line endings belong to the FILE. Writing the model's
      // content verbatim silently converted a CRLF (or CR) file to LF whenever
      // the model rewrote it — the model never emits \r — so one logical edit
      // produced a whole-file diff, and any tool that normalises on EOL (git,
      // prettier) would rewrite it afterwards.
      //
      // So an EXISTING file's dominant EOL is re-applied. detectEol returns null
      // for a mixed file, which is left untouched on purpose: choosing a winner
      // there would itself be the silent whole-file rewrite this prevents.
      const before = await currentOrNull(p);
      const eol = before === null ? null : detectEol(before);
      const out = applyEol(args.content, eol);
      await fs.writeFile(p, out, "utf8");
      const converted = eol !== null && eol !== "\n" && out !== args.content;
      return {
        ok: true,
        result:
          `wrote ${p} (${out.length} bytes)` +
          (converted ? ` (kept ${eol === "\r\n" ? "CRLF" : "CR"} line endings)` : ""),
      };
    },
  },
  {
    name: "edit_file",
    description:
      "Make exactly ONE small, unique replacement in one existing file — the cheapest tool for a single spot change. " +
      "Copy old_text from the file contents (NOT from read_file's `N| ` prefixed display); it must appear exactly once — " +
      "if it matches several places, add surrounding lines or pass replace_all=true. " +
      "Or read with read_file(line_ids:\"hash\") and pass that block VERBATIM — `LINE:HASH| ` anchors are verified against the " +
      "current file, and a block whose anchors no longer match is refused as a stale read instead of editing the wrong lines. " +
      "Two or more changes (or a rename/delete) → use apply_patch instead. " +
      "Pass base_content (the bytes you read) whenever the file may have changed under you — especially with replace_all, which otherwise rewrites occurrences that appeared after you read.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
        replace_all: { type: "boolean", description: "replace every occurrence instead of requiring uniqueness" },
        base_content: {
          type: "string",
          description:
            "Optional: the exact bytes you read before editing. Refuses the edit if the file changed since — important with replace_all, which otherwise rewrites occurrences that appeared after you read.",
        },
      },
      required: ["path", "old_text", "new_text"],
    },
    async run(args, ctx) {
      const p = safeJoin(ctx.cwd, str(args.path));
      let text = await readText(p);
      const stale = staleGuard(str(args.path), args.base_content, text);
      if (stale) return stale;
      let oldText = str(args.old_text);
      const newText = str(args.new_text);
      // #126: the single most common edit_file failure in the real logs (22
      // occurrences) said only "old_text is required", while the tool's own
      // schema already documents the better form. Name it and say what to do —
      // the pattern master.ts uses for "not your sub-agent" (master.ts:979),
      // which turned a confusing refusal into a re-addressable one.
      if (!oldText)
        return {
          ok: false,
          result:
            "old_text is required — pass the exact text to replace, or read with " +
            '`read_file({line_ids:"hash"})` and pass that block VERBATIM as old_text. ' +
            "Do NOT copy read_file's `N| ` line-number prefixes.",
        };
      const replaceAll = args.replace_all === true;
      // #7/#4: accept a block copied straight out of read_file's hashline
      // output. When the anchors do not verify we FAIL with the specific reason
      // rather than silently falling back to literal matching — a literal match
      // that happened to succeed would edit the wrong bytes, which is the exact
      // failure mode hashline exists to prevent.
      //
      // On success we edit by RESOLVED LINE INDEX rather than by searching for
      // the text: the anchors already pinpointed the lines, so a block whose
      // content legitimately appears twice (the case proximity search exists
      // for) must not then fail the uniqueness check on the resolved text.
      let hashNote = "";
      let hashNotes: string[] = [];
      let hashSpan: { start: number; end: number } | null = null;
      if (isHashlineBlock(oldText)) {
        const srcLines = text.replace(/\r\n/g, "\n").split("\n");
        const r = resolveHashlineBlock(oldText, srcLines);
        if ("error" in r) hashNote = r.error;
        else {
          oldText = r.text;
          hashNotes = r.notes;
          hashSpan = { start: r.indices[0]!, end: r.indices[r.indices.length - 1]! + 1 };
        }
      }
      let count = hashNote ? 0 : text.split(oldText).length - 1;
      let normalized = false;
      if (count === 0 && oldText.includes("\n") && text.includes("\r\n")) {
        const lf = text.replace(/\r\n/g, "\n");
        const lfCount = lf.split(oldText).length - 1;
        if (lfCount >= 1) {
          text = lf;
          count = lfCount;
          normalized = true;
        }
      }

      // tolerate patterns whose only difference is trailing whitespace per line
      // (the most common near-miss) — applied only when it resolves uniquely
      if (count === 0) {
        const srcLines = text.replace(/\r\n/g, "\n").split("\n");
        const patLines = oldText.replace(/\r\n/g, "\n").split("\n");
        const hits = trailingWsMatches(srcLines, patLines);
        if (hits.length === 1 && patLines.length > 0) {
        // #84: same detection as the hashline path — CR-only files are detected
        // too, and a MIXED file yields null and is left as-is rather than
        // homogenised. The old `includes("\r\n")` test called a CR-only file
        // "\n", so an edit to one silently converted its line endings.
        const rebuilt = [
          ...srcLines.slice(0, hits[0]),
          ...splitEolLines(newText),
          ...srcLines.slice(hits[0]! + patLines.length),
        ].join(detectEol(text) ?? "\n");
          await fs.writeFile(p, rebuilt, "utf8");
          return {
            ok: true,
            result: `edited (matched ignoring trailing whitespace around ${path.basename(str(args.path))}:${hits[0]! + 1})`,
          };
        }
        if (hits.length > 1)
          return {
            ok: false,
            result: `old_text matched ${hits.length} times ignoring trailing whitespace (lines ${hits.map((h) => h + 1).join(", ")}); add surrounding lines to disambiguate`,
          };
      }

      if (count === 0) {
        // actionable miss: point the model at recovery instead of pushing it
        // toward bash-based editing
        const lines = matchLines(text, oldText.trim());
        const hint = lines.length
          ? `A trimmed variant appears at line(s) ${lines.slice(0, 5).join(", ")}.`
          : `No similar text found — re-read ${str(args.path)} around the target area and copy old_text exactly.`;
        return {
          ok: false,
          // a hashline block that did not resolve gets ITS reason — the generic
          // "not found" would send the model hunting for a whitespace problem
          // when the real issue is a stale read (#7)
          result: hashNote
            ? `old_text is a hashline block but did not resolve: ${hashNote}.`
            : `old_text not found in file. ${hint} Watch indentation/trailing spaces and drop the \`N| \` line-number prefixes.`,
        };
      }
      if (count > 1 && !replaceAll && !hashSpan) {
        const at = matchLines(text, oldText);
        return {
          ok: false,
          result: `old_text matched ${count} times (lines ${at.slice(0, 5).join(", ")}) and must be unique — add surrounding lines to old_text, or pass replace_all=true`,
        };
      }
      // A verified hashline block is addressed BY LINE INDEX: the anchors
      // already proved which lines it means, so a block whose content occurs
      // twice must still edit the anchored occurrence rather than fail the
      // uniqueness check (#4).
      // The hashline path splits on "\n" to index by resolved line number, which
      // leaves a trailing "\r" on every line of a CRLF file. Rejoining with
      // "\n" then DROPS all of them, so a single edit silently rewrote a
      // Windows file's line endings: the replaced line arrived with the model's
      // "\n" while every untouched line kept its "\r\n". The file still parsed
      // and the edit "succeeded", so nothing reported it — but the next
      // checkout diff shows the whole file changed, and tools that normalise on
      // EOL (git, prettier, formatters) now rewrite it.
      //
      // So the EOL is detected ONCE from the untouched text and re-applied to
      // the replacement, which also keeps a CRLF file CRLF when the model sends
      // LF-separated new_text (the overwhelmingly common case — models never
      // emit \r).
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      const out = hashSpan
        ? splitEolLines(text)
            .slice(0, hashSpan.start)
            .concat(splitEolLines(newText), splitEolLines(text).slice(hashSpan.end))
            .join(eol ?? "\n")
        : replaceAll
          ? text.split(oldText).join(newText)
          : text.replace(oldText, newText);
      await fs.writeFile(p, out, "utf8");
      const where = hashSpan
        ? ` (lines ${hashSpan.start + 1}–${hashSpan.end}, verified by hash anchor)`
        : count > 1
          ? ` (${count} occurrences)`
          : "";
      return {
        ok: true,
        result:
          `${replaceAll && !hashSpan ? "replaced all" : "edited"}${where}` +
          `${hashNotes.length ? ` (${hashNotes[0]})` : ""}` +
          `${normalized ? " (file converted CRLF→LF)" : ""}`,
      };
    },
  },
  {
    name: "apply_patch",
    description:
      "Apply a Codex-style patch: several edits in one file, changes across MULTIPLE files, renames, deletes — " +
      "all validated first and applied atomically (any failure → nothing is written). Reach for this whenever " +
      "one edit_file call would not cover the change. Every hunk is located with whitespace-tolerant fallbacks. Format:\n" +
      '*** Begin Patch\n*** Add File: rel/new.txt\n+created line\n*** Update File: src/app.py\n@@ def main():\n context line\n-old line\n+new line\n*** Move to: src/main.py\n*** Delete File: obsolete.txt\n*** End Patch\n' +
      "Update hunks: lines prefixed ' ' are context, '-' removed, '+' added. '@@ hint' optionally locates the area first; " +
      "several hunks apply top-to-bottom. A hunk with only + lines appends at end of file; " +
      "'*** End of File' anchors a hunk at the tail. For a single tiny replacement, edit_file is cheaper.",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string", description: "the full *** Begin Patch … *** End Patch text" },
      },
      required: ["patch"],
    },
    async run(args, ctx) {
      return applyPatch(str(args.patch), ctx);
    },
  },
  {
    name: "list_dir",
    description: "List files under a directory of the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "default '.'" } },
    },
    async run(args, ctx) {
      const p = safeJoin(ctx.cwd, str(args.path, "."));
      const entries = await fs.readdir(p, { withFileTypes: true });
      return {
        ok: true,
        result: entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n"),
      };
    },
  },
  {
    name: "bash",
    description:
      "Run a bash command inside the workspace — git, builds, tests, searches and other COMMANDS. " +
      "Also fine for quick shell-style file edits (sed/awk bulk transforms) when that is genuinely the better tool; " +
      "for most changes the file tools below are easier to get right (no quoting, validated before writing). " +
      "Killed (whole process group) on timeout. stdout+stderr are returned.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "number", description: `default ${DEFAULT_TIMEOUT_MS}` },
        background: {
          type: "boolean",
          description:
            "true = start the command and return IMMEDIATELY with a job id. You are NOTIFIED at your " +
            "next turn boundary when it exits (exit code + output tail) — no polling needed. " +
            "Use bash_output only to fetch FULL output mid-run or after. Use for dev servers, watchers, long builds.",
        },
      },
      required: ["command"],
    },
    async run(args, ctx) {
      if (args.background === true) {
        const id = startBackgroundShell(str(args.command), ctx);
        return {
          ok: true,
          result:
            `started in background (job ${id}). It runs while you work — you'll be notified here ` +
            `when it exits (exit code + output tail). Full output: bash_output(job_id="${id}"). ` +
            `Kill: bash_output(job_id="${id}", action="kill").`,
        };
      }
      return runShell(str(args.command), ctx, Math.min(num(args.timeout_ms, ctx.defaultTimeoutMs), 600_000));
    },
  },
  {
    name: "bash_output",
    description:
      "Read or manage a background shell started via bash(background=true). " +
      "action 'read' returns new output since the last read (plus exit status when done); " +
      "'kill' terminates the whole process group. Use this instead of re-running long commands.",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "the job id returned by bash(background=true)" },
        action: {
          type: "string",
          enum: ["read", "kill"],
          description: "default 'read'",
        },
      },
      required: ["job_id"],
    },
    async run(args, ctx) {
      const map = bgMapFor(ctx.cwd);
      const sh = map.get(str(args.job_id));
      if (!sh)
        return {
          ok: false,
          result:
            `unknown background job "${str(args.job_id)}" in this workspace — ` +
            `jobs are per-workspace and forgotten on harness restart`,
        };
      if (str(args.action) === "kill") {
        // #110: same swallowed-kill bug — this reported "killed" and dropped the
        // job from the map while the process kept running, now untrackable.
        const note = sh.exited ? "(already exited)" : describeKill(killTree(sh.child));
        map.delete(sh.id);
        return { ok: true, result: `job ${sh.id} ${note}. Output so far:\n${clip(sh.out, 4000)}` };
      }
      // action === read (default): hand back NEW bytes and remember the cursor
      const fresh = sh.out.slice(bgReadCursors.get(sh.id) ?? 0);
      bgReadCursors.set(sh.id, sh.out.length);
      const status = sh.exited
        ? `\n[exited with code ${sh.code ?? "?"}]`
        : `\n[still running, ${(Math.round((Date.now() - sh.startedAt) / 100) / 10)}s]`;
      const body =
        (fresh.length ? fresh : "(no new output)") +
        (sh.truncated ? "\n… (output truncated at 200KB)" : "") +
        status;
      // finished jobs are removed once fully drained
      if (sh.exited && bgReadCursors.get(sh.id)! >= sh.out.length) {
        map.delete(sh.id);
        bgReadCursors.delete(sh.id);
      }
      return { ok: true, result: clip(body, ctx.maxOutputBytes) };
    },
  },
  {
    name: "read_url",
    description:
      "Fetch a web page and return its main readable content (title + plain text, boilerplate stripped via " +
      "Mozilla Readability) — documentation, articles, issue threads. Cached for an hour per URL. " +
      "For raw JSON/API responses or file downloads prefer bash curl.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "absolute http(s) URL" },
        limit: { type: "number", description: "max characters returned (default 20000)" },
      },
      required: ["url"],
    },
    async run(args) {
      const raw = str(args.url);
      if (!URL.canParse(raw)) return { ok: false, result: `invalid url: ${raw.slice(0, 200)}` };
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:")
        return { ok: false, result: `unsupported protocol: ${u.protocol}` };
      const key = u.toString();
      const cached = urlCache.get(key);
      if (cached && Date.now() - cached.at < URL_CACHE_TTL_MS)
        return { ok: true, result: clipText(cached.text, num(args.limit, 20_000)) };

      let res: Response;
      try {
        res = await fetch(u, {
          redirect: "follow",
          signal: AbortSignal.timeout(45_000),
          headers: { "user-agent": "Mozilla/5.0 (compatible; teapot-coding-agent)" },
        });
      } catch (e) {
        return { ok: false, result: `fetch failed: ${(e as Error).message}` };
      }
      const html = await res.text();
      if (!html.trim()) return { ok: false, result: `HTTP ${res.status} with an empty body` };

      // heavy DOM deps are loaded lazily so the master's idle startup stays lean
      const { Browser } = await import("happy-dom");
      const { Readability } = await import("@mozilla/readability");
      const browser = new Browser();
      let text = "";
      try {
        const page = browser.newPage();
        page.url = key;
        page.content = html;
        const article = new Readability(page.mainFrame.document as unknown as Document).parse();
        text =
          [article?.title, article?.byline]
            .filter(Boolean)
            .join(" — ") + `\n(HTTP ${res.status}, ~${(article?.textContent ?? "").length} chars extracted)\n\n` +
          (article?.textContent ?? page.mainFrame.document.body?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
      } catch (e) {
        return { ok: false, result: `failed to parse page: ${(e as Error).message}` };
      } finally {
        await browser.close().catch(() => {});
      }
      if (res.ok && text.trim()) {
        if (urlCache.size >= 40) {
          const oldest = [...urlCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (oldest) urlCache.delete(oldest[0]);
        }
        urlCache.set(key, { at: Date.now(), text });
      }
      return { ok: res.ok || text.length > 0, result: clipText(text, num(args.limit, 20_000)) };
    },
  },
  {
    name: "spawn_agent",
    description:
      "Spawn a sub-agent to work a task in parallel (same workspace, own session). " +
      'context "none" = fresh start with just the task; "fork" = inherit this conversation ' +
      "byte-exactly (provider prefix cache stays warm) before the task is appended. " +
      "Returns the sub-agent id immediately; its finish summary is delivered back to you.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "self-contained instructions for the sub-agent" },
        context: { type: "string", enum: ["none", "fork"], description: "default none" },
        name: { type: "string", description: "optional short name fragment for the id" },
        // #105: reasoning effort for THIS sub-agent, overriding both the
        // configured subagent default and the parent's inherited value.
        //
        // Precedence mirrors OpenAI Codex (codex-rs/core/src/agent/child_config.rs):
        // spawn argument -> configured default -> parent's effort. Codex
        // deliberately does NOT inherit by default — its own test sets a parent at
        // XHigh and asserts a child spawned with Low runs at Low, because
        // sub-agents are usually narrow and cheap and inheriting a parent's high
        // effort across many trivial scouts multiplies cost for no gain.
        //
        // Naming it here is what stops the silent loss: previously a spawn could
        // not express an effort at all, so the parent's value simply vanished.
        reasoning_effort: {
          type: "string",
          enum: ["minimal", "low", "medium", "high", "xhigh"],
          description:
            "reasoning effort for this sub-agent. Omit to use the configured default, " +
            "then the parent's effort. Lower it for cheap, narrow scouts.",
        },
      },
      required: ["task"],
    },
    async run(args, ctx) {
      const sa = ctx.subAgents;
      if (!sa) return { ok: false, result: "sub-agents are not available here" };
      const task = str(args.task).trim();
      if (!task) return { ok: false, result: "task required" };
      const context = args.context === "fork" ? "fork" : "none";
      try {
        // #105: validate like the per-agent setter does, so a typo cannot reach
        // the provider as an unrecognised effort value.
        const effort = str(args.reasoning_effort).trim();
        if (effort && !isReasoningEffort(effort))
          return {
            ok: false,
            result:
              `reasoning_effort must be minimal|low|medium|high|xhigh (got "${effort}") — ` +
              "omit it to use the configured default, then the parent's effort",
          };
        const r = await sa.spawn({
          task,
          context,
          name: str(args.name).trim() || undefined,
          ...(effort ? { reasoning_effort: effort } : {}),
        });
        return { ok: true, result: `spawned sub-agent ${r.id} — park with wait_children() until it reports (never bash sleep), steer via message_agent, halt via stop_children` };
      } catch (e) {
        return { ok: false, result: `spawn failed: ${(e as Error).message}` };
      }
    },
  },
  {
    name: "list_children",
    description: "List your live sub-agents: id, status, current goal.",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const sa = ctx.subAgents;
      if (!sa) return { ok: false, result: "sub-agents are not available here" };
      const kids = sa.list();
      if (!kids.length) return { ok: true, result: "(no sub-agents)" };
      return {
        ok: true,
        result: kids
          .map((k) => `${k.id} · ${k.status} · ${clip(k.goal, 60)}`)
          .join("\n"),
      };
    },
  },
  {
    name: "stop_children",
    description:
      "Stop one or more of your sub-agents. Without ids: stops ALL of them (and their descendants).",
    parameters: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "sub-agent ids; omit for all" },
      },
    },
    async run(args, ctx) {
      const sa = ctx.subAgents;
      if (!sa) return { ok: false, result: "sub-agents are not available here" };
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : undefined;
      const r = await sa.stop(ids);
      return {
        ok: true,
        result: r.stopped.length ? `stopped: ${r.stopped.join(", ")}` : "(nothing running to stop)",
      };
    },
  },
  {
    name: "wait_children",
    description:
      "Park until at least one sub-agent settles (finished, errored, stopped, or asks you a question) — " +
      "or until the timeout lapses. Costs zero tokens while parked: prefer this over bash sleep when " +
      "waiting on spawned work. The settling child's report is delivered to you afterwards.",
    parameters: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "sub-agent ids; omit for all" },
        timeout_ms: { type: "number", description: "default 300000 (5 min), max 3600000" },
      },
    },
    async run(args, ctx) {
      const sa = ctx.subAgents;
      if (!sa) return { ok: false, result: "sub-agents are not available here" };
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : undefined;
      const ms = Math.min(Math.max(num(args.timeout_ms, 300_000), 1_000), 3_600_000);
      // park VISIBLY: the UI shows idle ("waiting on sub-agents") instead of a
      // running spinner, and any user prompt / stop wakes us instantly
      ctx.onIdlePark?.(`waiting on sub-agent${ids?.length === 1 ? ` ${ids[0]}` : "s"}`);
      // the child's report is about to land in our mailbox — a progress report
      // right after it would be pure noise, so re-arm the gate here
      ctx.onProgressGateReset?.();
      try {
        const r = await sa.wait(ids, ms);
        ctx.onIdleUnpark?.();
        ctx.onProgressGateReset?.(); // also after: waiting itself isn't "activity"
        return { ok: true, result: r.note };
      } catch (e) {
        ctx.onIdleUnpark?.();
        return { ok: false, result: `wait failed: ${(e as Error).message}` };
      }
    },
  },
  {
    name: "message_agent",
    description:
      "Send a message to a specific sub-agent (steer it mid-flight or answer its ask_user question).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "sub-agent id" },
        text: { type: "string" },
      },
      required: ["id", "text"],
    },
    async run(args, ctx) {
      const sa = ctx.subAgents;
      if (!sa) return { ok: false, result: "sub-agents are not available here" };
      const id = str(args.id);
      const text = str(args.text);
      if (!text.trim()) return { ok: false, result: "text required" };
      try {
        await sa.message(id, text);
        return { ok: true, result: `message delivered to ${id}` };
      } catch (e) {
        return { ok: false, result: (e as Error).message };
      }
    },
  },
  {
    name: "load_skill",
    description:
      "Load a skill's full instructions by name. Use when the system prompt's skill list " +
      "matches your current task; follow the loaded playbook. " +
      // #25: the instruction used to need a SECOND, separately-queued message that
      // only arrived at the next turn boundary. Passing `instructions` delivers it
      // in the SAME turn as the playbook, so "load X and do Y" costs one round-trip.
      "Pass `instructions` with what you want done with it to receive both at once.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "skill name from the list in your system prompt" },
        instructions: {
          type: "string",
          description:
            "Optional: what you want done with this skill (the task, constraints, scope). " +
            "Delivered in this same turn — no need to queue a follow-up message.",
        },
      },
      required: ["name"],
    },
    async run(args, ctx) {
      const roots = ctx.skillRoots ?? [];
      const skills = await discoverSkills(roots);
      const def = skills.find((s) => s.name === str(args.name));
      if (!def) {
        return {
          ok: false,
          result: `unknown skill: ${str(args.name)}. Available: ${skills.map((s) => s.name).join(", ") || "(none)"}`,
        };
      }
      let result = await readSkillFile(def);
      if (def.files.length) {
        // surface bundled scripts as runnable paths: workspace-relative when
        // possible (bash runs in the workspace), absolute for global skills
        const dirAbs = path.dirname(def.filePath);
        const rootDir = roots
          .map((r) => r.dir)
          .find((d) => def.filePath.startsWith(d + path.sep));
        const listed = def.files.map((f) => {
          const abs = path.join(dirAbs, f);
          return rootDir ? path.relative(ctx.cwd, abs) || f : abs;
        });
        result +=
          `\n\n--- Files bundled with this skill:\n` +
          listed.map((f) => `- ${f}`).join("\n") +
          `\nRun scripts with bash (chmod +x first if needed).`;
      }
      // #25: deliver the caller's instructions in THIS result, so the model does
      // not have to queue a second message that only lands next turn.
      const instructions = str(args.instructions).trim();
      if (instructions)
        result +=
          `\n\n--- Instructions for this task (from the same call):\n${instructions}\n` +
          "Apply the playbook above to these instructions now, in this turn.";
      return { ok: true, result };
    },
  },
  {
    name: "save_skill",
    description:
      "Create or update a reusable skill (a playbook you want to survive this session and be " +
      "loadable later via load_skill). Write distilled, step-by-step instructions — not a chat log. " +
      "Bundle helper scripts with the files argument; they are saved NEXT TO SKILL.md, listed by " +
      "load_skill, and made executable (.sh/.py/.js). Available from the next turn.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "kebab-case id, e.g. release-checklist" },
        description: { type: "string", description: "one line: what it is for / when to use it" },
        content: { type: "string", description: "markdown instructions" },
        files: {
          type: "array",
          description: "helper scripts/files stored beside SKILL.md",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: 'bare file name, e.g. "rollback.sh"' },
              content: { type: "string" },
            },
            required: ["name", "content"],
          },
        },
      },
      required: ["name", "description", "content"],
    },
    async run(args, ctx) {
      const roots = ctx.skillRoots ?? [];
      if (roots.length === 0) return { ok: false, result: "no skill roots configured" };
      const name = str(args.name);
      if (!isValidSkillName(name))
        return { ok: false, result: "invalid skill name (use kebab-case: [a-z0-9.-], max 64 chars)" };
      const description = str(args.description).slice(0, 200);
      if (!description) return { ok: false, result: "description required" };
      const content = str(args.content);
      if (!content.trim()) return { ok: false, result: "content required" };
      // save GLOBALLY (config dir) so skills survive workspace switches and
      // are shared by every agent. Same-name handling is safe:
      //  · overwriting the global copy replaces it atomically (writeFile)
      //  · a same-name skill in a HIGHER-priority root (workspace) still
      //    shadows this one at load time — that's the intended override,
      //    so tell the model when its save would be invisible
      const globalRoot = roots.find((r) => r.source === "global") ?? roots[0];
      const filePath = await saveSkill(globalRoot.dir, name, description, content.slice(0, 64_000));
      let note = "";
      for (const r of roots) {
        if (r === globalRoot || r.source === "bundled") continue;
        if (r.source !== "global" && roots.indexOf(r) < roots.indexOf(globalRoot)) {
          try {
            await fs.access(path.join(r.dir, name, SKILL_FILE));
            note = ` (note: a workspace skill with the same name "${name}" takes precedence at load time)`;
          } catch { /* no clash in this root */ }
        }
      }

      // bundled scripts/files next to SKILL.md
      const written: string[] = [];
      const rawFiles = Array.isArray(args.files) ? args.files : [];
      for (const f of rawFiles.slice(0, 10)) {
        const fname = str((f as Record<string, unknown>)?.name);
        const fcontent = str((f as Record<string, unknown>)?.content);
        if (!fcontent.trim()) continue;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(fname) || fname === SKILL_FILE) continue;
        const abs = path.join(path.dirname(filePath), fname);
        await fs.writeFile(abs, fcontent, "utf8");
        if (/\.(sh|py|js|mjs)$/.test(fname)) await fs.chmod(abs, 0o755);
        written.push(fname);
      }
      const extra = written.length ? `\nbundled files: ${written.join(", ")}` : "";
      return {
        ok: true,
        result: `saved skill "${name}" globally to ${filePath}${extra}${note} (listed from next turn; overwrite-safe)`,
      };
    },
  },
];

/** #16: how many files one read_file call may cover. Each costs context, so an
 *  unbounded array would just be a way to overflow the window in one shot. */
const MAX_MULTI_READ = 10;

/**
 * Subsequence match: every character of `needle` appears in `hay`, in order,
 * gaps allowed (#16 "fuzzy").
 *
 * Deliberately not a ranked edit-distance search. This answers "is this the
 * file I meant", and it can only say yes or no — it cannot rank a plausible
 * WRONG file above the right one, which is the failure mode that actually costs
 * an agent time. Searching file CONTENT is what bash/grep are for.
 */
export function fuzzyPathMatch(needle: string, hay: string): boolean {
  const n = needle.toLowerCase().replace(/[\s._/-]+/g, "");
  if (!n) return false;
  const h = hay.toLowerCase();
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i++;
    if (i === n.length) return true;
  }
  return false;
}

/**
 * Locate a file by a loose name and read it (#16).
 *
 * Walks the workspace (skipping .git, node_modules and build noise) and ranks
 * matches: exact path, exact basename, ends-with, then subsequence. When
 * several match it LISTS them rather than picking one — guessing here would have
 * the agent edit the wrong file, which is the expensive mistake.
 */
async function fuzzyRead(
  needle: string,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const q = needle.trim();
  if (!q) return { ok: false, result: "fuzzy needs a non-empty search string" };
  const SKIP = new Set([".git", "node_modules", "dist", "build", ".cache", "coverage", "__pycache__"]);
  const found: { rel: string; rank: number }[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        await walk(path.join(dir, e.name), r, depth + 1);
        continue;
      }
      let rank = -1;
      if (r === q) rank = 0;
      else if (e.name === q) rank = 1;
      else if (r.endsWith("/" + q) || r.endsWith(q)) rank = 2;
      else if (fuzzyPathMatch(q, r)) rank = 3;
      if (rank >= 0) found.push({ rel: r, rank });
    }
  };
  await walk(ctx.cwd, "", 0);
  if (!found.length) {
    return {
      ok: false,
      result:
        `no file matches "${q}" under the workspace. ` +
        "Use list_dir to see what exists, or pass the exact path instead of fuzzy.",
    };
  }
  found.sort((a, b) => a.rank - b.rank || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel));
  const best = found[0]!;
  // Only a confident match is read directly. If the query is vague enough that
  // several files match, LIST them: guessing would hand the agent the wrong
  // file, and the cost of that mistake is far higher than one extra call.
  // An exact path or basename is unambiguous, so those still read straight away.
  if (best.rank <= 1 || found.length === 1) {
    // re-enter the tool so a unique match behaves exactly like a normal read
    return executeTool("read_file", JSON.stringify({ ...args, path: best.rel, fuzzy: undefined }), ctx);
  }
  return {
    ok: true,
    result:
      `${found.length} files match "${q}" — pass the exact path (or a longer query) to read one:\n` +
      found.slice(0, 8).map((f) => `  ${f.rel}`).join("\n"),
  };
}

/** Current skills across the configured roots (for the system prompt listing). */
export async function currentSkills(ctx: ToolContext): Promise<SkillDef[]> {
  return discoverSkills(ctx.skillRoots ?? []);
}

export function toolSpecs(): ToolSpecLike[] {
  return TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
type ToolSpecLike = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

/** tools that mutate the workspace — blocked for read-only personas */
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "bash"]);

/**
 * Repair + normalise one tool call's arguments (#17, "A-rank item 1").
 *
 * The issue's thesis is "the harness deterministically does what a model does
 * badly", and the concrete failures it names for Ox/Qwen/DeepSeek-class models
 * are all argument-shaped. Before this, teapot repaired only tool NAMES and
 * then did a bare JSON.parse, so any of the following burned a whole turn on a
 * generic "invalid JSON arguments":
 *
 *   - a JSON-stringified object:      {"command":"{\"path\":\"a\"}"}
 *   - a bare scalar for an object:   {"paths":"a.ts"}
 *   - everything as strings:         {"limit":"100"} / {"ignore_case":"true"}
 *   - an alias for the real key:     {"cmd":"ls"} / {"oldValue":"x"}
 *   - markdown framing on a path:    {"path":"**\`a.ts\`"}
 *
 * Pure and side-effect free so it is directly unit-testable; it returns the
 * repaired args plus any notes about what it changed, and NEVER throws — an
 * unrepairable call is reported as `error` so the caller can hand the model a
 * shape it can actually send next.
 */
export interface RepairResult {
  args: Record<string, unknown>;
  notes: string[];
  /** set when the call cannot be made usable; says what to send instead */
  error?: string;
}

/** per-tool aliases: the common wrong key -> the key the schema declares. */
const ARG_ALIASES: Record<string, Record<string, string>> = {
  bash: { cmd: "command", script: "command", shell: "command", input: "command" },
  read_file: { file_path: "path", filepath: "path", file: "path", name: "path" },
  write_file: { file_path: "path", filepath: "path", file: "path" },
  edit_file: { file_path: "path", filepath: "path", oldValue: "old_text", newValue: "new_text" },
  apply_patch: { patch_text: "patch", diff: "patch" },
  list_dir: { file_path: "path", dir: "path", directory: "path" },
  list_children: { file_path: "path", dir: "path" },
  read_url: { uri: "url", link: "url" },
};

/**
 * The one argument each tool's whole call usually boils down to. Used to
 * salvage a bare word ("ls") that was never wrapped in JSON at all — but ONLY
 * for tools where that is unambiguous, so "12" is never mistaken for a path.
 */
const PRIMARY_STRING_ARG: Record<string, string> = {
  bash: "command",
  read_file: "path",
  write_file: "content",
  list_dir: "path",
  list_children: "path",
  read_url: "url",
  load_skill: "name",
  save_skill: "content",
};

/** keys whose schema type is a number / boolean, per tool. */
const NUMERIC_ARGS: Record<string, string[]> = {
  read_file: ["offset", "limit", "context"],
  bash: ["timeout_ms"],
  list_dir: [],
  write_file: [],
};

const BOOL_ARGS: Record<string, string[]> = {
  read_file: ["ignore_case"],
  bash: ["background"],
  edit_file: ["replace_all"],
  write_file: [],
  list_dir: [],
};

/** markdown/backtick framing models like to wrap a path in */
function unframe(v: string): string {
  const m = /^[`*_\s]+(.+?)[`*_\s]*$/.exec(v);
  return m ? m[1]! : v;
}

/** coerce "100" -> 100, "true" -> true; returns undefined when not coercible */
function coerceScalar(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t)) && /^[-+]?\d+(\.\d+)?$/.test(t)) return Number(t);
  return v;
}

/** Turn a value into an array, tolerating a bare scalar or a JSON array. */
function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("[")) {
      try {
        const p = JSON.parse(t);
        if (Array.isArray(p)) return p;
      } catch {
        /* fall through — treat as a single element */
      }
    }
    return [v];
  }
  if (v === undefined || v === null) return [];
  return [v];
}

export function repairToolInput(name: string, rawArgs: string): RepairResult {
  const notes: string[] = [];
  let parsed: unknown;
  try {
    parsed = rawArgs?.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    // not JSON at all: a whole call was stringified, or the model emitted a
    // bare word. Only salvageable when the tool takes a single obvious string.
    const bare = rawArgs?.trim().replace(/^[`*\s]+|[`*\s]+$/g, "");
    const primary = PRIMARY_STRING_ARG[name];
    // a bare number/boolean is never a path or a command — refusing is far
    // better than inventing one (#17)
    const isScalarish = bare !== "" && /^(true|false|null|-?\d+(\.\d+)?)$/i.test(bare);
    if (bare && primary && !isScalarish && !bare.startsWith("{") && !bare.startsWith("[")) {
      notes.push(`wrapped a bare string as {"${primary}": …}`);
      return { args: { [primary]: unframe(bare) }, notes };
    }
    return { args: {}, notes, error: `arguments were not valid JSON — send a JSON object, e.g. {"…"}` };
  }
  // a JSON-stringified object arrives as a string
  if (typeof parsed === "string" && /[{[]/.test(parsed.trim().slice(0, 2))) {
    try {
      parsed = JSON.parse(parsed);
      notes.push("unwrapped a JSON-stringified argument object");
    } catch {
      /* leave as-is; it may genuinely be a string argument */
    }
  }
  // a bare scalar where an object is required
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (parsed === null || parsed === undefined) return { args: {}, notes, error: "arguments were empty" };
    // An ARRAY is a legitimate value for a path-ish argument, but only for the
    // tools that actually take one — inventing {path:[…]} for apply_patch would
    // hand the tool a key it has never heard of (#17).
    if (Array.isArray(parsed) && name === "read_file") {
      notes.push("kept the array as a paths list");
      return { args: { paths: parsed }, notes };
    }
    const primary = PRIMARY_STRING_ARG[name];
    if (primary && typeof parsed === "string") {
      notes.push(`wrapped a bare string as {"${primary}": …}`);
      return { args: { [primary]: unframe(parsed) }, notes };
    }
    return {
      args: {},
      notes,
      error:
        `expected a JSON object for ${name}, got a bare ${Array.isArray(parsed) ? "array" : typeof parsed}` +
        (primary ? ` — send {"${primary}": …}` : ""),
    };
  }
  const args = { ...(parsed as Record<string, unknown>) };
  // alias normalisation
  for (const [from, to] of Object.entries(ARG_ALIASES[name] ?? {})) {
    if (!(from in args)) continue;
    if (!(to in args)) {
      args[to] = args[from];
      notes.push(`renamed "${from}" -> "${to}"`);
    } else {
      // both present: the schema key wins and the stray alias is DROPPED, not
      // left behind as an unknown argument the tool would ignore (#17)
      notes.push(`dropped "${from}" — "${to}" was also given and wins`);
    }
    delete args[from];
  }
  // string -> number / boolean for the keys whose schema says so
  for (const k of NUMERIC_ARGS[name] ?? []) {
    if (k in args) {
      const c = coerceScalar(args[k]);
      if (typeof c !== typeof args[k]) {
        args[k] = c;
        notes.push(`coerced "${k}" to ${typeof c}`);
      }
    }
  }
  for (const k of BOOL_ARGS[name] ?? []) {
    if (k in args) {
      const c = coerceScalar(args[k]);
      if (typeof c !== typeof args[k]) {
        args[k] = c;
        notes.push(`coerced "${k}" to ${typeof c}`);
      }
    }
  }
  // an array-typed arg arriving as a scalar
  if (name === "read_file" && "paths" in args) {
    const before = args.paths;
    args.paths = toArray(before);
    if (!Array.isArray(before)) notes.push('coerced "paths" to an array');
  }
  // a JSON-stringified object hiding inside a single argument, e.g.
  // {"path": "{\"path\": \"a.ts\"}"} — unwrap it and merge its keys
  // Only PATH-like keys: `content`/`old_text`/`new_text` legitimately hold JSON
  // (writing a .json file!), and unwrapping those would REPLACE the file's
  // actual data with an inner field — silent data loss, not repair.
  for (const k of ["path", "command"]) {
    const v = args[k];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!/^[{[]/.test(t)) continue;
    try {
      const inner = JSON.parse(t);
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        delete args[k];
        Object.assign(args, inner);
        notes.push(`unwrapped a JSON-stringified object out of "${k}"`);
        break;
      }
    } catch {
      /* genuinely not JSON — leave it alone */
    }
  }
  // markdown framing on a path
  for (const k of ["path", "file_path"]) {
    if (typeof args[k] === "string") {
      const f = unframe(args[k] as string);
      if (f !== args[k]) {
        args[k] = f;
        notes.push(`stripped markdown framing from "${k}"`);
      }
    }
  }
  return { args, notes };
}

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { ok: false, result: `unknown tool: ${name}` };
  if (ctx.signal?.aborted) return { ok: false, result: "aborted (harness shutdown)" };
  // read-only personas (researcher/reviewer) are enforced, not just asked
  if (ctx.readOnly && MUTATING_TOOLS.has(name))
    return { ok: false, result: `${name} is blocked: this agent runs with read-only tools` };
  // #17: repair the call before handing it to the tool. A model that sends
// {"cmd":"ls"} or {"limit":"100"} should get the work done, not a generic parse
// failure and a wasted turn. Unrepairable calls say what to send instead.
  const repaired = repairToolInput(name, rawArgs);
  if (repaired.error)
    return { ok: false, result: `${name}: ${repaired.error}` };
  const args = repaired.args;
  if (repaired.notes.length && process.env.TEAPOT_DEBUG_REPAIR)
    console.error(`[repair] ${name}: ${repaired.notes.join("; ")}`);
  try {
    return await def.run(args, ctx);
  } catch (err) {
    return { ok: false, result: `tool error: ${(err as Error).message}` };
  }
}
