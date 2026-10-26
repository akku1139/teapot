import { promises as fs } from "node:fs";
import path from "node:path";
import { homeDir } from "../home.ts";

export const SKILL_FILE = "SKILL.md";

export async function skillRootsFingerprint(
  roots: { dir: string; source: string }[],
): Promise<string> {
  const parts: string[] = [];
  for (const root of roots) {
    parts.push(root.dir);
    let st: { mtimeMs: number; size: number } | null = null;
    try {
      st = await fs.stat(root.dir);
    } catch {
      parts.push("-"); 
      continue;
    }
    parts.push(`${st.mtimeMs}:${st.size}`);
    await stampSkillFiles(root.dir, 0, parts);
  }
  return parts.join("|");
}

async function stampSkillFiles(dir: string, depth: number, parts: string[]): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (!e.isDirectory()) continue;
    try {
      const s = await fs.stat(path.join(full, SKILL_FILE));
      parts.push(`${full}=${s.mtimeMs}:${s.size}`);
    } catch {
    }
    await stampSkillFiles(full, depth + 1, parts);
  }
}

export interface SkillDef {
  name: string;
  description: string;
  source: string;
  filePath: string;
  files: string[];
}

export interface ParsedSkill {
  meta: Record<string, string>;
  body: string;
}

export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name);
}

export function parseSkillMd(text: string): ParsedSkill {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const lines = m[1].split(/\r?\n/);
  const meta: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i]!.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const raw = kv[2]!.trim();
    if (/^[>|][-+]?$/.test(raw)) {
      const parts: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j]!;
        if (l.trim() === "") {
          parts.push("");
          continue;
        }
        if (!/^\s/.test(l)) break; 
        parts.push(l.trim());
      }
      i = j - 1;
      const joined = parts.join(/^[>|][-+]?$/.test(raw) && raw.startsWith("|") ? "\n" : " ").trim();
      if (joined) meta[key] = joined;
      continue;
    }
    if (raw === "") continue; 
    meta[key] = unquote(raw);
  }
  return { meta, body: m[2].trim() };
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/''/g, "'");
  }
  return s;
}

export function foreignSkillRoots(workspace?: string): { dir: string; source: string }[] {
  const home = homeDir();
  const out: { dir: string; source: string }[] = [];
  const add = (dir: string) => {
    if (dir && !out.some((r) => r.dir === dir)) out.push({ dir, source: "foreign" });
  };
  if (workspace) {
    for (const rel of [
      path.join(".agents", "skills"), 
      path.join(".claude", "skills"),
      path.join(".codex", "skills"),
      path.join(".cursor", "skills"),
      path.join(".gemini", "skills"),
      path.join(".github", "skills"), 
      path.join(".opencode", "skills"),
    ]) {
      add(path.join(workspace, rel));
    }
  }
  if (home) {
    add(path.join(home, ".agents", "skills")); 
    for (const rel of [
      [".claude", "skills"],
      [".codex", "skills"],
      [".cursor", "skills"],
      [".gemini", "skills"],
      [".copilot", "skills"], 
      [".config", "opencode", "skills"],
    ]) {
      add(path.join(home, ...rel));
    }
  }
  return out;
}

const MAX_SKILL_DEPTH = 4;

export async function discoverSkills(roots: { dir: string; source: string }[]): Promise<SkillDef[]> {
  const byName = new Map<string, SkillDef>();
  const depthByName = new Map<string, number>();
  for (const root of roots) {
    await walkSkills(root.dir, root.source, 0, byName, depthByName);
  }
  return [...byName.values()];
}

async function walkSkills(
  dir: string,
  source: string,
  depth: number,
  byName: Map<string, SkillDef>,
  depthByName: Map<string, number>,
): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; 
  }
  const here = path.join(dir, SKILL_FILE);
  let hereText: string | null = null;
  try {
    hereText = await fs.readFile(here, "utf8");
  } catch {
    hereText = null;
  }
  if (hereText !== null && depth > 0) {
    const parsed = parseSkillMd(hereText);
    const name = parsed.meta.name || path.basename(dir);
    const prevDepth = depthByName.get(name);
    const wins =
      prevDepth === undefined ||
      (prevDepth !== undefined && depth < prevDepth && byName.get(name)?.source === source);
    if (wins) {
      let files: string[] = [];
      try {
        files = (await fs.readdir(dir, { withFileTypes: true }))
          .filter((f) => f.isFile() && f.name !== SKILL_FILE && !f.name.startsWith("."))
          .map((f) => f.name)
          .sort();
      } catch {
      }
      byName.set(name, {
        name,
        description: parsed.meta.description || "",
        source,
        filePath: here,
        files,
      });
      depthByName.set(name, depth);
    }
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    await walkSkills(path.join(dir, e.name), source, depth + 1, byName, depthByName);
  }
}

export async function readSkillFile(def: SkillDef): Promise<string> {
  return fs.readFile(def.filePath, "utf8");
}

export async function saveSkill(
  workspaceRoot: string,
  name: string,
  description: string,
  content: string,
): Promise<string> {
  const dir = path.join(workspaceRoot, name);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, SKILL_FILE);
  await fs.writeFile(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${content.trim()}\n`,
    "utf8",
  );
  return filePath;
}
