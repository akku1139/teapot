/**
 * Tool execution: file ops, shell (with process-group kill + timeout), git.
 * Tool specs are plain JSON-schema function definitions — provider-agnostic.
 */
import { spawn } from "node:child_process";
import { existsSync, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import {
  discoverSkills,
  isValidSkillName,
  readSkillFile,
  saveSkill,
  SKILL_FILE,
  type SkillDef,
} from "./skills.ts";

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
    spawn(o: { task: string; context: "none" | "fork"; name?: string }): Promise<{ id: string }>;
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

/** Resolve a path inside the workspace; reject escapes (incl. symlink targets). */
export function safeJoin(cwd: string, p: string): string {
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  // symlinks inside the workspace can point anywhere — resolve the real
  // target and confine THAT too (path.resolve alone doesn't follow links)
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    /* target may not exist yet (write_file) — lexical check above still holds */
  }
  const relReal = path.relative(cwd, real);
  if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
    throw new Error(`path escapes workspace via symlink: ${p}`);
  }
  return abs;
}

/** Run a command in its own process group; kill the whole group on timeout. */
function runShell(cmd: string, ctx: ToolContext, timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", cmd], {
      cwd: ctx.cwd,
      detached: true, // own process group
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb", GIT_PAGER: "cat", PAGER: "cat" },
    });
    let out = "";
    let done = false;
    let killReason: string | null = null;
    const collect = (chunk: Buffer) => {
      if (out.length < ctx.maxOutputBytes) out += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL"); // whole group
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      killReason = `TIMEOUT after ${timeoutMs}ms`;
      killGroup();
    }, timeoutMs);
    // harness shutdown must not wait out a long-running command
    const onAbort = () => {
      killReason = "ABORTED (harness shutdown)";
      killGroup();
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
        resolve({ ok: false, result: `spawn error: ${err.message}` });
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
          result: `${killReason}. Partial output:\n${clip(out.trim() || "(no output)", ctx.maxOutputBytes)}`,
        });
        return;
      }
      resolve({
        ok: code === 0,
        result:
          (code === 0 ? "" : `exit=${code}${signal ? ` signal=${signal}` : ""}\n`) +
          clip(out.trim() || "(no output)", ctx.maxOutputBytes),
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

function compileRegex(pattern: string, ignoreCase: boolean): RegExp | string {
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

  // phase 2 — commit
  for (const w of writes) {
    await fs.mkdir(path.dirname(w.abs), { recursive: true });
    await fs.writeFile(w.abs, w.content, "utf8");
  }
  for (const d of deletes) await fs.rm(d).catch(() => {});
  return { ok: true, result: `patch applied:\n${summary.join("\n")}` };
}

export const TOOLS: ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read a text file from the workspace. Returns numbered lines (`N| ` prefixes are display-only — never copy them into edit_file). " +
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
      },
      required: ["path"],
    },
    async run(args, ctx) {
      const p = safeJoin(ctx.cwd, str(args.path));
      const text = await readText(p);
      const lines = text.split("\n");

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
          lines.slice(s, e + 1).map((l, k) => `${s + k + 1}| ${l}`).join("\n"),
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
      const slice = lines.slice(off, off + lim).map((l, i) => `${off + i + 1}| ${l}`);
      const more = off + lim < lines.length ? `\n... (${lines.length - off - lim} more lines)` : "";
      return { ok: true, result: slice.join("\n") + more };
    },
  },
  {
    name: "write_file",
    description:
      "Create ONE new file, or replace a file's entire content (parent dirs auto-created). " +
      "Creating files as part of a larger batch of edits → one apply_patch instead. " +
      "Partial changes to an existing file → edit_file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    async run(args, ctx) {
      const p = safeJoin(ctx.cwd, str(args.path));
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, str(args.content), "utf8");
      return { ok: true, result: `wrote ${p} (${String(args.content).length} bytes)` };
    },
  },
  {
    name: "edit_file",
    description:
      "Make exactly ONE small, unique replacement in one existing file — the cheapest tool for a single spot change. " +
      "Copy old_text from the file contents (NOT from read_file's `N| ` prefixed display); it must appear exactly once — " +
      "if it matches several places, add surrounding lines or pass replace_all=true. " +
      "Two or more changes (or a rename/delete) → use apply_patch instead.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
        replace_all: { type: "boolean", description: "replace every occurrence instead of requiring uniqueness" },
      },
      required: ["path", "old_text", "new_text"],
    },
    async run(args, ctx) {
      const p = safeJoin(ctx.cwd, str(args.path));
      let text = await readText(p);
      const oldText = str(args.old_text);
      const newText = str(args.new_text);
      if (!oldText) return { ok: false, result: "old_text is required" };
      const replaceAll = args.replace_all === true;
      let count = text.split(oldText).length - 1;
      let normalized = false;
      // tolerate LF patterns against CRLF files (convert once, on success)
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
          const eol = text.includes("\r\n") ? "\r\n" : "\n";
          const rebuilt = [
            ...srcLines.slice(0, hits[0]),
            ...newText.replace(/\r\n/g, "\n").split("\n"),
            ...srcLines.slice(hits[0]! + patLines.length),
          ].join(eol);
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
          result: `old_text not found in file. ${hint} Watch indentation/trailing spaces and drop the \`N| \` line-number prefixes.`,
        };
      }
      if (count > 1 && !replaceAll) {
        const at = matchLines(text, oldText);
        return {
          ok: false,
          result: `old_text matched ${count} times (lines ${at.slice(0, 5).join(", ")}) and must be unique — add surrounding lines to old_text, or pass replace_all=true`,
        };
      }
      await fs.writeFile(
        p,
        replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText),
        "utf8",
      );
      const where = count > 1 ? ` (${count} occurrences)` : "";
      return {
        ok: true,
        result: `${replaceAll ? "replaced all" : "edited"}${where}${normalized ? " (file converted CRLF→LF)" : ""}`,
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
      },
      required: ["command"],
    },
    async run(args, ctx) {
      return runShell(str(args.command), ctx, Math.min(num(args.timeout_ms, ctx.defaultTimeoutMs), 600_000));
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
        const r = await sa.spawn({
          task,
          context,
          name: str(args.name).trim() || undefined,
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
      "matches your current task; follow the loaded playbook.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "skill name from the list in your system prompt" },
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
      const filePath = await saveSkill(roots[0].dir, name, description, content.slice(0, 64_000));

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
      return { ok: true, result: `saved skill "${name}" to ${filePath}${extra} (listed from next turn)` };
    },
  },
];

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

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { ok: false, result: `unknown tool: ${name}` };
  if (ctx.signal?.aborted) return { ok: false, result: "aborted (harness shutdown)" };
  // read-only personas (researcher/reviewer) are enforced, not just asked
  if (ctx.readOnly && MUTATING_TOOLS.has(name))
    return { ok: false, result: `${name} is blocked: this agent runs with read-only tools` };
  let args: Record<string, unknown>;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, result: `invalid JSON arguments: ${rawArgs.slice(0, 200)}` };
  }
  try {
    return await def.run(args, ctx);
  } catch (err) {
    return { ok: false, result: `tool error: ${(err as Error).message}` };
  }
}
