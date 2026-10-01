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

/**
 * Cheap change-detector for a set of skill roots. Returns a stable string
 * that changes whenever a root is added, removed, or modified — so callers
 * can skip a full rescan (a readdir per root plus a read of every SKILL.md)
 * on the overwhelmingly common "nothing changed" path.
 *
 * The fingerprint covers each root's own mtime/size AND the mtime/size of
 * every SKILL.md one level down, because writing SKILL.md does not bump the
 * parent directory's mtime. Helper scripts edited in place are covered by
 * the SKILL.md stat only in aggregate; a rewritten SKILL.md always lands
 * here too (saveSkill rewrites it), so bundled-file edits ride along with
 * the next skill write rather than triggering their own rescan.
 */
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
      parts.push("-"); // root missing → no skills here (same as discoverSkills)
      continue;
    }
    parts.push(`${st.mtimeMs}:${st.size}`);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      try {
        const s = await fs.stat(path.join(root.dir, e.name, SKILL_FILE));
        parts.push(`${e.name}=${s.mtimeMs}:${s.size}`);
      } catch {
        parts.push(`${e.name}=none`);
      }
    }
  }
  return parts.join("|");
}

export interface SkillDef {
  name: string;
  description: string;
  /** which root provided it ("workspace" | "global" | any label really) */
  source: string;
  filePath: string;
  /** sibling files bundled with the skill (bare names, e.g. helper scripts) */
  files: string[];
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
/**
 * How deep to look for nested skills (#27).
 *
 * Bounded because a skill directory also holds BUNDLED FILES (helper scripts)
 * and arbitrary payload, so an unbounded walk is not safe. Depth is not the
 * thing that makes a directory a skill, though — holding a SKILL.md is — so the
 * bound only limits how far we look, never what counts.
 */
const MAX_SKILL_DEPTH = 4;

/** Root dirs in priority order: [0] overrides later ones on name clash. */
export async function discoverSkills(roots: { dir: string; source: string }[]): Promise<SkillDef[]> {
  const byName = new Map<string, SkillDef>();
  // name -> depth, so a SHALLOWER skill wins over a nested namesake rather than
  // a deep one silently shadowing the obvious skill (#27)
  const depthByName = new Map<string, number>();
  for (const root of roots) {
    await walkSkills(root.dir, root.source, 0, byName, depthByName);
  }
  return [...byName.values()];
}

/**
 * Depth-first walk collecting every directory that holds a SKILL.md (#27).
 *
 * A directory WITHOUT its own SKILL.md is only a container to descend into — we
 * never treat one as a skill, which is what keeps bundled helper directories
 * from being reported as skills themselves.
 */
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
    return; // root missing → simply no skills there
  }
  // a SKILL.md sitting directly in `dir` makes `dir` a skill AND a container
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
    // first root wins on a name clash, and a shallower skill beats a deeper one
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
        /* unreadable dir → no bundled files */
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
    // Recurse into every subdirectory: nesting means a skill can sit at ANY depth
    // (skills/stage1/template/SKILL.md), and "stage1" itself has no SKILL.md.
    // Bundled helper payloads are not mistaken for skills because a directory
    // only BECOMES a skill when it holds its own SKILL.md (#27).
    await walkSkills(path.join(dir, e.name), source, depth + 1, byName, depthByName);
  }
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
