import { spawn } from "node:child_process";
import { existsSync, promises as fs, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
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

import { editorConfigFor } from "./editorconfig.ts";
import { mcp, MCP_PREFIX, flattenToolName } from "./mcp-registry.ts";
import { createCatalog, SEARCH_TOOL, RUN_TOOL, type Catalog } from "./tool-catalog.ts";

export interface ToolContext {
  cwd: string;
  agentId?: string;
  stateDir?: string;
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  skillRoots?: { dir: string; source: string }[];
  signal?: AbortSignal;
  readOnly?: boolean;
  allowMutatingForReview?: string[];
  subAgents?: {
    depth: number;
    spawn(o: {
      task: string;
      context: "none" | "fork";
      name?: string;
      reasoning_effort?: string;
    }): Promise<{ id: string }>;
    list(): { id: string; status: string; goal: string; parent: string; nested: boolean }[];
    stop(ids?: string[]): Promise<{ stopped: string[] }>;
    message(id: string, text: string): Promise<void>;
    wait(ids: string[] | undefined, timeoutMs: number): Promise<{ note: string }>;
  };
  onIdlePark?: (reason: string) => boolean;
  onIdleUnpark?: () => void;
  hasPendingPrompts?: () => boolean;
  onProgressGateReset?: () => void;
  onFileRead?: (path: string) => void;
  onBackgroundExit?: (info: { id: string; code: number | null; cmd: string; durationMs: number; outputTail: string }) => void;
}

export interface ToolResult {
  ok: boolean;
  result: string;
  /**
   * An image the tool wants the MODEL to see, as a data URL.
   *
   * `result` stays text — it is what the log and the timeline show. The caller attaches this as a
   * `content_parts` entry on the tool message, so a vision model actually receives the picture instead
   * of a description of it.
   */
  image?: { url: string; name: string };
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  meta?: boolean;
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

export async function looksBinary(p: string): Promise<{ binary: boolean; bytes: number; kind: string }> {
  const fh = await fs.open(p, "r");
  try {
    const st = await fh.stat();
    const head = Buffer.alloc(Math.min(4096, Math.max(0, st.size)));
    if (head.length) await fh.read(head, 0, head.length, 0);
    const kind = sniff(head);
    if (kind) return { binary: true, bytes: st.size, kind };
    return { binary: head.includes(0), bytes: st.size, kind: head.includes(0) ? "binary" : "text" };
  } finally {
    await fh.close();
  }
}

/** the `looksBinary()` kinds that are pictures a vision model can actually receive */
const IMAGE_MIME: Record<string, string | undefined> = {
  "PNG image": "image/png",
  "JPEG image": "image/jpeg",
  "GIF image": "image/gif",
  "WEBP image": "image/webp",
};

function sniff(head: Buffer): string | null {
  const hex = (n: number) => head.subarray(0, n).toString("hex");
  if (hex(8).startsWith("89504e47")) return "PNG image";
  if (hex(3) === "ffd8ff") return "JPEG image";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "GIF image";
  // RIFF....WEBP — the four bytes after "RIFF" are the size, so "WEBP" sits at offset 8
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP")
    return "WEBP image";
  if (head.subarray(0, 4).toString("latin1") === "PK\x03\x04") return "zip archive";
  if (hex(4) === "25504446") return "PDF";
  if (hex(4) === "7f454c46") return "ELF binary";
  if (hex(2) === "1f8b") return "gzip archive";
  if (head.subarray(0, 5).toString("latin1") === "{\\rtf") return "RTF document";
  return null;
}

async function finishWrite(
  p: string,
  out: string,
  eol: Eol | null,
  original: string,
): Promise<{ ok: true; result: string }> {
  await fs.writeFile(p, out, "utf8");
  const converted = eol !== null && eol !== "\n" && out !== original;
  return {
    ok: true,
    result:
      `wrote ${p} (${out.length} bytes)` +
      (converted ? ` (kept ${eol === "\r\n" ? "CRLF" : "CR"} line endings)` : ""),
  };
}

export type Eol = "\n" | "\r\n" | "\r";

export function detectEol(text: string): Eol | null {
  if (!text) return null;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const kinds = [crlf, cr, lf].filter((n) => n > 0).length;
  if (kinds !== 1) return null;
  if (crlf > 0) return "\r\n";
  if (cr > 0) return "\r";
  return "\n";
}

export function splitEolLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

export function applyEol(content: string, eol: Eol | null): string {
  if (!eol || eol === "\n") return content;
  return content.replace(/\r\n|\r|\n/g, eol);
}

function staleGuard(pathArg: string, base: unknown, current: string | null): ToolResult | null {
  if (typeof base !== "string") return null; 
  const MIN_PLAUSIBLE_BASE = 16;
  if (base.length < MIN_PLAUSIBLE_BASE && current !== null && current.length >= MIN_PLAUSIBLE_BASE * 4)
    return null;
  if (base === current) return null; 
  const rel = pathArg;
  return {
    ok: false,
    result:
      `${rel} changed on disk since you read it — nothing was written.\n` +
      `your base_content: ${base.length} bytes, on disk now: ${current === null ? "(deleted)" : `${current.length} bytes`}.\n` +
      `Re-read ${rel}, redo the edit against the current content, and pass the fresh text as base_content.`,
  };
}

async function currentOrNull(p: string): Promise<string | null> {
  return fs.readFile(p, "utf8").catch(() => null);
}

export function safeJoin(cwd: string, p: string): string {
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      let probe = path.dirname(abs);
      for (;;) {
        try {
          real = realpathSync(probe);
          break;
        } catch (inner) {
          if ((inner as NodeJS.ErrnoException).code !== "ENOENT") break;
          try {
            const target = readlinkSync(probe);
            real = path.isAbsolute(target) ? target : path.resolve(path.dirname(probe), target);
            break;
          } catch {
          }
          const next = path.dirname(probe);
          if (next === probe) break; 
          probe = next;
        }
      }
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
  owner: string;
}
const bgShellsByWs = new Map<string, Map<string, BgShell>>();
let bgSeq = 0;
const bgReadCursors = new Map<string, number>();

function bgMapFor(cwd: string): Map<string, BgShell> {
  let m = bgShellsByWs.get(cwd);
  if (!m) {
    m = new Map();
    bgShellsByWs.set(cwd, m);
  }
  return m;
}

function shellEnv(): NodeJS.ProcessEnv {
  const { PWD: _pwd, ...rest } = process.env;
  return { ...rest, TERM: "dumb", GIT_PAGER: "cat", PAGER: "cat" };
}

export function toolShellFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean = existsSync,
): { file: string; args: (cmd: string) => string[] } {
  const override = env.TEAPOT_SHELL?.trim();
  if (override) return { file: override, args: (cmd) => ["-c", cmd] };
  if (platform !== "win32") {
    return { file: env.SHELL || "/bin/bash", args: (cmd) => ["-c", cmd] };
  }
  const pathVar = env.PATH ?? "";
  const sep = pathVar.includes(";") ? ";" : ":";
  const hasBash = pathVar
    .split(sep)
    .filter(Boolean)
    .some((dir) => exists(dir.includes("\\") ? `${dir}\\bash.exe` : path.join(dir, "bash.exe")));
  if (hasBash) return { file: "bash", args: (cmd) => ["-c", cmd] };
  return { file: env.COMSPEC || "cmd.exe", args: (cmd) => ["/d", "/s", "/c", cmd] };
}

function toolShell(): { file: string; args: (cmd: string) => string[] } {
  return toolShellFor(process.platform, process.env);
}

export function elapsed(t0: number, now = Date.now()): string {
  return `\n[took ${((now - t0) / 1000).toFixed(1)}s]`;
}

export type BgJobRecord = {
  id: string;
  cmd: string;
  owner: string;
  workspace: string;
  pid: number | null;
  startedAt: number;
  logPath?: string;
};

const jobsFile = (dir: string): string => path.join(dir, "bg-jobs.json");

function readJobRecords(dir: string): BgJobRecord[] {
  try {
    const raw = readFileSync(jobsFile(dir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BgJobRecord[]).filter((r) => r && typeof r.id === "string") : [];
  } catch {
    return [];
  }
}

function writeJobRecords(dir: string, records: BgJobRecord[]): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(jobsFile(dir), JSON.stringify(records, null, 1));
  } catch {
  }
}

function rememberJob(dir: string, rec: BgJobRecord): void {
  const all = readJobRecords(dir).filter((r) => r.id !== rec.id);
  all.push(rec);
  writeJobRecords(dir, all);
}

function forgetJob(dir: string, id: string): void {
  writeJobRecords(dir, readJobRecords(dir).filter((r) => r.id !== id));
}

export function recoverableJobs(dir: string, alive: (pid: number) => boolean): BgJobRecord[] {
  const all = readJobRecords(dir);
  const live: BgJobRecord[] = [];
  for (const r of all) {
    if (r.pid !== null && alive(r.pid)) live.push(r);
  }
  if (live.length !== all.length) writeJobRecords(dir, live);
  return live;
}

function startBackgroundShell(cmd: string, ctx: ToolContext): string {
  const map = bgMapFor(ctx.cwd);
  for (const [id, sh] of map) {
    if (sh.exited && Date.now() - sh.startedAt > 30 * 60_000 && !map.delete(id)) void id;
  }
  const id = `bg${++bgSeq}`;
  const shellSpec = toolShell();
  const child = spawn(shellSpec.file, shellSpec.args(cmd), {
    cwd: ctx.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: shellEnv(),
  });
  const sh: BgShell = {
    id, cmd, child,
    out: "", truncated: false,
    startedAt: Date.now(), exited: false, code: null,
    owner: ctx.agentId ?? "",
  };
  const collect = (chunk: Buffer) => {
    if (sh.out.length < 200_000) sh.out += chunk.toString("utf8");
    else sh.truncated = true;
  };
  if (ctx.stateDir) {
    rememberJob(ctx.stateDir, {
      id, cmd, owner: ctx.agentId ?? "", workspace: ctx.cwd,
      pid: child.pid ?? null,
      startedAt: sh.startedAt,
    });
  }
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  let exitNotified = false;
  const notify = (code: number | null) => {
    sh.exited = true;
    if (code !== null) sh.code = code;
    if (exitNotified) return;
    exitNotified = true;
    if (ctx.stateDir) forgetJob(ctx.stateDir, id);
    try {
      ctx.onBackgroundExit?.({
        id,
        code: sh.code,
        cmd,
        durationMs: Date.now() - sh.startedAt,
        outputTail: sh.out.slice(-2000),
      });
    } catch {
    }
  };
  child.on("exit", (code) => notify(code));
  child.on("close", (code) => notify(code));
  map.set(id, sh);
  return id;
}

export function isContextOverflow(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? "").toLowerCase();
  return (
    /context (length|window|limit)|too many tokens|prompt is too long|max.{0,12}tokens.{0,20}(exceed|surpass)|request too large|payload too large|exceeds.{0,20}limit/.test(
      msg,
    ) ||
    /\b(400|413)\b.*token/.test(msg) ||
    /no choices:[\s\S]{0,300}context (length|window|limit)/.test(msg)
  );
}

export function listBgShells(cwd: string, stateDir?: string): Array<{
  id: string;
  cmd: string;
  owner: string;
  running: boolean;
  detached?: boolean;
  pid?: number | null;
  code: number | null;
  startedAt: number;
  tail: string;
  bytes: number;
  truncated: boolean;
}> {
  const live = liveShells(cwd);
  if (!stateDir) return live;
  const known = new Set(live.map((j) => j.id));
  const recovered = recoverableJobs(stateDir, pidExists)
    .filter((r) => !known.has(r.id) && r.workspace === cwd)
    .map((r) => ({
      id: r.id,
      cmd: r.cmd,
      owner: r.owner,
      running: true,
      detached: true,
      pid: r.pid,
      code: null,
      startedAt: r.startedAt,
      tail: "",
      bytes: 0,
      truncated: false,
    }));
  return [...live, ...recovered].sort((a, b) => b.startedAt - a.startedAt);
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function liveShells(cwd: string): Array<{
  id: string;
  cmd: string;
  owner: string;
  running: boolean;
  code: number | null;
  startedAt: number;
  tail: string;
  bytes: number;
  truncated: boolean;
}> {
  const m = bgShellsByWs.get(cwd);
  if (!m) return [];
  return [...m.values()]
    .map((b) => ({
      id: b.id,
      cmd: b.cmd,
      owner: b.owner,
      running: !b.exited,
      code: b.code,
      startedAt: b.startedAt,
      tail: b.out.slice(-4000),
      bytes: b.out.length,
      truncated: b.truncated,
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function killBgShell(cwd: string, id: string, stateDir?: string): boolean {
  const m = bgShellsByWs.get(cwd);
  const b = m?.get(id);
  if (b) {
    try {
      killTree(b.child);
    } catch {
    }
    m!.delete(id);
    if (stateDir) forgetJob(stateDir, id);
    return true;
  }
  if (stateDir) {
    const rec = readJobRecords(stateDir).find((r) => r.id === id);
    if (rec) {
      forgetJob(stateDir, id);
      return true;
    }
  }
  return false;
}

export function hasRunningBgShells(cwd: string): boolean {
  const m = bgShellsByWs.get(cwd);
  if (!m) return false;
  for (const sh of m.values()) {
    if (sh.exited && Date.now() - sh.startedAt > 30 * 60_000) {
      m.delete(sh.id);
      continue;
    }
    if (!sh.exited) return true;
  }
  return false;
}

export function hasRunningBgShellsFor(cwd: string, owner: string): boolean {
  const m = bgShellsByWs.get(cwd);
  if (!m || !owner) return false;
  for (const sh of m.values()) {
    if (sh.exited) continue;
    if (sh.owner === owner) return true;
  }
  return false;
}

export function killBgShells(cwd: string): number {
  const m = bgShellsByWs.get(cwd);
  if (!m) return 0;
  let killed = 0;
  for (const [id, sh] of m) {
    if (!sh.exited) {
      describeKill(killTree(sh.child));
      killed++;
    }
    bgReadCursors.delete(id);
  }
  m.clear();
  return killed;
}

function runShell(
  cmd: string,
  ctx: ToolContext,
  timeoutMs: number,
  explicitTimeout = false,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sh = toolShell();
    const child = spawn(sh.file, sh.args(cmd), {
      cwd: ctx.cwd,
      detached: true, 
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

    const killGroup = () => killTree(child);

    const timer = setTimeout(() => {
      const limit = timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`;
      killReason =
        `TIMEOUT after ${limit} — ${describeKill(killGroup())}. ` +
        (explicitTimeout
          ? `You passed timeout_ms=${timeoutMs}${timeoutMs >= BASH_MAX_TIMEOUT_MS ? " (the maximum)" : ""}. `
          : `This was the DEFAULT (${limit}) because no timeout_ms was given. `) +
        (timeoutMs < BASH_MAX_TIMEOUT_MS
          ? `Retry with a larger timeout_ms (up to ${BASH_MAX_TIMEOUT_MS}) if it legitimately needs longer, ` +
            `or use background=true for a job with no timeout at all.`
          : `If it needs longer than the maximum, use background=true — a background job has no timeout.`);
    }, timeoutMs);
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
          elapsed(t0),
      });
    });
  });
}

function matchLines(text: string, needle: string): number[] {
  const out: number[] = [];
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    out.push(text.slice(0, idx).split("\n").length);
    idx = text.indexOf(needle, idx + Math.max(needle.length, 1));
  }
  return out;
}

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

export function disproportionateSpan(text: string, anchor: string): string | null {
  const anchorLines = anchor.split("\n");
  const askedLines = anchorLines.length;
  if (askedLines < 2) return null; 
  const anchorFirst = anchorLines[0]!.trimEnd();
  const allSrcLines = text.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < allSrcLines.length; i++) if (allSrcLines[i]!.trimEnd() === anchorFirst) starts.push(i);
  if (!starts.length) return null; 

  const srcLines = allSrcLines;
  let best = Number.POSITIVE_INFINITY;
  for (const start of starts) {
    let fileAt = start;
    let consumed = 0;
    let ok = true;
    for (let a = 0; a < anchorLines.length; a++) {
      const want = anchorLines[a]!.trimEnd();
      let found = -1;
      for (let f = fileAt; f < srcLines.length; f++) {
        if (srcLines[f]!.trimEnd() === want) {
          found = f;
          break;
        }
      }
      if (found < 0) {
        ok = false;
        break;
      }
      consumed = found - start + 1;
      fileAt = found + 1;
    }
    if (ok) best = Math.min(best, consumed);
  }
  if (!Number.isFinite(best)) return null; 
  if (best > askedLines * 2) {
    return (
      `old_text spans ${askedLines} line(s) but the nearest reading of it covers ${best} ` +
      `lines of the file — refusing a disproportionate match. An anchor this loose would ` +
      `rewrite a region you did not intend. Re-read the file and copy a tighter block.`
    );
  }
  return null;
}

export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_TIMEOUT_MS = BASH_DEFAULT_TIMEOUT_MS;

const URL_CACHE_TTL_MS = 3_600_000;
const urlCache = new Map<string, { at: number; text: string }>();

/**
 * A SLICE of a long text, with the exact next offset.
 *
 * `limit` alone could not reach the end: `clipText` caps at 80k and the extracted body is read from the
 * start every time, so the tail of a long article was unreachable in one call and awkward to reach in
 * two (the caller had to count characters). MEASURED: an Anthropic research post extracted to ~22.8k
 * chars and the tool returned a `[truncated, N chars total]` marker with no way to ask for the rest.
 *
 * The trailing hint makes the next call mechanical: pass `offset=<next>`.
 */
export function sliceText(s: string, offset: number, limit: number): string {
  const start = Math.max(0, Math.floor(offset) || 0);
  const n = Math.max(1000, Math.min(limit, 80_000));
  const end = Math.min(s.length, start + n);
  if (start >= s.length) return `(nothing after offset ${start}; the text is ${s.length} chars)`;
  const body = s.slice(start, end);
  if (end >= s.length) return start > 0 ? `…[from ${start}]
${body}` : body;
  return `${start > 0 ? `…[from ${start}]
` : ""}${body}
… [truncated at ${end} of ${s.length} chars — call again with offset=${end}]`;
}

function clipText(s: string, max: number): string {
  const n = Math.max(1000, Math.min(max, 80_000));
  return s.length <= n ? s : `${s.slice(0, n)}\n… [truncated, ${s.length} chars total]`;
}

const BACKTRACKING_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\([^()]*[+*}][^()]*\)\s*[+*{]/, why: "a quantifier nested inside another quantifier" },
  { re: /\(([^()|]*)\|\1\)\s*[+*{]/, why: "an alternation with identical branches inside a quantifier" },
  { re: /\(\s*[.][*+]\s*\)\s*[+*{]/, why: "a wildcard quantified inside a quantifier" },
];

const MAX_PATTERN_LENGTH = 1000;

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

function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;
  const searchStart =
    eof && lines.length >= pattern.length ? Math.max(start, lines.length - pattern.length) : start;

  const eqExact = (a: string, b: string) => a === b;
  const eqRstrip = (a: string, b: string) => a.trimEnd() === b.trimEnd();
  const eqTrim = (a: string, b: string) => a.trim() === b.trim();
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
          cur ??= { changeContext: null, oldLines: [], newLines: [], isEndOfFile: false }; 
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
          continue; 
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
  if (originalLines.at(-1) === "") originalLines.pop(); 

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
      replacements.push([originalLines.length, 0, newSlice]);
      continue;
    }
    let found = seekSequence(originalLines, pattern, lineIndex, ch.isEndOfFile);
    if (found == null && pattern.at(-1) === "") {
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

  replacements.sort((a, b) => b[0] - a[0]); 
  const out = originalLines.slice();
  for (const [startIdx, oldLen, seg] of replacements) out.splice(startIdx, oldLen, ...seg);
  if (out.at(-1) !== "") out.push("");
  return { content: out.join("\n"), note: hadCrlf ? " (CRLF→LF)" : "" };
}

async function applyPatch(patch: string, ctx: ToolContext): Promise<ToolResult> {
  const ops = parsePatch(patch);
  if (typeof ops === "string") return { ok: false, result: ops };
  if (ops.length === 0) return { ok: false, result: "patch contains no file operations" };

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

const HASH_BLANK = "    "; 
const ANCHOR_RE = /^\s*(\d+):([0-9a-z]{4,8}| {4})\|/;

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

export function renderHashlines(lines: string[], startLine = 1): string {
  const body = lines.length && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  return body
    .map((l, i) => `${startLine + i}:${hashLine(l)}| ${l}`)
    .join("\n");
}

export function gutterWidth(startLine: number, count: number): number {
  return String(Math.max(0, startLine - 1) + count).length;
}

export function renderGutter(lines: string[], startLine = 1): string {
  const body = lines.length && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  if (!body.length) return "";
  const w = gutterWidth(startLine, body.length);
  return body.map((l, i) => `${String(startLine + i).padStart(w)}| ${l}`).join("\n");
}

export function parseAnchor(anchor: string): { line: number; hash: string } | null {
  const m = /^\s*(\d+):([0-9a-z]{4,8}| {4})\s*$/.exec(anchor);
  if (!m) return null;
  return { line: Number(m[1]), hash: m[2] };
}

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
        : 
          `hash ${JSON.stringify(anchor.hash)} is not a valid anchor (expected 4 hex chars) — re-read the file and copy the anchor verbatim`,
    };
  if (hits.length === 1) return { index: hits[0]!, how: "unique" };
  const target = anchor.line - 1;
  const best = hits.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
  return {
    index: best,
    how:
      `line ${anchor.line} shares its content hash with ${hits.length - 1} other line(s) — ` +
      `resolved by proximity, VERIFY you edited the copy you meant`,
  };
}

export function isHashlineBlock(block: string): boolean {
  const rows = block.split("\n").filter((l) => l !== "");
  if (!rows.length) return false;
  return rows.every((l) => ANCHOR_RE.test(l));
}

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
      "Read a file from the workspace. Returns numbered lines (`N| ` prefixes are display-only — never copy them into edit_file). " +
      "On an IMAGE (png/jpeg/gif/webp) the picture itself is attached to the result, so you can see it — do not decode bytes. " +
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
          chunks.push(`--- ${rel} ---\n${r.ok ? r.result : `ERROR: ${r.result}`}`);
        }
        return { ok: true, result: chunks.join("\n\n") };
      }
      if (args.fuzzy) return fuzzyRead(str(args.fuzzy), ctx, args as Record<string, unknown>);
      const p = safeJoin(ctx.cwd, str(args.path));
      let text: string;
      try {
        const probe = await looksBinary(p);
        if (probe.binary) {
          /**
           * An IMAGE is handed to the model as an image; anything else is still refused.
           *
           * Refusing images was never a feature — it was the fix for returning raw bytes as mangled
           * text (`d907af3`). But the operator's point is the asymmetry: a user can attach a picture
           * and the agent cannot, so the agent is asked to work on files it is not allowed to see.
           * MEASURED: `read_file` had never been able to return an image at all; the multimodal commit
           * (`257333a`) was the USER path (composer → `/prompt`), not a tool.
           */
          const mime = IMAGE_MIME[probe.kind];
          if (mime) {
            const buf = await fs.readFile(p);
            const name = path.basename(p);
            return {
              ok: true,
              result:
                `${str(args.path)} is a ${probe.kind} (${probe.bytes} bytes) — the image itself is ` +
                `attached to this message, so you are looking at it. Describe or reason about it ` +
                `directly; there is no need to decode bytes.`,
              image: { url: `data:${mime};base64,${buf.toString("base64")}`, name },
            };
          }
          return {
            ok: false,
            result:
              `${str(args.path)} is a ${probe.kind} (${probe.bytes} bytes), not text — read_file returns ` +
              `file CONTENT, so binary data would arrive as unreadable bytes. Use bash (file, identify, ` +
              `xxd) to inspect it, or a tool that handles this format.`,
          };
        }
        text = await readText(p);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return {
          ok: false,
          result: code === "ENOENT" ? `cannot read ${str(args.path)}: no such file` : `cannot read ${str(args.path)}: ${(err as Error).message}`,
        };
      }
      ctx.onFileRead?.(str(args.path));
      const lines = splitEolLines(text);
      const idMode = lineIdMode(args as Record<string, unknown>);

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

      let off = num(args.offset, 1);
      off = off < 0 ? Math.max(0, lines.length + off) : Math.max(0, off - 1);
      const lim = num(args.limit, 2000);
      const pageLines = lines.slice(off, off + lim);
      const cappedLines = pageLines.map((l) =>
        l.length > MAX_READ_LINE_CHARS
          ? l.slice(0, MAX_READ_LINE_CHARS) +
            ` …[line clipped: ${l.length - MAX_READ_LINE_CHARS} more chars]`
          : l,
      );
      const rendered =
        idMode === "hash" ? renderHashlines(cappedLines, off + 1) : renderGutter(cappedLines, off + 1);
      const total = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      const more = off + lim < total ? `\n... (${total - off - lim} more lines)` : "";
      const out = rendered + more;
      if (out.length > MAX_READ_BYTES) {
        const head = out.slice(0, MAX_READ_BYTES);
        const cutAt = head.lastIndexOf("\n");
        return {
          ok: true,
          result:
            (cutAt > 0 ? head.slice(0, cutAt) : head) +
            `\n... [output clipped at ${MAX_READ_BYTES} bytes of ${out.length}; ` +
            `continue with offset=${off + 1 + countLines(cutAt > 0 ? head.slice(0, cutAt) : head) + 1}]`,
        };
      }
      return { ok: true, result: out };
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
      const before = await currentOrNull(p);
      const detected = before === null ? null : detectEol(before);
      if (detected !== null) return finishWrite(p, applyEol(args.content, detected), detected, args.content);
      const ec = editorConfigFor(p);
      const out = applyEol(args.content, ec.eol);
      const final = ec.finalNewline === true && out !== "" && !out.endsWith("\n") ? `${out}\n` : out;
      return finishWrite(p, final, ec.eol, args.content);
    },
  },
  {
    name: "edit_file",
    description:
      "Make exactly ONE small, unique replacement in one existing file — the cheapest tool for a single spot change. " +
      "Copy old_text from the file contents (NOT from read_file's `N| ` prefixed display); it must appear exactly once — " +
      "if it matches several places, add surrounding lines or pass replace_all=true. " +
      "Or read with read_file(line_ids:\"hash\") and pass that block VERBATIM as old_text — `LINE:HASH| ` anchors are verified " +
      "against the current file, and a block whose anchors no longer match is refused as a stale read instead of editing the " +
      "wrong lines. IMPORTANT with anchors: they belong to the READ, so new_text must be PLAIN content with NO `N:HASH| ` " +
      "prefixes (they are stripped if sent, but sending them means old_text and new_text look identical). " +
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
      let newText = str(args.new_text);
      if (!oldText)
        return {
          ok: false,
          result:
            "old_text is required — pass the exact text to replace, or read with " +
            '`read_file({line_ids:"hash"})` and pass that block VERBATIM as old_text. ' +
            "Do NOT copy read_file's `N| ` line-number prefixes.",
        };
      const replaceAll = args.replace_all === true;
      let hashNote = "";
      let hashNotes: string[] = [];
      let hashSpan: { start: number; end: number } | null = null;
      const newTextHasAnchors = isHashlineBlock(newText);
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
      if (newTextHasAnchors) {
        const stripped = newText
          .split("\n")
          .map((l) => {
            const a = ANCHOR_RE.exec(l);
            return a ? l.slice(l.indexOf("|") + 1).replace(/^ /, "") : l;
          })
          .join("\n");
        if (stripped !== newText) {
          newText = stripped;
          hashNotes = [...hashNotes, "removed the hashline anchors from new_text (they belong to the read, not the file)"];
        }
      }
      let count = hashNote ? 0 : text.split(oldText).length - 1;
      const MIN_FUZZY_ANCHOR = 10;
      const anchorLines = oldText.split("\n").length;
      const anchorTooShort = anchorLines < 2 && oldText.trim().length < MIN_FUZZY_ANCHOR;
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

      if (count === 0 && !anchorTooShort) {
        const srcLines = text.replace(/\r\n/g, "\n").split("\n");
        const patLines = oldText.replace(/\r\n/g, "\n").split("\n");
        const hits = trailingWsMatches(srcLines, patLines);
        if (hits.length === 1 && patLines.length > 0) {
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
        const lines = matchLines(text, oldText.trim());
        const hint = lines.length
          ? `A trimmed variant appears at line(s) ${lines.slice(0, 5).join(", ")}.`
          : `No similar text found — re-read ${str(args.path)} around the target area and copy old_text exactly.`;
        return {
          ok: false,
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
      if (!hashSpan) {
        const over = disproportionateSpan(text, oldText);
        if (over) return { ok: false, result: over };
      }
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
        timeout_ms: {
          type: "number",
          description:
            `How long the command may run before the harness KILLS it (whole process group, partial output ` +
            `returned). Default ${DEFAULT_TIMEOUT_MS / 1000}s, maximum 600s. ` +
            `MEASURED, an agent that does not know this burns several attempts on long builds: a command ` +
            `that needs more than the default MUST pass a larger timeout_ms (e.g. 300000 for a 5-minute ` +
            `build), and one that needs more than 600s must use background=true instead — there is no ` +
            `timeout on a background job.`,
        },
        background: {
          type: "boolean",
          description:
            "true = start the command and return IMMEDIATELY with a job id. You are NOTIFIED at your " +
            "next turn boundary when it exits (exit code + output tail) — no polling needed. " +
            "Use bash_output only to fetch FULL output mid-run or after. Use for dev servers, watchers, " +
            "long builds, and any release/CI wait (gh run watch, a tarball appearing) — never `sleep`.",
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
            `started in background (job ${id}). It runs while you work — you will be notified ` +
            `here when it exits (exit code + output tail), and the round WAITS for that rather ` +
            `than ending. Do NOT poll bash_output: each poll is a whole turn, and the report ` +
            `already carries the tail. Call bash_output only when you need output BEYOND the ` +
            `tail (a long build's earlier lines), or to kill it. ` +
            `Full output: bash_output(job_id="${id}"). Kill: bash_output(job_id="${id}", action="kill").`,
        };
      }
      const explicit = args.timeout_ms !== undefined && args.timeout_ms !== null;
      return runShell(str(args.command), ctx, Math.min(num(args.timeout_ms, ctx.defaultTimeoutMs), BASH_MAX_TIMEOUT_MS), explicit);
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
        const note = sh.exited ? "(already exited)" : describeKill(killTree(sh.child));
        map.delete(sh.id);
        return { ok: true, result: `job ${sh.id} ${note}. Output so far:\n${clip(sh.out, 4000)}` };
      }
      const fresh = sh.out.slice(bgReadCursors.get(sh.id) ?? 0);
      bgReadCursors.set(sh.id, sh.out.length);
      const status = sh.exited
        ? `\n[exited with code ${sh.code ?? "?"}]`
        : `\n[still running, ${(Math.round((Date.now() - sh.startedAt) / 100) / 10)}s]`;
      const body =
        (fresh.length ? fresh : "(no new output)") +
        (sh.truncated ? "\n… (output truncated at 200KB)" : "") +
        status;
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
        limit: { type: "number", description: "max characters returned per call (default 20000)" },
        offset: {
          type: "number",
          description:
            "character to start at (default 0). The text is cached whole, so pass the previous `offset + " +
            "returned length` to read the NEXT slice — the extraction is ~17-23k chars for a long article, " +
            "and `limit` alone cannot reach past it in one call.",
        },
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
        return { ok: true, result: sliceText(cached.text, num(args.offset, 0), num(args.limit, 20_000)) };

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
      return { ok: res.ok || text.length > 0, result: sliceText(text, num(args.offset, 0), num(args.limit, 20_000)) };
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
    description:
      "List the sub-agents working under you: id, status, current goal. " +
      "Includes NESTED ones your sub-agents spawned (marked (nested) with their own parent), " +
      "so you can see work you would otherwise be unaware of — wait_children waits for these too.",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const sa = ctx.subAgents;
      if (!sa) return { ok: false, result: "sub-agents are not available here" };
      const kids = sa.list();
      if (!kids.length) return { ok: true, result: "(no sub-agents)" };
      return {
        ok: true,
        result: kids
          .map(
            (k) =>
              `${k.id} · ${k.status} · ${clip(k.goal, 60)}` +
              (k.nested ? `  (nested — spawned by @${k.parent}; address @${k.parent} to steer it)` : ""),
          )
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
      "or until the timeout lapses. Waits for your whole SUBTREE: a sub-agent that spawned its own " +
      "sub-agents is not settled while those are still working, so this never returns over live nested " +
      "work. Costs zero tokens while parked: prefer this over bash sleep when waiting on spawned work. " +
      "The settling child's report is delivered to you afterwards.",
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
      if (ctx.hasPendingPrompts?.()) {
        ctx.onProgressGateReset?.();
        return {
          ok: true,
          result:
            "A prompt is already queued for you — handle it first, then call wait_children again if you still need to wait.",
        };
      }
      const parked = ctx.onIdlePark?.(`waiting on sub-agent${ids?.length === 1 ? ` ${ids[0]}` : "s"}`);
      if (parked === false) {
        ctx.onProgressGateReset?.();
        return {
          ok: true,
          result:
            "A prompt arrived while you were about to wait — handle it first, then call wait_children again if you still need to wait.",
        };
      }
      ctx.onProgressGateReset?.();
      try {
        const r = await sa.wait(ids, ms);
        ctx.onIdleUnpark?.();
        ctx.onProgressGateReset?.(); 
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
      "Send a message to another agent. Use it to steer a sub-agent mid-flight, to answer its " +
      "ask_user question, or to message your OWN PARENT (pass its id) — a sub-agent may ask its " +
      "parent a question or hand back a partial result, which is how you report progress without " +
      "ending your turn. You may NOT message a sibling or an unrelated agent.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "sub-agent id, or your parent's id" },
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
      const globalRoot = roots.find((r) => r.source === "global") ?? roots[0];
      const filePath = await saveSkill(globalRoot.dir, name, description, content.slice(0, 64_000));
      let note = "";
      for (const r of roots) {
        if (r === globalRoot || r.source === "bundled") continue;
        if (r.source !== "global" && roots.indexOf(r) < roots.indexOf(globalRoot)) {
          try {
            await fs.access(path.join(r.dir, name, SKILL_FILE));
            note = ` (note: a workspace skill with the same name "${name}" takes precedence at load time)`;
          } catch {  }
        }
      }

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

const MAX_MULTI_READ = 10;

const MAX_READ_BYTES = 256 * 1024;
const MAX_READ_LINE_CHARS = 2_000;

function countLines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

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
  if (best.rank <= 1 || found.length === 1) {
    return executeTool("read_file", JSON.stringify({ ...args, path: best.rel, fuzzy: undefined }), ctx);
  }
  return {
    ok: true,
    result:
      `${found.length} files match "${q}" — pass the exact path (or a longer query) to read one:\n` +
      found.slice(0, 8).map((f) => `  ${f.rel}`).join("\n"),
  };
}

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

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "apply_patch", "bash"]);

export interface RepairResult {
  args: Record<string, unknown>;
  notes: string[];
  error?: string;
}

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

function unframe(v: string): string {
  const m = /^[`*_\s]+(.+?)[`*_\s]*$/.exec(v);
  return m ? m[1]! : v;
}

function coerceScalar(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t)) && /^[-+]?\d+(\.\d+)?$/.test(t)) return Number(t);
  return v;
}

function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("[")) {
      try {
        const p = JSON.parse(t);
        if (Array.isArray(p)) return p;
      } catch {
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
    const bare = rawArgs?.trim().replace(/^[`*\s]+|[`*\s]+$/g, "");
    const primary = PRIMARY_STRING_ARG[name];
    const isScalarish = bare !== "" && /^(true|false|null|-?\d+(\.\d+)?)$/i.test(bare);
    if (bare && primary && !isScalarish && !bare.startsWith("{") && !bare.startsWith("[")) {
      notes.push(`wrapped a bare string as {"${primary}": …}`);
      return { args: { [primary]: unframe(bare) }, notes };
    }
    return { args: {}, notes, error: `arguments were not valid JSON — send a JSON object, e.g. {"…"}` };
  }
  if (typeof parsed === "string" && /[{[]/.test(parsed.trim().slice(0, 2))) {
    try {
      parsed = JSON.parse(parsed);
      notes.push("unwrapped a JSON-stringified argument object");
    } catch {
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (parsed === null || parsed === undefined) return { args: {}, notes, error: "arguments were empty" };
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
  for (const [from, to] of Object.entries(ARG_ALIASES[name] ?? {})) {
    if (!(from in args)) continue;
    if (!(to in args)) {
      args[to] = args[from];
      notes.push(`renamed "${from}" -> "${to}"`);
    } else {
      notes.push(`dropped "${from}" — "${to}" was also given and wins`);
    }
    delete args[from];
  }
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
  if (name === "read_file" && "paths" in args) {
    const before = args.paths;
    args.paths = toArray(before);
    if (!Array.isArray(before)) notes.push('coerced "paths" to an array');
  }
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
    }
  }
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

/**
 * One catalog per ToolContext (= per agent), so `search_tools` and `run_tool` agree within a turn.
 *
 * `resetToolCatalog(ctx)` runs at each turn boundary: discovery is per-turn, so a stale tool_id from
 * three turns ago cannot be executed, and the search budget cannot grow without bound.
 */
const catalogs = new WeakMap<ToolContext, Catalog>();

function catalogFor(ctx: ToolContext): Catalog {
  let c = catalogs.get(ctx);
  if (!c) {
    c = createCatalog(
      mcp.states().map((st) => ({
        id: st.config.name,
        name: st.config.name,
        description: st.config.description,
        enabled: st.status !== "disabled",
        status: st.status,
        tools: st.tools ?? [],
      })),
      // the built-ins are already in the request, so the catalog must know how much room is left
      { builtInCount: TOOLS.length },
    );
    catalogs.set(ctx, c);
  }
  return c;
}

/** called at a turn boundary so each turn starts with nothing discovered */
export function resetToolCatalog(ctx: ToolContext): void {
  catalogs.delete(ctx);
}

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
  /**
   * Tool DISCOVERY, for a catalog too large to send.
   *
   * Measured: the operator's MCP catalog is 321 tools and the provider allows 128, so the whole catalog
   * cannot go in the request. These two meta-tools are how the model still reaches all of it — and they
   * are ordinary tools, so no provider-side support is needed (Anthropic's `defer_loading` is
   * server-side and does not reduce the `/tools` element count, which is what this provider caps).
   */
  if (name === SEARCH_TOOL) {
    let args: { query?: unknown; offset?: unknown } = {};
    try {
      args = rawArgs.trim() ? (JSON.parse(rawArgs) as typeof args) : {};
    } catch {
      return { ok: false, result: `${SEARCH_TOOL}: arguments are not valid JSON` };
    }
    const query = typeof args.query === "string" ? args.query.slice(0, 200) : "";
    const offset = Number.isSafeInteger(Number(args.offset)) ? Math.max(0, Number(args.offset)) : 0;
    const catalog = catalogFor(ctx);
    const { entries, total, nextOffset } = catalog.search(query, offset);
    // a discovered entry is the ONLY thing run_tool will accept, and only for this turn
    for (const e of entries) catalog.remember(e.id);
    return {
      ok: true,
      result: JSON.stringify(
        {
          tools: entries.map((e) => ({
            tool_id: e.id,
            server: e.server,
            name: e.name,
            description: e.description.slice(0, 1000),
            inputSchema: e.inputSchema,
          })),
          totalMatches: total,
          nextOffset,
          ...(entries.length
            ? { note: "Run one with run_tool, copying tool_id exactly." }
            : { note: "No match. Try another keyword, or an empty query to browse." }),
        },
        null,
        1,
      ),
    };
  }
  if (name === RUN_TOOL) {
    let args: { tool_id?: unknown; arguments?: unknown } = {};
    try {
      args = rawArgs.trim() ? (JSON.parse(rawArgs) as typeof args) : {};
    } catch {
      return { ok: false, result: `${RUN_TOOL}: arguments are not valid JSON` };
    }
    const catalog = catalogFor(ctx);
    const entry = typeof args.tool_id === "string" ? catalog.discovered(args.tool_id) : undefined;
    if (!entry) {
      return {
        ok: false,
        result:
          "unknown tool_id — search for the tool with search_tools first; only tools found in THIS turn can run",
      };
    }
    const callArgs = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
      ? (args.arguments as Record<string, unknown>)
      : {};
    const r = await mcp.call(flattenToolName(entry.serverId, entry.name), callArgs);
    if (!r) return { ok: false, result: `unknown tool: ${entry.name}` };
    return { ok: r.ok, result: r.text };
  }
  if (name.startsWith(MCP_PREFIX)) {
    if (ctx.signal?.aborted) return { ok: false, result: "aborted (harness shutdown)" };
    let args: unknown = {};
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return { ok: false, result: `${name}: arguments are not valid JSON` };
    }
    const r = await mcp.call(name, args);
    if (!r) return { ok: false, result: `unknown tool: ${name}` };
    return { ok: r.ok, result: r.text };
  }
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { ok: false, result: `unknown tool: ${name}` };
  if (ctx.signal?.aborted) return { ok: false, result: "aborted (harness shutdown)" };
  if (ctx.readOnly && MUTATING_TOOLS.has(name) && !ctx.allowMutatingForReview?.includes(name))
    return { ok: false, result: `${name} is blocked: this agent runs with read-only tools` };
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

export function isRequestNodeLimit(err: unknown): { hit: boolean; limit?: number } {
  const msg = String((err as Error)?.message ?? "");
  const m = /JSON node count cannot exceed\s+(\d+)/i.exec(msg);
  if (!m) return { hit: false };
  return { hit: true, ...(m[1] ? { limit: Number(m[1]) } : {}) };
}
