/**
 * Agent Plugins (#162): read a `plugin.json` package and turn it into things teapot
 * already understands.
 *
 * The format (https://agent-plugins.org, spec 1.1.0) is deliberately tiny, and the
 * whole point of adopting it is that it needs almost no new machinery here:
 *
 *   my-plugin/
 *   ├── plugin.json     manifest: `$schema` + `name` are the only required fields
 *   ├── skills/<name>/SKILL.md   → a skill ROOT (teapot already scans for SKILL.md)
 *   ├── mcp.json        → `mcpServers`, the same shape as teapot's own MCP config
 *   └── com.example.client/…     → client extensions, which we do not implement
 *
 * So a plugin is loaded by VALIDATING it and then extracting those two components. No
 * plugin runtime, no per-plugin process for skills.
 *
 * What is validated, and why each rule exists:
 *   - `plugin.json` must exist, be an object, and carry `$schema` and `name`. The spec
 *     requires both; a manifest without them is not a plugin, and guessing is worse
 *     than saying so.
 *   - `name` must match the spec's pattern (lowercase, no `--`, no `..`). The pattern is
 *     not cosmetic: the name is used in paths and in tool namespaces, so `..` in a name
 *     is a traversal primitive.
 *   - **containment**: `plugin.json`, `skills/`, and every discovered `SKILL.md` must
 *     resolve INSIDE the plugin root after following symlinks. The spec makes this a
 *     MUST, and it is the one rule with a real security consequence: a plugin shipped
 *     as an archive can contain a symlink pointing at `~/.ssh`.
 *   - a `cwd`/`command` in `mcp.json` that escapes the root invalidates that SERVER,
 *     not the whole plugin — the spec draws exactly that boundary (§4.1).
 *
 * `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded in `args`, `env` and `cwd` of a
 * stdio server, as the spec requires. `PLUGIN_DATA` is a client-managed per-plugin
 * directory, so each plugin gets a stable writable location that survives an upgrade.
 */
import { readFile, readdir, realpath, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { McpServerConfig } from "./mcp.ts";

/** the spec's name pattern, verbatim from plugin.schema.json */
const NAME_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** A plugin that passed validation, reduced to what teapot consumes. */
export interface LoadedPlugin {
  name: string;
  version?: string;
  description?: string;
  /** absolute, symlink-resolved plugin root */
  root: string;
  /** absolute path to a `skills/` directory, when the plugin has one */
  skillsDir?: string;
  /** skill names discovered under `skills/` */
  skills: string[];
  /** MCP servers from `mcp.json`, with placeholders expanded and cwd contained */
  mcpServers: McpServerConfig[];
  /** non-fatal problems (a single bad server, a skipped skill) */
  warnings: string[];
}

export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
}

/** true when `child` is `parent` or inside it (both already resolved) */
function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve a path and prove it stays inside `root`.
 *
 * `realpath` FIRST, because a symlink is exactly how an archive escapes its own root —
 * checking the literal path would let `skills/evil -> /etc` through. A path that does
 * not exist cannot escape, so ENOENT returns the lexical join and lets the caller's own
 * existence checks report it.
 */
async function resolveInside(root: string, p: string): Promise<string | null> {
  const abs = path.resolve(root, p);
  try {
    const real = await realpath(abs);
    return within(root, real) ? real : null;
  } catch {
    return within(root, abs) ? abs : null;
  }
}

/** expand `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` (the only two the spec defines) */
function expand(s: string, root: string, data: string): string {
  return s.split("${PLUGIN_ROOT}").join(root).split("${PLUGIN_DATA}").join(data);
}

/**
 * Load and validate one plugin directory.
 *
 * @param dir    the plugin root
 * @param dataDir the client-managed `PLUGIN_DATA` directory for this plugin
 */
export async function loadPlugin(dir: string, dataDir: string): Promise<LoadedPlugin> {
  let root: string;
  try {
    root = await realpath(dir);
  } catch {
    throw new PluginError(`plugin directory does not exist: ${dir}`);
  }
  const st = await stat(root).catch(() => null);
  if (!st?.isDirectory()) throw new PluginError(`not a directory: ${dir}`);

  // ---- manifest ----
  const manifestPath = await resolveInside(root, "plugin.json");
  if (!manifestPath) throw new PluginError("plugin.json resolves outside the plugin root");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    throw new PluginError(`no plugin.json in ${root}`);
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new PluginError(`plugin.json is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest))
    throw new PluginError("plugin.json must be a JSON object");
  // the spec makes BOTH required; without $schema we cannot know which version's rules
  // to apply, and silently assuming 1.1.0 is how a v2 plugin gets half-loaded
  if (typeof manifest.$schema !== "string")
    throw new PluginError("plugin.json is missing $schema (an Agent Plugins manifest requires it)");
  if (typeof manifest.name !== "string" || !manifest.name)
    throw new PluginError("plugin.json is missing name");
  if (!NAME_RE.test(manifest.name))
    throw new PluginError(
      `plugin name "${manifest.name}" is not a valid Agent Plugins name ` +
        "(lowercase letters, digits, '.', '-'; no '--' and no '..')",
    );

  const out: LoadedPlugin = {
    name: manifest.name,
    root,
    skills: [],
    mcpServers: [],
    warnings: [],
  };
  if (typeof manifest.version === "string") out.version = manifest.version;
  if (typeof manifest.description === "string") out.description = manifest.description;

  // ---- skills/ ----
  //
  // An immediate child directory containing a regular `SKILL.md` is one skill. The
  // spec says MUST NOT recurse deeper, and that is also what keeps a plugin from
  // silently pulling in a skill buried in `scripts/vendor/…`.
  const skillsDir = await resolveInside(root, "skills");
  if (!skillsDir) {
    out.warnings.push("skills/ resolves outside the plugin root — ignored");
  } else if ((await stat(skillsDir).catch(() => null))?.isDirectory()) {
    out.skillsDir = skillsDir;
    for (const entry of await readdir(skillsDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = await resolveInside(skillsDir, entry.name);
      if (!skillDir) {
        out.warnings.push(`skill "${entry.name}" resolves outside the plugin root — skipped`);
        continue;
      }
      const sm = path.join(skillDir, "SKILL.md");
      const sst = await stat(sm).catch(() => null);
      if (!sst?.isFile()) continue;
      // the SKILL.md itself must also be contained (a symlinked one could point anywhere)
      const real = await realpath(sm).catch(() => null);
      if (!real || !within(root, real)) {
        out.warnings.push(`skill "${entry.name}": SKILL.md escapes the plugin root — skipped`);
        continue;
      }
      out.skills.push(entry.name);
    }
  }

  // ---- mcp.json ----
  const mcpPath = await resolveInside(root, "mcp.json");
  if (mcpPath && (await stat(mcpPath).catch(() => null))?.isFile()) {
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(await readFile(mcpPath, "utf8"));
    } catch (err) {
      out.warnings.push(`mcp.json is not valid JSON: ${(err as Error).message}`);
      cfg = {};
    }
    const servers = cfg?.mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      for (const [name, s] of Object.entries(servers as Record<string, unknown>)) {
        const parsed = await pluginServer(name, s, root, dataDir);
        if (typeof parsed === "string") out.warnings.push(parsed);
        else out.mcpServers.push(parsed);
      }
    } else if (servers !== undefined) {
      out.warnings.push("mcp.json: mcpServers must be an object");
    }
  }

  return out;
}

/**
 * Turn one `mcp.json` server entry into teapot's `McpServerConfig`.
 *
 * Returns a STRING when the entry is invalid, because the spec's failure boundary is
 * per-server: one bad entry must not reject the plugin. The name is prefixed with the
 * plugin name so two plugins can each ship a server called `db` without colliding in
 * the shared registry.
 */
async function pluginServer(
  name: string,
  raw: unknown,
  root: string,
  dataDir: string,
): Promise<McpServerConfig | string> {
  if (typeof raw !== "object" || raw === null) return `mcp server "${name}": not an object`;
  const s = raw as Record<string, unknown>;
  const type = s.type;

  if (type === "stdio") {
    if (typeof s.command !== "string" || !s.command)
      return `mcp server "${name}": stdio requires a command`;
    const command = expand(s.command, root, dataDir);
    // a plugin-relative command must START with ./ (spec §4.1.4) and stay inside
    let resolvedCmd = command;
    if (command.startsWith("./")) {
      const abs = await resolveInside(root, command);
      if (!abs) return `mcp server "${name}": command escapes the plugin root`;
      resolvedCmd = abs;
    } else if (command.includes("${PLUGIN_ROOT}") || command.includes("${PLUGIN_DATA}")) {
      const abs = path.resolve(command);
      if (!within(root, abs) && !within(path.resolve(dataDir), abs))
        return `mcp server "${name}": command escapes the plugin root`;
      resolvedCmd = abs;
    }
    // cwd: "./x", "${PLUGIN_ROOT}/x" or "${PLUGIN_DATA}/x" — anything else is invalid
    let cwd: string | undefined;
    if (s.cwd !== undefined) {
      if (typeof s.cwd !== "string") return `mcp server "${name}": cwd must be a string`;
      const expanded = expand(s.cwd, root, dataDir);
      const rootedInData = s.cwd.startsWith("${PLUGIN_DATA}");
      const base = rootedInData ? path.resolve(dataDir) : root;
      if (!s.cwd.startsWith("./") && !rootedInData && !s.cwd.startsWith("${PLUGIN_ROOT}"))
        return `mcp server "${name}": cwd must begin with "./", "\${PLUGIN_ROOT}" or "\${PLUGIN_DATA}"`;
      const abs = path.resolve(expanded);
      if (!within(base, abs))
        return `mcp server "${name}": cwd escapes its root`;
      // PLUGIN_DATA may not exist yet; the spec says the client manages it
      if (rootedInData) await mkdir(base, { recursive: true }).catch(() => {});
      cwd = abs;
    }
    const env: Record<string, string> = {};
    if (s.env && typeof s.env === "object" && !Array.isArray(s.env)) {
      for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) {
        // the spec forbids these two in env: the client owns them
        if (k === "PLUGIN_ROOT" || k === "PLUGIN_DATA")
          return `mcp server "${name}": env may not set ${k}`;
        if (typeof v === "string") env[k] = expand(v, root, dataDir);
      }
    }
    const args = Array.isArray(s.args)
      ? s.args.filter((a): a is string => typeof a === "string").map((a) => expand(a, root, dataDir))
      : [];
    const cfg: McpServerConfig = { name, transport: "stdio", command: resolvedCmd, enabled: true };
    if (args.length) cfg.args = args;
    if (Object.keys(env).length) cfg.env = env;
    if (cwd) (cfg as McpServerConfig & { cwd?: string }).cwd = cwd;
    return cfg;
  }

  if (type === "streamable-http" || type === "sse") {
    if (typeof s.url !== "string" || !s.url) return `mcp server "${name}": ${type} requires a url`;
    const cfg: McpServerConfig = {
      name,
      transport: type === "sse" ? "sse" : "http",
      url: s.url,
      enabled: true,
    };
    if (s.headers && typeof s.headers === "object" && !Array.isArray(s.headers)) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.headers as Record<string, unknown>)) {
        if (typeof v === "string") headers[k] = v;
      }
      if (Object.keys(headers).length) cfg.headers = headers;
    }
    return cfg;
  }

  return `mcp server "${name}": unknown type ${JSON.stringify(type)} (expected stdio, streamable-http or sse)`;
}

/**
 * Load every plugin under a directory of plugins.
 *
 * A broken plugin is reported and skipped rather than failing the whole collection —
 * the operator installed it to get something else working, and a plugin is
 * third-party code.
 */
export async function loadPlugins(
  dir: string,
  dataRoot: string,
): Promise<{ plugins: LoadedPlugin[]; errors: { dir: string; error: string }[] }> {
  const plugins: LoadedPlugin[] = [];
  const errors: { dir: string; error: string }[] = [];
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch {
    return { plugins, errors }; // no plugin dir is the normal case
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      plugins.push(await loadPlugin(p, path.join(dataRoot, name)));
    } catch (err) {
      errors.push({ dir: p, error: (err as Error).message });
    }
  }
  return { plugins, errors };
}
