/**
 * Tool execution: file ops, shell (with process-group kill + timeout), git.
 * Tool specs are plain JSON-schema function definitions — provider-agnostic.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  discoverSkills,
  isValidSkillName,
  readSkillFile,
  saveSkill,
  type SkillDef,
} from "./skills.ts";

export interface ToolContext {
  cwd: string;
  /** hard cap per command */
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  /** skill roots in priority order ([0] = workspace, wins on name clash) */
  skillRoots?: { dir: string; source: string }[];
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

/** Resolve a path inside the workspace; reject escapes. */
function safeJoin(cwd: string, p: string): string {
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${p}`);
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
    let timedOut = false;
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
      timedOut = true;
      killGroup();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        resolve({ ok: false, result: `spawn error: ${err.message}` });
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      if (timedOut) {
        resolve({
          ok: false,
          result: `TIMEOUT after ${timeoutMs}ms. Partial output:\n${clip(out.trim() || "(no output)", ctx.maxOutputBytes)}`,
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

export const DEFAULT_TIMEOUT_MS = 120_000;

export const TOOLS: ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read a text file from the workspace. Supports offset/limit for large files. Returns numbered lines.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root" },
        offset: { type: "number", description: "1-indexed start line" },
        limit: { type: "number", description: "Max lines to return" },
      },
      required: ["path"],
    },
    async run(args, ctx) {
      const p = safeJoin(ctx.cwd, str(args.path));
      const text = await readText(p);
      const lines = text.split("\n");
      const off = Math.max(0, num(args.offset, 1) - 1);
      const lim = num(args.limit, 2000);
      const slice = lines.slice(off, off + lim).map((l, i) => `${off + i + 1}| ${l}`);
      const more = off + lim < lines.length ? `\n... (${lines.length - off - lim} more lines)` : "";
      return { ok: true, result: slice.join("\n") + more };
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content (parent dirs auto-created).",
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
      "Replace an exact unique substring in a file. old_text must match exactly and be unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
    async run(args, ctx) {
      const p = safeJoin(ctx.cwd, str(args.path));
      const text = await readText(p);
      const oldText = str(args.old_text);
      const count = text.split(oldText).length - 1;
      if (count === 0) return { ok: false, result: "old_text not found in file" };
      if (count > 1) return { ok: false, result: `old_text matched ${count} times; must be unique` };
      await fs.writeFile(p, text.replace(oldText, str(args.new_text)), "utf8");
      return { ok: true, result: "edited" };
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
      "Run a bash command inside the workspace (use it for git, builds, tests, etc.). " +
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
      return { ok: true, result: await readSkillFile(def) };
    },
  },
  {
    name: "save_skill",
    description:
      "Create or update a reusable skill (a playbook you want to survive this session and be " +
      "loadable later via load_skill). Write distilled, step-by-step instructions — not a chat log. " +
      "The skill becomes available in your system prompt from the next turn.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "kebab-case id, e.g. release-checklist" },
        description: { type: "string", description: "one line: what it is for / when to use it" },
        content: { type: "string", description: "markdown instructions" },
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
      return { ok: true, result: `saved skill "${name}" to ${filePath} (listed from next turn)` };
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

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { ok: false, result: `unknown tool: ${name}` };
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
