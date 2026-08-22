/**
 * Agent Skills: reusable playbooks the agent can load on demand — and create
 * itself, so knowledge accumulates across sessions instead of living only in
 * chat history.
 *
 * A skill is a directory with a SKILL.md:
 *
 *   ---
 *   name: release-checklist
 *   description: Steps to cut a release safely
 *   ---
 *   (free-form instructions shown to the agent when it loads the skill)
 *
 * Roots are scanned in priority order; the first skill with a given name wins.
 * Workspace skills (<workspace>/skills) beat global ones (~config/skills), so
 * a project can override shared defaults. Everything stays human-readable and
 * git-friendly Markdown — no database, no lock-in.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const SKILL_FILE = "SKILL.md";

export interface SkillDef {
  name: string;
  description: string;
  /** which root provided it ("workspace" | "global" | any label really) */
  source: string;
  filePath: string;
}

export interface ParsedSkill {
  meta: Record<string, string>;
  body: string;
}

export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name);
}

/**
 * Minimal frontmatter parser for the subset we need: a leading `---` block of
 * `key: value` lines. No YAML dependency by design.
 */
export function parseSkillMd(text: string): ParsedSkill {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

/** Root dirs in priority order: [0] overrides later ones on name clash. */
export async function discoverSkills(roots: { dir: string; source: string }[]): Promise<SkillDef[]> {
  const byName = new Map<string, SkillDef>();
  for (const root of roots) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(root.dir, { withFileTypes: true });
    } catch {
      continue; // root missing → simply no skills there
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const filePath = path.join(root.dir, e.name, SKILL_FILE);
      let text: string;
      try {
        text = await fs.readFile(filePath, "utf8");
      } catch {
        continue; // directory without SKILL.md is not a skill
      }
      const parsed = parseSkillMd(text);
      const name = parsed.meta.name || e.name;
      if (byName.has(name)) continue; // higher-priority root already defined it
      byName.set(name, {
        name,
        description: parsed.meta.description || "",
        source: root.source,
        filePath,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkillFile(def: SkillDef): Promise<string> {
  return fs.readFile(def.filePath, "utf8");
}

/** Write (or overwrite) a workspace skill; returns the file path written. */
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
