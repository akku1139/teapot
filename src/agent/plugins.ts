import { readFile, readdir, realpath, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { McpServerConfig } from "./mcp.ts";

const NAME_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export interface LoadedPlugin {
  name: string;
  version?: string;
  description?: string;
  root: string;
  skillsDir?: string;
  skills: string[];
  mcpServers: McpServerConfig[];
  warnings: string[];
}

export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
}

function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function resolveInside(root: string, p: string): Promise<string | null> {
  const abs = path.resolve(root, p);
  try {
    const real = await realpath(abs);
    return within(root, real) ? real : null;
  } catch {
    return within(root, abs) ? abs : null;
  }
}

function expand(s: string, root: string, data: string): string {
  return s.split("${PLUGIN_ROOT}").join(root).split("${PLUGIN_DATA}").join(data);
}

export async function loadPlugin(dir: string, dataDir: string): Promise<LoadedPlugin> {
  let root: string;
  try {
    root = await realpath(dir);
  } catch {
    throw new PluginError(`plugin directory does not exist: ${dir}`);
  }
  const st = await stat(root).catch(() => null);
  if (!st?.isDirectory()) throw new PluginError(`not a directory: ${dir}`);

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
      const real = await realpath(sm).catch(() => null);
      if (!real || !within(root, real)) {
        out.warnings.push(`skill "${entry.name}": SKILL.md escapes the plugin root — skipped`);
        continue;
      }
      out.skills.push(entry.name);
    }
  }

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
      if (rootedInData) await mkdir(base, { recursive: true }).catch(() => {});
      cwd = abs;
    }
    const env: Record<string, string> = {};
    if (s.env && typeof s.env === "object" && !Array.isArray(s.env)) {
      for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) {
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
    return { plugins, errors }; 
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
