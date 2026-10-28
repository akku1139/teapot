import { closeAllTerminals, closeTerminalsFor } from "./server/terminals.ts";
import { MIGRATIONS, runMigrations } from "./migrations/registry.ts";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  lstatSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  readSync,
  fsyncSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { currentKey, makeKeyPool, resetPool, type KeyPoolState } from "./agent/key-pool.ts";
import { sessionTitleFrom } from "./session-title.ts";
import path from "node:path";
import os from "node:os";
import { expandTilde, homeDir } from "./home.ts";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Agent } from "./agent/agent.ts";
import { parseSchedule, matches, nextFireAt, type Schedule } from "./scheduler/cron.ts";
import type { LlmConfig, ChatFn } from "./agent/llm.ts";
import type { TeapotEvent } from "./log/events.ts";
import { bus, type BusEvent } from "./bus.ts";
import { mcp } from "./agent/mcp-registry.ts";
import { loadPlugins, type LoadedPlugin } from "./agent/plugins.ts";
import type { McpServerConfig } from "./agent/mcp.ts";
import {
  fetchModelList,
  peekModelList,
  contextLengthFor,
  isReasoningEffort,
  type ModelMeta,
  type ReasoningEffort,
} from "./model-meta.ts";

function dataDirOverrideMismatch(configFilePath: string, effective: string): boolean {
  if (!process.env.TEAPOT_DATA_DIR) return false; 
  try {
    const raw = JSON.parse(readFileSync(configFilePath, "utf8")) as { dataDir?: unknown };
    if (typeof raw.dataDir !== "string" || !raw.dataDir) return false;
    return path.resolve(raw.dataDir) !== path.resolve(effective);
  } catch {
    return false; 
  }
}

const MAX_SPAWN_DEPTH = 3;
const MODEL_META_BOOT_MS = 1_500;
const SETTLED: ReadonlySet<string> = new Set([
  "idle",
  "stopped",
  "waiting",
  "needs_operator",
  "error",
]);

const BUNDLED_SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../skills",
);

function readAppVersion(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const pkg = path.join(dir, "package.json");
      if (existsSync(pkg)) {
        const v = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version;
        if (typeof v === "string" && v) return v;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  return "0.0.0";
}

export function resolveWorkspace(input: string, base: string): string {
  const expanded = expandTilde(input.trim());
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(base, expanded);
}

export const SUB_PERSONAS: Record<
  string,
  { label: string; directive: string; readOnly?: boolean }
> = {
  reviewer: {
    label: "🔍️ reviewer",
    directive:
      "ROLE: code reviewer. Inspect the change set, judge correctness, style, tests; report concrete findings as a prioritized list.",
    readOnly: true,
  },
  tester: {
    label: "🧪 tester",
    directive:
      "ROLE: test engineer. Write and run tests for the task at hand, hunt edge cases, report pass/fail with exact commands.",
  },
  researcher: {
    label: "🔎️ researcher",
    directive:
      "ROLE: read-only explorer. Search the codebase/docs, map how things work, and report a compact briefing with file:line references.",
    readOnly: true,
  },
  implementer: {
    label: "🔨️ implementer",
    directive:
      "ROLE: hands-on implementer. Make the change end-to-end (code + tests), keep edits small and verified, then report what changed and why.",
  },
  "gyaru-reviewer": {
    label: "💅 gyaru reviewer",
    directive:
      "ROLE: pre-commit diff reviewer in a blunt gyaru voice. Read the whole diff and hunt: debug leftovers, unclear UI copy, silent data-loss risks, convention drift. Every finding must be concrete — suggested fix or an explicit shrug.",
    readOnly: true,
  },
};

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  apiKeys?: string[];
  model?: string;
}

export interface AgentConfig {
  id: string;
  workspace: string;
  sessionTitle?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  contextWindowTokens?: number;
  parent?: string;
  archived?: boolean;
  archivedAt?: number;
  chatFn?: ChatFn;
  readOnly?: boolean;
  autoContinue?: boolean;
  autoCompact?: boolean;
  shortContext?: boolean;
  reasoningEffort?: string;
  session?: string;
};

export interface TaskConfig {
  id: string;
  agent: string;
  schedule: string;
  prompt: string;
  forked?: boolean;
  lastRunMin?: number;
}

export interface TeapotConfig {
  port: number;
  host?: string;
  dataDir: string;
  llm: Partial<LlmConfig>;
  providers?: Record<string, ProviderConfig>;
  defaultProvider?: string;
  agents: AgentConfig[];
  /**
   * Session titles, keyed by SESSION ID — one map, so the left panel needs ONE file read.
   *
   * The title was `agents[].sessionTitle`, which is per AGENT: an agent moves between sessions, so the
   * field had to be deleted on every switch (that is what reverted renames), and a session that no agent
   * currently points at had nowhere to keep its name. Keying by session fixes both, and keeps the whole
   * panel readable from `config.json` alone.
   *
   * Storing it in `<session>/session.json` was worse and was measured: 838 sessions = 13.2ms of
   * per-directory reads for every left-panel load, against 1.2ms for one config file — and that cost
   * grows with the number of sessions.
   */
  sessionTitles?: Record<string, string>;
  tasks?: TaskConfig[];
  mcpServers?: McpServerConfig[];
  shortContext?: boolean;
  pluginsDir?: string | false;
  progressIntervalMs?: number;
  progressMinChars?: number;
  contextTokenBudget?: number;
  contextWindowTokens?: number;
  maxSpawnDepth?: number;
  defaultSubagentReasoningEffort?: ReasoningEffort;
  maxTurnsPerRound?: number;
  onError?: "stop" | "retry";
  retryDelayMs?: number;
  password?: string;
  customThemes?: unknown[];
  themePrefs?: { fixed?: string; auto?: boolean; dark?: string; light?: string };
  resumeAfterUpdate?: string[];
}

const CONFIG_DIR =
  process.env.TEAPOT_CONFIG_DIR ??
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "teapot-coding-agent");

const DATA_DIR =
  process.env.TEAPOT_DATA_DIR ??
  process.env.XDG_DATA_HOME ??
  path.join(os.homedir(), ".local", "share", "teapot-coding-agent");

const DEFAULT_CONFIG: TeapotConfig = {
  port: Number(process.env.TEAPOT_PORT ?? 7788),
  host: process.env.TEAPOT_HOST ?? "127.0.0.1",
  dataDir: DATA_DIR,
  llm: {
    baseUrl: process.env.TEAPOT_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: process.env.TEAPOT_API_KEY ?? "",
    model: process.env.TEAPOT_MODEL ?? "",
  },
  providers: {},
  agents: [],
  tasks: [],
};

export function configDir(): string {
  return CONFIG_DIR;
}

export function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath) return path.resolve(explicitPath);
  if (process.env.TEAPOT_CONFIG) return path.resolve(process.env.TEAPOT_CONFIG);
  const xdg = path.join(CONFIG_DIR, "config.json");
  if (existsSync(xdg)) return xdg;
  return path.resolve("teapot.config.json");
}

let masterRawConfig: Record<string, unknown> = {};

export function migrateProviderKeys(p: ProviderConfig): ProviderConfig {
  const seen = new Set<string>();
  const clean = (list: readonly unknown[]): string[] => {
    const out: string[] = [];
    for (const k of list) {
      const t = typeof k === "string" ? k.trim() : "";
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  };

  const hasList = Array.isArray(p.apiKeys);
  const keys = hasList
    ? clean(p.apiKeys!)
    : clean(typeof p.apiKey === "string" ? [p.apiKey] : []);

  if (keys.length === 0) {
    const { apiKeys: _drop, ...rest } = p;
    return rest as ProviderConfig;
  }
  return { ...p, apiKeys: keys, apiKey: keys[0] };
}

export function providerKeys(p: ProviderConfig | undefined): string[] {
  if (!p) return [];
  return migrateProviderKeys(p).apiKeys ?? [];
}

export function loadConfig(configPath: string): TeapotConfig {
  if (!existsSync(configPath)) return DEFAULT_CONFIG;
  mkdirSync(CONFIG_DIR, { recursive: true });
  const user = JSON.parse(readFileSync(configPath, "utf8")) as Partial<TeapotConfig>;
  masterRawConfig = user as Record<string, unknown>;
  return {
    ...DEFAULT_CONFIG,
    ...user,
    dataDir: user.dataDir ? path.resolve(user.dataDir.replace(/^~/, os.homedir())) : DEFAULT_CONFIG.dataDir,
    llm: { ...DEFAULT_CONFIG.llm, ...user.llm },
    providers: Object.fromEntries(
      Object.entries(user.providers ?? {}).map(([name, p]) => [name, migrateProviderKeys(p)]),
    ),
  };
}

function isRegularFileTarget(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return existsSync(path.dirname(p));
  }
}

export function loadedRaw(): Record<string, unknown> {
  return masterRawConfig;
}

const isTTY = process.stdout.isTTY;
const c = (code: string, s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c("2", s);
const clip1 = (s: unknown, n: number) => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
};
const hhmmss = () => new Date().toTimeString().slice(0, 8);

function printAgentEvent(e: TeapotEvent): void {
  const ts = dim(hhmmss());
  const who = c("36", e.agent); 
  const d = e.data as Record<string, unknown>;
  let line: string | null = null;
  switch (e.type) {
    case "prompt":
      line = `${c("33", "▶ prompt")} (${d.source}) ${clip1(d.text, 110)}`;
      break;
    case "tool_call":
      line = `${c("36", "⚙️ exec")} ${d.name} ${dim(clip1(JSON.stringify(d.args ?? {}), 130))}`;
      break;
    case "tool_result": {
      const ok = d.ok !== false;
      const mark = ok ? c("32", "✔ done") : c("31", "✖ fail");
      line = `${mark} ${d.name} ${dim(`${d.durationMs}ms`)} ${dim(clip1(d.result, 90))}`;
      break;
    }
    case "state": {
      if (d.from === d.to && !d.reason && !d.detail) break;
      if (d.detail === "llm turn start") {
        line = `${c("35", "· llm")} turn ${d.turn}`;
        break;
      }
      line = `${c("35", "◆ state")} ${d.from}→${d.to}${d.reason ? ` (${clip1(d.reason, 80)})` : ""}`;
      break;
    }
    case "message":
      if (d.final && d.content) line = `${c("34", "🏁 final")} ${clip1(d.content, 140)}`;
      break; 
    case "progress":
      line = `${c("32", "📈 progress")} ${clip1(d.doing, 100)}`;
      break;
    case "goal":
      line = `🎯 goal ${d.event}: ${clip1(d.text ?? d.status, 100)}`;
      break;
    case "error":
      line = `${c("31", "⚠ error")} ${clip1(d.message, 160)}`;
      break;
    case "system_note": {
      if (d.event === "runaway-detected")
        line = `${c("31", "🛑 runaway")} ${d.failures} consecutive tool failures (limit ${d.limit}) — last: ${clip1(String(d.lastTool), 24)}: ${clip1(String(d.lastError), 90)}`;
      else if (d.event === "error-retry")
        line = `${c("33", "↻ error-retry")} attempt ${d.attempt} — next round in ${Math.round(Number(d.waitMs) / 1000)}s`;
      if (d.event === "llm-retry")
        line = `${c("33", "↻ retry")} attempt ${d.attempt} in ${Math.round(Number(d.waitMs) / 1000)}s — ${clip1(d.error, 100)}`;
      else if (d.event === "context-compacted")
        line = `${c("33", "🗜 compact")} tokens ${d.tokensBefore}→${d.tokensAfter} (${d.mode})`;
      else if (d.event === "session-restored")
        line = `${c("33", "⟲ restore")} branch ${d.branch}, ${d.messages} messages`;
      else if (d.event === "model-changed")
        line = `${c("33", "🧦 model")} → ${d.model} (${d.provider})`;
      else if (d.event === "round-turn-cap")
        line = `${c("33", "⏸ round cap")} ${d.turns} turns — round ended, auto-continue starts the next one`;
      break;
    }
    default:
      break;
  }
  if (line) console.log(`${dim(ts)} ${who} ${line}`);
}

export function sanitizeAgentId(id: string): string {
  const cleaned = String(id ?? "")
    .replace(/[^\w.-]/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 60);
  return cleaned || "agent";
}

export class Master {
  readonly agents = new Map<string, Agent>();
  readonly unavailableAgents = new Map<string, string>();
  plugins: LoadedPlugin[] = [];

  private readonly keyPools = new Map<string, KeyPoolState>();
  replacementPid: number | null = null;
  private tasks: {
    task: TaskConfig;
    schedule: Schedule;
    lastRunMin: number;
    lastRunAt?: number;
  }[] = [];
  private childWaiters = new Map<string, Set<(note: string) => void>>();
  private reportedRunning = new Set<string>();
  private startedAt = Date.now();
  readonly config: TeapotConfig;
  readonly configPath: string;
  configFileExists = true;

  constructor(
    config: TeapotConfig,
    configPath: string,
  ) {
    this.config = config;
    this.configPath = configPath;
    this.sessionsReadOnly = dataDirOverrideMismatch(configPath, config.dataDir);
    if (this.sessionsReadOnly) {
      console.warn(
        `[teapot] TEAPOT_DATA_DIR (${config.dataDir}) disagrees with the config's own dataDir; ` +
          `sessions will be resolved in the override but NOT written back to ${configPath}. ` +
          `Set TEAPOT_CONFIG to an isolated config to silence this.`,
      );
    }
  }

  saveConfig(): void {
    if (this.deferConfigWrites) {
      this.configDirty = true;
      return;
    }
    /**
     * ONE list of the fields `config.json` mirrors from `this.config`.
     *
     * This used to be ad-hoc lines, and it was wrong in two ways that both read as "the setting does not
     * work":
     *
     *   - `progressIntervalMs` / `progressMinChars` were written only when `raw` did not already have
     *     them (`=== undefined`), so the FIRST save persisted and every later change was dropped —
     *     reported as "progress interval (min) が機能してなくない? 少なくともconfig.jsonには書き込まれて
     *     ない";
     *   - `contextTokenBudget`, `contextWindowTokens`, `maxSpawnDepth`, `maxTurnsPerRound`, `onError`
     *     and `retryDelayMs` were never written at all, so those runtime controls could not persist
     *     either.
     *
     * Undefined DELETES the key rather than leaving the old value lying in the file, so clearing a
     * control in the UI actually clears it on disk.
     */
    const mirrored = [
      "agents",
      "providers",
      "defaultProvider",
      "tasks",
      "mcpServers",
      "sessionTitles",
      "customThemes",
      "password",
      "themePrefs",
      "resumeAfterUpdate",
      "shortContext",
      "pluginsDir",
      "progressIntervalMs",
      "progressMinChars",
      "contextTokenBudget",
      "contextWindowTokens",
      "maxSpawnDepth",
      "maxTurnsPerRound",
      "onError",
      "retryDelayMs",
    ] as const;
    for (const key of mirrored) {
      const value = (this.config as unknown as Record<string, unknown>)[key];
      if (value === undefined) delete this.raw[key];
      else this.raw[key] = value;
    }
    this.writeConfigAtomic(JSON.stringify(this.raw, null, 2) + "\n");
  }

  private deferConfigWrites = false;
  private configDirty = false;
  private metaWaited = new Set<string>();
  private sessionsReadOnly = false;

  private flushConfig(): void {
    this.configDirty = false;
    this.saveConfig();
  }

  private keyPoolFor(name: string, prov: ProviderConfig | undefined): KeyPoolState | undefined {
    const keys = providerKeys(prov);
    if (keys.length === 0) return undefined;
    const existing = this.keyPools.get(name);
    if (existing && existing.keys.length === keys.length && existing.keys.every((k, i) => k === keys[i])) {
      return existing;
    }
    const pool = makeKeyPool(keys);
    this.keyPools.set(name, pool);
    return pool;
  }

  keyPoolReport(): { provider: string; keys: number; current: number }[] {
    return [...this.keyPools.entries()].map(([provider, pool]) => ({
      provider,
      keys: pool.keys.length,
      current: pool.current,
    }));
  }

  resetKeyPool(provider?: string): void {
    const names = provider ? [provider] : [...this.keyPools.keys()];
    for (const n of names) {
      const pool = this.keyPools.get(n);
      if (pool) resetPool(pool);
    }
  }

  private writeConfigAtomic(body: string): void {
    if (!isRegularFileTarget(this.configPath)) {
      writeFileSync(this.configPath, body);
      return;
    }
    const dir = path.dirname(this.configPath);
    const tmp = path.join(dir, `.config.json.tmp-${process.pid}-${Date.now()}`);
    let fd: number | undefined;
    try {
      fd = openSync(tmp, "w");
      writeFileSync(fd, body);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.configPath);
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
      }
      throw err;
    }
  }
  private raw: Record<string, unknown> = loadedRaw();

  updateConfig(patch: {
    providers?: Record<string, ProviderConfig>;
    defaultProvider?: string;
    progressIntervalMs?: number;
    progressMinChars?: number;
    contextTokenBudget?: number | null;
    contextWindowTokens?: number | null;
    maxSpawnDepth?: number;
    maxTurnsPerRound?: number;
    onError?: "stop" | "retry";
    retryDelayMs?: number;
    tasks?: TaskConfig[];
    mcpServers?: McpServerConfig[];
  shortContext?: boolean;
  pluginsDir?: string | false;
  password?: string;
  }): void {
    if (patch.providers) this.config.providers = patch.providers;
    if (patch.password !== undefined) this.config.password = patch.password || undefined;
    if (patch.defaultProvider !== undefined) this.config.defaultProvider = patch.defaultProvider;
    if (patch.progressIntervalMs !== undefined) {
      this.config.progressIntervalMs = patch.progressIntervalMs;
      for (const a of this.agents.values())
        (a as unknown as { opts: { progressIntervalMs: number } }).opts.progressIntervalMs =
          patch.progressIntervalMs;
    }
    if (patch.progressMinChars !== undefined) {
      this.config.progressMinChars = patch.progressMinChars;
      for (const a of this.agents.values())
        (a as unknown as { opts: { progressMinChars: number } }).opts.progressMinChars =
          patch.progressMinChars;
    }
    if (patch.contextTokenBudget !== undefined) {
      this.config.contextTokenBudget =
        (patch.contextTokenBudget ?? 0) > 0 ? patch.contextTokenBudget! : undefined;
    }
    if (patch.maxSpawnDepth !== undefined) this.config.maxSpawnDepth = patch.maxSpawnDepth;
    if (patch.mcpServers !== undefined) this.config.mcpServers = patch.mcpServers;
    if (patch.shortContext !== undefined) {
      this.config.shortContext = patch.shortContext;
      for (const a of this.agents.values())
        (a as unknown as { opts: { shortContext?: boolean } }).opts.shortContext =
          patch.shortContext;
    }
    if (patch.maxTurnsPerRound !== undefined) this.config.maxTurnsPerRound = patch.maxTurnsPerRound;
    if (patch.onError !== undefined) this.config.onError = patch.onError;
    if (patch.retryDelayMs !== undefined) this.config.retryDelayMs = patch.retryDelayMs;
    if (patch.contextWindowTokens !== undefined) {
      this.config.contextWindowTokens =
        (patch.contextWindowTokens ?? 0) > 0 ? patch.contextWindowTokens! : undefined;
    }
    /**
     * No `this.raw[...] = v` loop here — `saveConfig()` owns the mirror now (see its `mirrored` list).
     *
     * There used to be one, covering six of these keys and not the other two, which is exactly how the
     * runtime controls ended up in different states: `contextTokenBudget` persisted, `progressIntervalMs`
     * did not. One owner, one rule — and it runs once, at the end, after `tasks` is updated too.
     */
    if (patch.tasks) {
      this.config.tasks = patch.tasks;
      this.tasks = patch.tasks.map((t) => ({
        task: t,
        schedule: parseSchedule(t.schedule),
        lastRunMin: t.lastRunMin ?? -1,
      }));
    }
    this.saveConfig();
  }

  async loadPluginsAndMcp(): Promise<McpServerConfig[]> {
    const pluginMcp: McpServerConfig[] = [];
    if (this.config.pluginsDir !== false) {
      const dir = this.config.pluginsDir ?? path.join(CONFIG_DIR, "plugins");
      const { plugins, errors } = await loadPlugins(dir, path.join(DATA_DIR, "plugin-data"));
      this.plugins = plugins;
      for (const e of errors) console.error(`[teapot] skipping plugin ${e.dir}: ${e.error}`);
      for (const p of plugins) {
        for (const w of p.warnings) console.error(`[teapot] plugin "${p.name}": ${w}`);
        pluginMcp.push(...p.mcpServers.map((s) => ({ ...s, name: `${p.name}:${s.name}` })));
      }
      if (plugins.length)
        console.error(
          `[teapot] loaded ${plugins.length} plugin(s): ${plugins.map((p) => p.name).join(", ")}`,
        );
    }
    return [...(this.config.mcpServers ?? []), ...pluginMcp];
  }

  async start(): Promise<void> {
    mkdirSync(this.config.dataDir, { recursive: true });
    this.configDirty = false;
    await runMigrations(MIGRATIONS, {
      configDir: path.dirname(this.configPath),
      raw: () => this.raw,
      touch: () => {
        this.configDirty = true;
      },
      dataDir: this.config.dataDir,
      log: (m) => console.log(`[teapot] ${m}`),
    });
    this.deferConfigWrites = true;
    this.prefetchModelLists();
    if (this.config.mcpServers?.length || this.config.pluginsDir !== false) {
      mcp.init(this.config.dataDir);
      const allMcp = await this.loadPluginsAndMcp();
      if (allMcp.length) {
        mcp.apply(allMcp);
        void mcp.connectAll();
      }
    }
    try {
      for (const ac of this.config.agents) {
        if (ac.archived) {
          this.unavailableAgents.set(ac.id, "archived");
          continue;
        }
        try {
          await this.addAgent(ac);
        } catch (err) {
          console.error(`[teapot] skipping agent "${ac.id}": ${(err as Error).message}`);
          this.unavailableAgents.set(ac.id, (err as Error).message);
        }
      }
      for (const t of this.config.tasks ?? []) {
        try {
          this.tasks.push({
            task: t,
            schedule: parseSchedule(t.schedule),
            lastRunMin: t.lastRunMin ?? -1,
          });
        } catch (err) {
          console.error(`[teapot] skipping task "${t.id}": ${(err as Error).message}`);
        }
      }
    } finally {
      this.deferConfigWrites = false;
      if (this.configDirty) this.flushConfig();
    }
    setInterval(() => void this.tick(), 15_000).unref();
  }

  async applySetup(body: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    defaultProvider?: string;
    workspace?: string;
    agentName?: string;
    password?: string;
  }): Promise<{ ok: true; agentId?: string }> {
    if (this.configFileExists)
      throw new Error("setup already completed — edit the config file instead");

    const llm = {
      baseUrl: body.baseUrl,
      ...(body.apiKey ? { apiKey: body.apiKey } : {}),
      model: body.model,
    };
    const raw: Record<string, unknown> = {
      llm,
      ...(body.password ? { password: body.password } : {}),
      agents: [] as unknown[],
    };

    const dir = path.dirname(this.configPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(raw, null, 2) + "\n");

    this.config.llm = { ...this.config.llm, ...llm };
    if (body.password) this.config.password = body.password;
    this.configFileExists = true;
    this.raw.llm = llm;
    if (body.password) this.raw.password = body.password;
    try {
      const list = await fetchModelList(llm.baseUrl, body.apiKey);
      const cl = contextLengthFor(list, llm.model);
      if (cl) {
        this.config.contextWindowTokens = cl;
        this.raw.contextWindowTokens = cl;
        raw.contextWindowTokens = cl; 
        writeFileSync(this.configPath, JSON.stringify(raw, null, 2) + "\n");
      }
    } catch {
    }

    let agentId: string | undefined;
    if (body.workspace?.trim()) {
      const ws = resolveWorkspace(body.workspace, path.dirname(this.configPath));
      await mkdirSync(ws, { recursive: true });
      const name =
        (body.agentName?.trim() || path.basename(ws))
          .replace(/[^\w.-]/g, "-")
          .slice(0, 40) || "agent";
      let id = name;
      let n = 2;
      while (this.agents.has(id)) id = `${name.slice(0, 38)}-${n++}`;
      const agent = await this.addAgent(
        { id, workspace: ws },
        { persist: true, fresh: true },
      );
      agentId = id;
      agent.start("created by setup wizard");
    }
    return { ok: true, agentId };
  }

  private prefetchModelLists(): void {
    const endpoints = new Set<string>();
    const add = (baseUrl?: string, apiKey?: string): void => {
      if (!baseUrl) return;
      const key = baseUrl.replace(/\/+$/, "");
      if (endpoints.has(key)) return;
      endpoints.add(key);
      void fetchModelList(baseUrl, apiKey).catch(() => []);
    };
    for (const ac of this.config.agents) {
      const prov = this.config.providers?.[ac.provider ?? this.config.defaultProvider ?? ""];
      add(ac.baseUrl ?? prov?.baseUrl ?? this.config.llm.baseUrl, ac.apiKey ?? prov?.apiKey ?? this.config.llm.apiKey);
    }
    if (endpoints.size === 0) add(this.config.llm.baseUrl, this.config.llm.apiKey);
  }

  async addAgent(
    ac: AgentConfig,
    opts: { persist?: boolean; fresh?: boolean } = {},
  ): Promise<Agent> {
    const safeId = sanitizeAgentId(ac.id);
    if (safeId !== ac.id) {
      console.warn(`[teapot] agent id ${JSON.stringify(ac.id)} contained unsafe characters; using ${JSON.stringify(safeId)}`);
    }
    ac = { ...ac, id: safeId };
    if (this.agents.has(ac.id)) throw new Error(`agent id already exists: ${ac.id}`);
    const provName = ac.provider ?? this.config.defaultProvider ?? "openrouter";
    const prov = this.config.providers?.[provName];
    if (!prov && !ac.baseUrl && !this.config.llm.baseUrl) {
      throw new Error(`agent ${ac.id}: unknown provider "${provName}" and no fallback`);
    }
    const inlineKey = typeof ac.apiKey === "string" && ac.apiKey.trim() ? ac.apiKey.trim() : undefined;
    const pool = inlineKey ? undefined : this.keyPoolFor(provName, prov);
    const llm: LlmConfig = {
      baseUrl: ac.baseUrl ?? prov?.baseUrl ?? this.config.llm.baseUrl!,
      apiKey:
        inlineKey ??
        currentKey(pool) ??
        prov?.apiKey ??
        this.config.llm.apiKey!,
      model: ac.model ?? prov?.model ?? this.config.llm.model!,
      timeoutMs: 120_000,
      ...(pool && pool.keys.length > 1 ? { keyPool: pool } : {}),
    };
    if (!llm.model) throw new Error(`agent ${ac.id}: no model configured (set model on the agent or on its provider)`);
    const myDepth = ac.parent ? this.depthOf(ac.parent) + 1 : 0;
    const needsWindow = !ac.contextWindowTokens && !this.config.contextWindowTokens;
    const root = llm.baseUrl.replace(/\/+$/, "");
    let list = peekModelList(llm.baseUrl);
    if (list === undefined && !this.metaWaited.has(root)) {
      this.metaWaited.add(root);
      list = await Promise.race([
        fetchModelList(llm.baseUrl, llm.apiKey),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), MODEL_META_BOOT_MS)),
      ]);
    }
    const inferredWindow = needsWindow && list ? contextLengthFor(list, llm.model) : undefined;
    const modelMeta = list?.find((m) => m.id === llm.model);
    const sessionDir = this.resolveSessionDir(ac.id, opts.fresh === true);
    await mkdirSync(sessionDir, { recursive: true });
    this.writeSessionManifest(sessionDir, ac.id);
    const agent = new Agent({
      id: ac.id,
      workspace: resolveWorkspace(ac.workspace, path.dirname(this.configPath)),
      onFirstUserPrompt: (sessionId, firstText) => {
        void this.ensureSessionTitle(ac.id, sessionId, firstText);
      },
      // ONE owner for a session's name: this map. The agent derives it on every snapshot.
      sessionTitleOf: (sessionId) => this.readSessionTitle(sessionId) ?? undefined,
      llm,
      sessionDir,
      // boot must touch ONLY config.json and skills; this agent's directory is opened when it is used
      deferSessionReads: true,
      progressIntervalMs: this.config.progressIntervalMs,
      ...(this.config.progressMinChars ? { progressMinChars: this.config.progressMinChars } : {}),
      ...(this.config.maxTurnsPerRound !== undefined ? { maxTurnsPerRound: this.config.maxTurnsPerRound } : {}),
      ...(this.config.onError ? { onError: this.config.onError } : {}),
      ...(this.config.retryDelayMs ? { retryDelayMs: this.config.retryDelayMs } : {}),
      autoContinue: ac.autoContinue ?? true,
      ...(ac.autoCompact === false ? { autoCompact: false } : {}),
      ...((ac.shortContext ?? this.config.shortContext) ? { shortContext: true } : {}),
      ...(this.config.contextTokenBudget ? { contextTokenBudget: this.config.contextTokenBudget } : {}),
      ...(ac.contextWindowTokens || this.config.contextWindowTokens || inferredWindow
        ? {
            contextWindowTokens: (
              ac.contextWindowTokens ??
              this.config.contextWindowTokens ??
              inferredWindow
            )!,
          }
        : {}),
      globalSkillsDir: path.join(CONFIG_DIR, "skills"),
      bundledSkillsDir: BUNDLED_SKILLS_DIR,
      pluginSkillRoots: this.plugins
        .filter((p) => p.skillsDir)
        .map((p) => ({ dir: p.skillsDir!, source: `plugin:${p.name}` })),
      provider: provName,
      spawnDepth: myDepth,
      ...(ac.readOnly ? { readOnlyTools: true } : {}),
      ...(ac.parent ? { parent: ac.parent } : {}),
      ...(ac.chatFn ? { chatFn: ac.chatFn } : {}),
      ...(ac.reasoningEffort ? { reasoningEffort: ac.reasoningEffort } : {}),
      ...(modelMeta?.supportedEfforts?.length ? { supportedEfforts: modelMeta.supportedEfforts } : {}),
      // decides the spelling of a turn's thinking on the wire (#187)
      ...(modelMeta?.supportedParameters?.length ? { supportedParameters: modelMeta.supportedParameters } : {}),
    });
    void fetchModelList(llm.baseUrl, llm.apiKey)
      .then((list) => agent.setModelPricing(list.find((m) => m.id === llm.model)?.pricing))
      .catch(() => {});
    agent.log.onEvent = (e) => {
      printAgentEvent(e);
      bus.emit("update", { kind: "event", agentId: e.agent, event: e } satisfies BusEvent);
      this.onChildEvent(ac, e);
    };
    agent.onControlStatusChange = (agentId, status) => {
      if (!ac.parent) return;
      const parent = this.agents.get(ac.parent);
      if (!parent) return;
      this.wakeAncestorWaiters(ac.parent);
      if (this.reportedRunning.has(agentId) && SETTLED.has(status))
        parent.enqueuePrompt(
          `[harness] Sub-agent @${agentId} is now ${status} without having called finish(), so it has not reported a result.` +
            (status === "error"
              ? ` Check its last output before deciding whether to re-spawn it.`
              : status === "stopped"
                ? ` It may have been stopped mid-task; message it to resume, or re-spawn it.`
                : ` If you expected a result, message it or re-spawn it.`),
          "harness",
        );
      if (status === "running") this.reportedRunning.add(agentId);
      else if (SETTLED.has(status)) this.reportedRunning.delete(agentId);
    };
    if (myDepth < this.maxSpawnDepth()) {
      const self = agent;
      const hooks = {
        depth: myDepth,
        spawn: (o: { task: string; context: "none" | "fork"; name?: string; persona?: string }) =>
          this.spawnChildFor(self, o),
        list: () =>
          this.subtreeOf(ac.id).flatMap(({ id, depth, parent }) => {
            const inst = this.agents.get(id);
            if (!inst) return []; 
            return [
              {
                id,
                status: inst.status,
                goal: inst.goal.text,
                parent,
                nested: depth > 1,
              },
            ];
          }),
        stop: (ids?: string[]) => this.stopChildrenFor(ac.id, ids),
        message: (id: string, text: string) => this.messageChild(ac.id, id, text),
        wait: (ids: string[] | undefined, ms: number) =>
          this.waitChildren(ac.id, ids, ms, self.toolCtx.signal),
      };
      (
        agent as unknown as {
          toolCtx: { subAgents: typeof hooks };
        }
      ).toolCtx.subAgents = hooks;
    }
    await agent.init();
    /**
     * No title is seeded, and nothing is derived here.
     *
     * The agent derives its name from `config.sessionTitles` on every `snapshot()` (see
     * `sessionTitleOf`), so there is no copy to seed. Deriving a missing one here would read
     * `chat.jsonl`, and boot must not open session directories — "起動中に読んでいいのはconfig.jsonと
     * skillsだけ / セッションディレクトリはセッションがロードされるまで開かない".
     */
    this.agents.set(ac.id, agent);
    if (opts.persist) {
      this.config.agents.push(ac);
      this.saveConfig();
    }
    this.recordSession(ac, path.basename(sessionDir));
    return agent;
  }

  private recordSession(ac: AgentConfig, sessionId: string): void {
    if (!sessionId || ac.session === sessionId) return;
    ac.session = sessionId;
    const entry = this.config.agents.find((a) => a.id === ac.id);
    if (!entry) return; 
    entry.session = sessionId;
    // The title is NOT deleted here: it now lives in the session's own manifest, so moving to another
    // session simply means reading a different one. (Deleting it was how a rename reverted to the
    // auto-generated name on the next switch.)
    delete entry.sessionTitle;
    delete ac.sessionTitle;
    if (this.sessionsReadOnly) return;
    this.saveConfig();
  }

  private depthOf(id: string, seen = new Set<string>()): number {
    const cap = this.maxSpawnDepth();
    let depth = 0;
    let cur = this.config.agents.find((a) => a.id === id);
    while (cur?.parent && !seen.has(cur.id) && depth < cap + 2) {
      seen.add(cur.id);
      cur = this.config.agents.find((a) => a.id === cur!.parent);
      depth++;
    }
    return depth;
  }

  private maxSpawnDepth(): number {
    const v = this.config.maxSpawnDepth;
    return typeof v === "number" && v >= 0 ? v : MAX_SPAWN_DEPTH;
  }

  private childrenOf(id: string): { id: string; agent: Agent }[] {
    const kids = this.config.agents.filter((a) => a.parent === id);
    const out: { id: string; agent: Agent }[] = [];
    for (const k of kids) {
      const inst = this.agents.get(k.id);
      if (inst) out.push({ id: k.id, agent: inst });
    }
    return out;
  }

  private subtreeOf(id: string, depth = 1, seen = new Set<string>()): { id: string; depth: number; parent: string }[] {
    const out: { id: string; depth: number; parent: string }[] = [];
    for (const a of this.config.agents) {
      if (a.parent !== id) continue;
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ id: a.id, depth, parent: id }, ...this.subtreeOf(a.id, depth + 1, seen));
    }
    return out;
  }

  private descendantsOf(id: string, seen = new Set<string>()): string[] {
    return this.subtreeOf(id, 1, seen).map((x) => x.id);
  }

  async spawnChildFor(
    parent: Agent,
    o: {
      task: string;
      context: "none" | "fork";
      name?: string;
      persona?: string;
      reasoning_effort?: string;
    },
  ): Promise<{ id: string }> {
    const parentId = parent.opts_id();
    const persona =
      o.persona && Object.prototype.hasOwnProperty.call(SUB_PERSONAS, o.persona)
        ? o.persona
        : undefined;
    const base = `${parentId}-sub${persona ? `-${persona}` : ""}${o.name ? `-${o.name.replace(/[^\w.-]/g, "-").slice(0, 24)}` : ""}`.slice(0, 60);
    let id = base;
    let n = 2;
    while (this.agents.has(id) || this.config.agents.some((a) => a.id === id))
      id = `${base.slice(0, 56)}-${n++}`;

    const directive = persona ? `${SUB_PERSONAS[persona].label}\n${SUB_PERSONAS[persona].directive}\n\n` : "";
    const pcfg = this.config.agents.find((a) => a.id === parentId);
    let forkTip: string | null | undefined;
    let forkBranch: string | undefined;
    if (o.context === "fork") {
      forkTip = parent.log.lastEventId(parent.currentBranch);
      forkBranch = parent.currentBranch;
    }
    const childEffort =
      o.reasoning_effort || this.config.defaultSubagentReasoningEffort || pcfg?.reasoningEffort;
    const child = await this.addAgent(
      {
        id,
        workspace: parent.workspace,
        provider: pcfg?.provider,
        model: pcfg?.model,
        contextWindowTokens: pcfg?.contextWindowTokens,
        ...(childEffort ? { reasoningEffort: childEffort } : {}),
        parent: parentId,
        ...(persona && SUB_PERSONAS[persona]?.readOnly ? { readOnly: true } : {}),
      },
      { persist: true, fresh: true },
    );
    if (o.context === "fork" && forkTip) {
      await child.log.append("sub_fork", id, "br0", {
        parentAgent: parentId,
        parentSession: path.basename(parent.snapshot().sessionDir),
        parentBranch: forkBranch,
        upToEvent: forkTip,
      });
      child.importMessages(parent.exportMessages());
    }
    await child.setGoal(`${directive}${o.task}`.slice(0, 2000));
    await child.enqueuePrompt(
      (o.context === "fork"
        ? `[harness] You are sub-agent ${id}, spawned by @${parentId}.

The conversation above is REFERENCE CONTEXT ONLY — background on why this work is needed.
It contains older tasks and discussions that are NOT yours. Do not resume, continue, or
finish any of them; other agents own those. If you find yourself working on anything other
than the task below, STOP and return to it.

YOUR ONE AND ONLY TASK — everything else in the inherited context is out of scope:

${directive}${o.task}

When this task is done (or truly blocked), call finish() with a summary for @${parentId}.`
        : `[harness] You are sub-agent ${id}, spawned by @${parentId}. Work solely on this task:\n\n${directive}${o.task}\n\nWhen it is done (or truly blocked), call finish() with a summary for @${parentId}.`),
      "harness",
    );
    child.start(`spawned by ${parentId}`);
    console.log(`[teapot] sub-agent ${id} spawned by ${parentId} (context: ${o.context ?? "none"}${persona ? `, persona: ${persona}` : ""})`);
    return { id };
  }

  async stopChildrenFor(parentId: string, ids?: string[]): Promise<{ stopped: string[] }> {
    const stopped: string[] = [];
    const walk = (pid: string, inScope: boolean) => {
      for (const { id, agent } of this.childrenOf(pid)) {
        const take = inScope || !ids || ids.includes(id);
        if (!take) {
          walk(id, false);
          continue;
        }
        agent.stop("stopped by parent agent");
        stopped.push(id);
        walk(id, true);
      }
    };
    walk(parentId, false);
    return { stopped };
  }

  waitChildren(
    parentId: string,
    ids: string[] | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ note: string }> {
    const named = ids && ids.length ? ids : this.descendantsOf(parentId);
    const targets = [...new Set(named.flatMap((id) => [id, ...this.descendantsOf(id)]))].filter((id) =>
      this.agents.has(id),
    );
    if (targets.length === 0)
      return Promise.resolve({ note: "no live sub-agents to wait for" });

    const active = () => targets.filter((id) => this.agents.get(id)?.isBusy());

    const first = active();
    if (first.length === 0)
      return Promise.resolve({ note: `all sub-agents already settled: ${targets.join(", ")}` });

    return new Promise((resolve) => {
      let done = false;
      const finish = (note: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        set.delete(wake);
        signal?.removeEventListener("abort", onAbort);
        resolve({ note });
      };
      const onAbort = () => finish("aborted while waiting");
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        const left = active();
        finish(`timeout after ${Math.round(timeoutMs / 1000)}s — still running: ${left.join(", ") || "(none)"}`);
      }, timeoutMs);

      const wake = (_note?: string) => {
        const left = active();
        if (left.length > 0) return; 
        clearTimeout(timer);
        finish(`all sub-agents settled: ${targets.join(", ")}`);
      };

      const set = this.childWaiters.get(parentId) ?? new Set();
      if (!this.childWaiters.has(parentId)) this.childWaiters.set(parentId, set);
      set.add(wake);
if (active().length === 0) wake();
    });
  }

  private wakeParentWaiters(parentId: string): void {
    const set = this.childWaiters.get(parentId);
    if (!set) return;
    for (const fn of set) {
      try { fn("child event"); } catch {  }
    }
  }

  private wakeAncestorWaiters(parentId: string | undefined): void {
    const seen = new Set<string>();
    let cur = parentId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      this.wakeParentWaiters(cur);
      cur = this.config.agents.find((a) => a.id === cur)?.parent;
    }
  }

  private async messageChild(parentId: string, childId: string, text: string): Promise<void> {
    let targetId = childId;
    const owned = this.sessionById(childId);
    if (owned) targetId = owned.agentId;

    const caller = this.config.agents.find((a) => a.id === parentId);
    const target = this.config.agents.find((a) => a.id === targetId);
    const childToParent = target?.parent === parentId;
    if (target && caller?.parent === targetId) {
      const p = this.agents.get(targetId);
      if (!p) throw new Error(`sub-agent not running: ${targetId}`);
      p.enqueuePrompt(`[harness] Message from sub-agent @${parentId}:\n\n${text}`, "harness");
      if (p.status !== "running") p.start(`message from sub-agent ${parentId}`);
      return;
    }

    const cfg = target;
    if (!cfg || (!childToParent && cfg.parent !== parentId)) {
      const actual = cfg?.parent;
      const live = actual ? this.agents.get(actual) : undefined;
      const detail = actual
        ? ` its parent is @${actual}${live ? ` (message @${actual} instead, or spawn your own sub-agent for it)` : ""}.`
        : " no such sub-agent exists.";
      throw new Error(`not your sub-agent: ${childId}.${detail}`);
    }
    const child = this.agents.get(targetId);
    if (!child) throw new Error(`sub-agent not running: ${targetId}`);
    child.enqueuePrompt(`[harness] Message from @${parentId}:\n\n${text}`, "harness");
    if (child.status !== "running") child.start(`message from ${parentId}`);
  }

  private onChildEvent(ac: { parent?: string; id: string }, e: { type: string; data: unknown; agent: string }): void {
    const parentId = ac.parent;
    if (!parentId) return;
    this.wakeAncestorWaiters(parentId);
    const parent = this.agents.get(parentId!);
    if (!parent) return;

    if (e.type === "message" && (e.data as { final?: boolean; content?: string }).final) {
      const d = e.data as { content?: string; recentContext?: string[] };
      const summary = String(d.content ?? "").trim();
      let report = summary;
      if (Array.isArray(d.recentContext) && d.recentContext.length) {
        report +=
          "\n\n[Last conversation turns before finishing]\n" +
          d.recentContext.map((r) => r).join("\n\n");
      }
      parent.enqueuePrompt(
        `[harness] Sub-agent ${ac.id} finished. Final report:\n${report || "(no summary)"}`,
        "harness",
      );
      if (parent.status !== "running") parent.start(`sub-agent ${ac.id} finished`);
    } else if (e.type === "error") {
      parent.enqueuePrompt(
        `[harness] Sub-agent ${ac.id} hit an error: ${String((e.data as { message?: string }).message ?? "").slice(0, 500)}`,
        "harness",
      );
      if (parent.status !== "running") parent.start(`sub-agent ${ac.id} error`);
    }

  }

  sessionsRoot(): string {
    return path.join(this.config.dataDir, "sessions");
  }

  private readSessionOwner(dirName: string): string | null {
    try {
      const raw = JSON.parse(readFileSync(path.join(this.sessionsRoot(), dirName, "session.json"), "utf8")) as {
        agentId?: unknown;
      };
      return typeof raw.agentId === "string" ? raw.agentId : null;
    } catch {
      return null; 
    }
  }

  private inferSessionOwner(
    dirName: string,
    candidateIds: Iterable<string>,
  ): { owner: string | null; hadManifest: boolean } {
    const fromManifest = this.readSessionOwner(dirName);
    if (fromManifest) return { owner: fromManifest, hadManifest: true };
    let best: { id: string; len: number } | null = null;
    for (const id of candidateIds) {
      if (!id) continue;
      if ((id === dirName || dirName.startsWith(`${id}-`)) && (!best || id.length > best.len))
        best = { id, len: id.length };
    }
    return { owner: best?.id ?? null, hadManifest: false };
  }

  private logOwner(dirName: string): string | null {
    let fd: number | undefined;
    try {
      fd = openSync(path.join(this.sessionsRoot(), dirName, "chat.jsonl"), "r");
      const buf = Buffer.alloc(8 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      if (n <= 0) return null;
      const head = buf.subarray(0, n).toString("utf8");
      const nl = head.indexOf("\n");
      const line = (nl >= 0 ? head.slice(0, nl) : head).trim();
      if (!line) return null;
      const parsed = JSON.parse(line) as { agent?: unknown };
      return typeof parsed.agent === "string" && parsed.agent ? parsed.agent : null;
    } catch {
      return null; 
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
        }
      }
    }
  }

  private titleFor(agentId: string, sessionId: string): string | undefined {
    const a = this.config.agents.find((x) => x.id === agentId);
    if (!a || a.session !== sessionId) return undefined;
    return this.readSessionTitle(sessionId) ?? undefined;
  }

  /** The session's own name, from its manifest. One place, so it cannot go stale in another. */
  private readSessionTitle(sessionId: string): string | null {
    if (!sessionId) return null;
    const t = this.config.sessionTitles?.[sessionId];
    return typeof t === "string" && t.trim() ? t.trim() : null;
  }

  private writeSessionTitle(sessionId: string, title: string): void {
    if (!sessionId) return;
    /**
     * Never write when the data dir was overridden by `TEAPOT_DATA_DIR`.
     *
     * In that mode the sessions being resolved are NOT the ones this config describes, so recording
     * anything about them — a pointer, or now a title — corrupts a config the operator did not ask to
     * change (#143). The title is still derived in memory so the UI shows something.
     */
    if (this.sessionsReadOnly) {
      this.config.sessionTitles ??= {};
      this.config.sessionTitles[sessionId] = title;
      return;
    }
    this.config.sessionTitles ??= {};
    this.config.sessionTitles[sessionId] = title;
    /**
     * …and the LIVE agent has to be told, or the panel keeps showing the id.
     *
     * `addAgent` seeds an agent's title from this map when it is created, falling back to the session id.
     * A NEW session gets its entry written later (on the first prompt, from `chat.jsonl`), and nothing
     * pushed it back — so the agent still held the id and the panel displayed it while `config.json` had
     * the real name. Reported as "config.jsonにチャットタイトルが生成されているのに表示が内部IDになってる".
     *
     * Pushing here rather than in each caller means every writer (the derivation, a rename) is covered by
     * one rule: the map changed, so the agent that is showing it changes too.
     */
    this.saveConfig();
  }

  /**
   * Derive a session's title ONCE, into the session's own manifest.
   *
   * Deriving it at read time would be worse: `sessionsOf`/`archivedAgents` would scan a `chat.jsonl`
   * per session on every call (MEASURED earlier: 0.87s for one archive toggle). Writing it down once,
   * where the session lives, keeps that scan off the hot path and keeps the answer in ONE place.
   */
  private async ensureSessionTitle(agentId: string, sessionId: string, firstText?: string): Promise<void> {
    const a = this.config.agents.find((x) => x.id === agentId);
    if (!a || a.session !== sessionId) return;
    // the map is the master: once it has a name, nothing may replace it
    if (this.readSessionTitle(sessionId)) return;
    /**
     * A session is named from its FIRST USER MESSAGE — that is the whole point of this hook, and it must
     * keep working for a session created at runtime.
     *
     * The text arrives from the agent, which already has it, so this needs no read of `chat.jsonl`. The
     * log is only a fallback for a caller that could not supply it.
     */
    const fromText = sessionTitleFrom(firstText) ?? undefined;
    const derived = fromText ?? this.sessionTitleOf(path.join(this.sessionsRoot(), sessionId)) ?? sessionId;
    this.writeSessionTitle(sessionId, derived);
  }

  private sessionTitleOf(dirPath: string): string | null {
    let fd: number | undefined;
    try {
      fd = openSync(path.join(dirPath, "chat.jsonl"), "r");
      const CHUNK = 16 * 1024;
      const CAP = 256 * 1024;
      const buf = Buffer.alloc(CHUNK);
      let offset = 0;
      let carry = "";
      while (offset < CAP) {
        const n = readSync(fd, buf, 0, CHUNK, offset);
        if (n <= 0) break;
        offset += n;
        const lines = (carry + buf.subarray(0, n).toString("utf8")).split("\n");
        carry = lines.pop() ?? "";
        for (const l of lines) {
          if (!l) continue;
          let e: { type?: unknown; data?: { source?: unknown; text?: unknown } };
          try {
            e = JSON.parse(l) as typeof e;
          } catch {
            continue; 
          }
          if (e.type !== "prompt") continue;
          if (e.data?.source !== "user") return null;
          return sessionTitleFrom(typeof e.data.text === "string" ? e.data.text : null);
        }
      }
      return null;
    } catch {
      return null; 
    } finally {
      if (fd !== undefined)
        try {
          closeSync(fd);
        } catch {
        }
    }
  }

  private writeSessionManifest(dirPath: string, agentId: string): void {
    try {
      const file = path.join(dirPath, "session.json");
      if (existsSync(file)) {
        const current = this.readSessionOwner(path.basename(dirPath));
        if (current === agentId) return;
        const proven = this.logOwner(path.basename(dirPath));
        if (proven !== agentId) return; 
        console.log(
          `[teapot] repairing session manifest for ${path.basename(dirPath)}: ` +
            `${JSON.stringify(current)} → ${JSON.stringify(agentId)} (the log says ${JSON.stringify(agentId)})`,
        );
      }
      writeFileSync(file, `${JSON.stringify({ v: 1, agentId }, null, 2)}\n`);
    } catch {
    }
  }

  private findLatestSessionDir(agentId: string): string | null {
    const candidateIds = new Set<string>([agentId]); 
    for (const a of this.config.agents) if (a.id) candidateIds.add(a.id);
    for (const [liveId] of this.agents) candidateIds.add(liveId);
    let dirs: string[] = [];
    try {
      const withHistory: { d: string; m: number }[] = [];
      const empty: { d: string; m: number }[] = [];
      for (const d of readdirSync(this.sessionsRoot())) {
        const { owner } = this.inferSessionOwner(d, candidateIds);
        const mineByLog = owner !== agentId && this.logOwner(d) === agentId;
        if (owner !== agentId && !mineByLog) continue;
        if (mineByLog) this.writeSessionManifest(path.join(this.sessionsRoot(), d), agentId);
        const dirPath = path.join(this.sessionsRoot(), d);
        const m = this.sessionMtime(dirPath);
        let size = 0;
        try {
          size = statSync(path.join(dirPath, "chat.jsonl")).size;
        } catch {  }
        (size > 0 ? withHistory : empty).push({ d, m });
      }
      const pick = (list: { d: string; m: number }[]) =>
        list.sort((a, b) => b.m - a.m)[0]?.d;
      dirs = [pick(withHistory) ?? pick(empty)].filter((x): x is string => !!x);
    } catch {
      return null;
    }
    return dirs[0] ? path.join(this.sessionsRoot(), dirs[0]) : null;
  }

  private sessionMtime(dir: string): number {
    try {
      return statSync(path.join(dir, "chat.jsonl")).mtimeMs;
    } catch {
      return 0;
    }
  }

  private resolveSessionDir(agentId: string, fresh: boolean): string {
    const root = this.sessionsRoot();
    mkdirSync(root, { recursive: true });

    const recorded = this.config.agents.find((a) => a.id === agentId)?.session;
    if (!fresh && recorded) {
      const dir = path.join(root, recorded);
      const owner = this.readSessionOwner(recorded);
      const mineByManifest = owner === null || owner === agentId;
      const mineByLog = owner !== agentId && this.logOwner(recorded) === agentId;
      if (existsSync(dir) && (mineByManifest || mineByLog)) {
        if (mineByLog) this.writeSessionManifest(dir, agentId); 
        return dir;
      }
      console.log(
        `[teapot] session ${recorded} for ${agentId} is unusable ` +
          `(${existsSync(dir) ? `manifest owner ${JSON.stringify(owner)}` : "directory missing"}); ` +
          `starting a new one`,
      );
    }

    if (!fresh) {
      const existing = this.findLatestSessionDir(agentId);
      if (existing) return existing; 
    }

    const selfDir = path.join(root, agentId);
    const selfOwner = this.readSessionOwner(agentId);
    const selfUsable = selfOwner === null || selfOwner === agentId;
    if (
      !fresh &&
      selfUsable &&
      statSync(path.join(selfDir, "chat.jsonl"), { throwIfNoEntry: false })?.size
    ) {
      return selfDir; 
    }

    let sid = "";
    do {
      sid = `${agentId}-${randomUUID().slice(0, 8)}`;
    } while (existsSync(path.join(root, sid)));
    this.writeSessionManifest(path.join(root, sid), agentId);
    return path.join(root, sid);
  }

  allSessions(): { id: string; agentId: string; mtimeMs: number; sizeBytes: number; title?: string }[] {
    const candidateIds = new Set<string>(this.config.agents.map((a) => a.id).filter(Boolean) as string[]);
    for (const [liveId] of this.agents) candidateIds.add(liveId);
    let names: string[] = [];
    try {
      names = readdirSync(this.sessionsRoot());
    } catch {
      return [];
    }
    const out: { id: string; agentId: string; mtimeMs: number; sizeBytes: number }[] = [];
    for (const d of names) {
      const dirPath = path.join(this.sessionsRoot(), d);
      const { owner, hadManifest } = this.inferSessionOwner(d, candidateIds);
      if (!owner) continue; 
      if (!hadManifest) this.writeSessionManifest(dirPath, owner);
      let m = 0;
      let size = 0;
      try {
        const st = statSync(path.join(dirPath, "chat.jsonl"));
        m = st.mtimeMs;
        size = st.size;
      } catch {  }
      // from the config map — no second per-directory read
      const title = owner ? this.readSessionTitle(d) ?? undefined : undefined;
      out.push({ id: d, agentId: owner, mtimeMs: m, sizeBytes: size, ...(title ? { title } : {}) });
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  sessionsOf(agentId: string): { id: string; mtimeMs: number; sizeBytes: number }[] {
    return this.allSessions()
      .filter((s) => s.agentId === agentId)
      .map(({ id, mtimeMs, sizeBytes }) => ({ id, mtimeMs, sizeBytes }));
  }

  sessionById(sessionId: string): { agentId: string; dir: string } | null {
    if (!sessionId || sessionId.includes("/") || sessionId.includes("\\") || sessionId.startsWith(".")) return null;
    const root = this.sessionsRoot();
    const candidateIds = new Set<string>(this.config.agents.map((a) => a.id).filter(Boolean) as string[]);
    for (const [liveId] of this.agents) candidateIds.add(liveId);
    const { owner } = this.inferSessionOwner(sessionId, candidateIds);
    if (!owner) return null;
    try {
      const st = statSync(path.join(root, sessionId));
      if (!st.isDirectory()) return null;
    } catch {
      return null;
    }
    return { agentId: owner, dir: path.join(root, sessionId) };
  }

  async removeAgent(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`no such agent: ${id}`);
    this.agents.delete(id);
    await agent.dispose();
    this.config.agents = this.config.agents.filter((a) => a.id !== id);
    this.saveConfig();
  }

  async renameSession(agentId: string, sessionId: string, title: string): Promise<{ title: string }> {
    const a = this.config.agents.find((x) => x.id === agentId);
    if (!a) throw new Error(`no such agent: ${agentId}`);
    if (a.session !== sessionId) throw new Error(`agent ${agentId} is not on session ${sessionId}`);
    const clean = title.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!clean) throw new Error("a session title cannot be empty");
    /**
     * The title is keyed by SESSION, not by agent.
     *
     * As `agents[].sessionTitle` it was per AGENT, so `recordSession()` had to delete it whenever the
     * agent moved session — which is what reverted a rename — and a session no agent points at could not
     * keep a name at all. The map fixes both AND keeps the left panel to one config read: storing it in
     * `<session>/session.json` instead was MEASURED at 13.2ms for 838 sessions versus 1.2ms here.
     */
    this.writeSessionTitle(sessionId, clean);
    delete a.sessionTitle;
    // no field to set: the panel derives the name from the map, so the bus nudge is the whole update
    bus.emit("update", { kind: "agent-update", agentId } satisfies BusEvent);
    return { title: clean };
  }

  async archiveAgent(id: string): Promise<{ archived: boolean; ids: string[] }> {
    const root = this.config.agents.find((a) => a.id === id);
    if (!root) throw new Error(`no such agent: ${id}`);
    const ids = [id, ...this.subtreeOf(id).map((s) => s.id)];
    const now = Date.now();
    for (const one of ids) {
      const live = this.agents.get(one);
      if (live) {
        this.agents.delete(one);
        await live.dispose();
      }
      closeTerminalsFor(one);
      const ac = this.config.agents.find((a) => a.id === one);
      if (!ac) continue;
      ac.archived = true;
      ac.archivedAt = now;
    }
    this.saveConfig();
    return { archived: true, ids };
  }

  async restoreAgent(id: string): Promise<{ restored: boolean; live: boolean; ids: string[] }> {
    const ac = this.config.agents.find((a) => a.id === id);
    if (!ac) throw new Error(`no such agent: ${id}`);
    const ids = [id, ...this.subtreeOf(id).map((s) => s.id)];
    for (const one of ids) {
      const e = this.config.agents.find((a) => a.id === one);
      if (!e) continue;
      delete e.archived;
      delete e.archivedAt;
    }
    this.saveConfig();
    try {
      await this.addAgent(ac);
      return { restored: true, live: true, ids };
    } catch (err) {
      console.error(`[teapot] restored "${id}" but could not start it: ${(err as Error).message}`);
      return { restored: true, live: false, ids };
    }
  }

  archivedAgents(): Array<{
    id: string;
    workspace: string;
    archivedAt?: number;
    sessions: number;
    parent?: string;
    subs: number;
  }> {
    const archived = this.config.agents.filter((a) => a.archived);
    const ids = new Set(archived.map((a) => a.id));
    const sessionCounts = new Map<string, number>();
    for (const s of this.allSessions()) sessionCounts.set(s.agentId, (sessionCounts.get(s.agentId) ?? 0) + 1);
    return archived
      .map((a) => ({
        id: a.id,
        workspace: a.workspace,
        ...(a.archivedAt !== undefined ? { archivedAt: a.archivedAt } : {}),
        sessions: sessionCounts.get(a.id) ?? 0,
        ...(a.parent && ids.has(a.parent) ? { parent: a.parent } : {}),
        subs: this.subtreeOf(a.id).filter((s) => ids.has(s.id)).length,
      }))
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  }

  async purgeAgent(id: string): Promise<{ purged: true; dirs: number }> {
    const ac = this.config.agents.find((a) => a.id === id);
    if (!ac) throw new Error(`no such agent: ${id}`);
    const live = this.agents.get(id);
    if (live) {
      this.agents.delete(id);
      await live.dispose();
    }
    const dirs = this.sessionsOf(id);
    this.config.agents = this.config.agents.filter((a) => a.id !== id);
    this.saveConfig();
    let removed = 0;
    for (const d of dirs) {
      try {
        rmSync(path.join(this.sessionsRoot(), d.id), { recursive: true, force: true });
        removed++;
      } catch (err) {
        console.error(`[teapot] could not delete ${d.id}: ${(err as Error).message}`);
      }
    }
    return { purged: true, dirs: removed };
  }

  async setAgentModel(
    id: string,
    providerName?: string,
    model?: string,
    contextWindowTokens?: number,
    reasoningEffort?: string, 
  ): Promise<{ provider: string; model: string; reasoningEffort?: string }> {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`no such agent: ${id}`);
    let llm: LlmConfig;
    let effectiveProvider = providerName ?? "";
    if (providerName) {
      const prov = this.config.providers?.[providerName];
      if (!prov?.baseUrl) throw new Error(`unknown provider: ${providerName}`);
      llm = {
        baseUrl: prov.baseUrl,
        apiKey: prov.apiKey ?? "",
        model: model || prov.model || "",
        timeoutMs: 120_000,
      };
    } else {
      llm = { ...agent.llm };
      if (model) llm.model = model;
      const ac = this.config.agents.find((a) => a.id === id);
      effectiveProvider = ac?.provider ?? this.config.defaultProvider ?? "";
    }
    const effortList = await fetchModelList(llm.baseUrl, llm.apiKey).catch(() => [] as ModelMeta[]);
    const meta = effortList.find((m) => m.id === (model || llm.model));
    const opts = agent as unknown as {
      opts: { reasoningEffort: string; supportedParameters?: string[]; supportedEfforts?: string[] };
    };
    if (reasoningEffort !== undefined) {
      opts.opts.reasoningEffort = isReasoningEffort(reasoningEffort) ? reasoningEffort : "";
      const cfgEntry = this.config.agents.find((a) => a.id === id);
      if (cfgEntry) cfgEntry.reasoningEffort = opts.opts.reasoningEffort || undefined;
    }
    opts.opts.supportedEfforts = meta?.supportedEfforts;
    opts.opts.supportedParameters = meta?.supportedParameters;
    if (!llm.model) throw new Error("no model resolved (pass model or set one on the provider)");
    if (!llm.baseUrl) throw new Error("no baseUrl resolved");
    agent.setLlmConfig(llm);
    (agent as unknown as { opts: { provider: string } }).opts.provider = effectiveProvider;
    const ac = this.config.agents.find((a) => a.id === id);
    if (ac && providerName) ac.provider = providerName;
    if (ac) ac.model = llm.model;
    let win = contextWindowTokens;
    if (win === undefined && ac && !ac.contextWindowTokens && !this.config.contextWindowTokens) {
      try {
        const list = await fetchModelList(llm.baseUrl, llm.apiKey);
        win = contextLengthFor(list, llm.model);
      } catch {
      }
    }
    if (win !== undefined) {
      if (ac) ac.contextWindowTokens = win;
      const opts = agent as unknown as {
        opts: {
          contextWindowTokens: number;
          contextTokenBudget: number;
          manualCompactBudget?: boolean;
        };
      };
      opts.opts.contextWindowTokens = win;
      if (!agent.compactBudgetIsManual)
        opts.opts.contextTokenBudget = Math.round(win * 0.75);
    }
    try {
      const list = await fetchModelList(llm.baseUrl, llm.apiKey);
      await agent.setModelPricing(list.find((m) => m.id === llm.model)?.pricing);
    } catch {  }
    this.saveConfig();
    void agent.log.append("system_note", agent.currentSession, agent.currentBranch, {
      event: "model-changed",
      provider: effectiveProvider,
      model: llm.model,
    });
    return { provider: effectiveProvider, model: llm.model };
  }

  private tick(): void {
    const now = new Date();
    const minuteKey = Math.floor(now.getTime() / 60_000);
    if (bus.listenerCount("update") > 0) bus.emit("update", { kind: "metrics", metrics: this.metrics() });
    for (const t of this.tasks) {
      try {
        if (!matches(t.schedule, now)) continue;
        if (t.lastRunMin === minuteKey) continue; 
        t.lastRunMin = minuteKey;
        t.lastRunAt = Date.now();
        t.task.lastRunMin = minuteKey;
        this.saveConfig();
        const agent = this.agents.get(t.task.agent);
        if (!agent) continue;
        console.log(`[teapot] scheduled task "${t.task.id}" -> agent ${t.task.agent}`);
        bus.emit("update", { kind: "tasks", tasks: this.tasksView() });
        void (async () => {
          if (t.task.forked) await agent.fork();
          await agent.enqueuePrompt(t.task.prompt, `scheduler:${t.task.id}`);
          if (agent.status !== "running") agent.start(`scheduled:${t.task.id}`);
        })();
      } catch (err) {
        console.error(`[teapot] scheduler error (${t.task.id}):`, (err as Error).message);
      }
    }
  }

  tasksView(): {
    id: string;
    agent: string;
    schedule: string;
    forked: boolean;
    prompt: string;
    next: string | null;
    last: string | null;
  }[] {
    return this.tasks.map((t) => ({
      id: t.task.id,
      agent: t.task.agent,
      schedule: t.schedule.raw,
      forked: !!t.task.forked,
      prompt: t.task.prompt,
      next: nextFireAt(t.schedule),
      last: t.lastRunAt ? new Date(t.lastRunAt).toISOString() : null,
    }));
  }

  metrics() {
    const mu = process.memoryUsage();
    const cu = process.cpuUsage();
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      rssMb: +(mu.rss / 1048576).toFixed(1),
      heapUsedMb: +(mu.heapUsed / 1048576).toFixed(1),
      heapTotalMb: +(mu.heapTotal / 1048576).toFixed(1),
      externalMb: +(mu.external / 1048576).toFixed(1),
      cpuMsTotal: Math.round((cu.user + cu.system) / 1000),
      loadavg1: +(os.loadavg()[0]).toFixed(2),
      agents: [...this.agents.values()].map((a) => ({
        id: a.opts_id(),
        turns: a.stats.turns,
        toolCalls: a.stats.toolCalls,
        inputTokens: a.stats.inputTokens,
        outputTokens: a.stats.outputTokens,
      })),
    };
  }

  static readonly VERSION = readAppVersion();

  getVersion(): string {
    return Master.VERSION;
  }

  async stopAllAgents(timeoutMs = 30_000): Promise<void> {
    console.log(`[teapot] stopping all ${this.agents.size} agents...`);
    const ids = [...this.agents.keys()];
    const stopPromises = ids.map(async (id) => {
      const a = this.agents.get(id);
      if (!a) return;
      try {
        await a.dispose();
      } catch (err) {
        console.error("[teapot] dispose error:", err);
      }
      this.agents.delete(id);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error("agent stop timeout")), timeoutMs);
    });
    try {
      await Promise.race([Promise.all(stopPromises), timeout]);
      console.log("[teapot] all agents stopped");
    } finally {
      if (timer) clearTimeout(timer);
      const n = closeAllTerminals();
      if (n) console.log(`[teapot] ⌨ closed ${n} terminal(s)`);
    }
  }

  private updateWindDownMs = 900_000;

  updateInFlight = false;

  async windDownAllAgents(timeoutMs = this.updateWindDownMs): Promise<string[]> {
    const ids = [...this.agents.entries()]
      .filter(([, a]) => a.isLive())
      .map(([id]) => id);
    if (!ids.length) {
      console.log("[teapot] live update: nothing is running — no need to wait for a turn boundary");
      return [];
    }
    console.log(`[teapot] live update: waiting for ${ids.length} agent(s) to reach a turn boundary...`);
    const stuck = await Promise.all(
      ids.map(async (id) => {
        const a = this.agents.get(id);
        if (!a) return null;
        try {
          await a.windDownForUpdate(timeoutMs);
          return null;
        } catch {
          return id;
        }
      }),
    );
    return stuck.filter((v): v is string => v !== null);
  }

  takeResumeSet(): string[] {
    const out: string[] = [];
    for (const [id, a] of this.agents) {
      if (a.isLive()) out.push(id);
    }
    return out;
  }

  async resumeAfterUpdate(): Promise<string[]> {
    const ids = this.config.resumeAfterUpdate ?? [];
    if (!ids.length) return [];
    this.config.resumeAfterUpdate = [];
    this.saveConfig();
    const started: string[] = [];
    for (const id of ids) {
      const a = this.agents.get(id);
      if (!a) continue; 
      try {
        a.start("resumed after a live update");
        started.push(id);
      } catch (err) {
        console.error(`[teapot] could not resume ${id}:`, (err as Error).message);
      }
    }
    const missing = ids.filter((id) => !this.agents.has(id));
    if (missing.length)
      console.log(`[teapot] live update: not resuming removed agent(s): ${missing.join(", ")}`);
    if (started.length) console.log(`[teapot] live update: resumed ${started.length} session(s)`);
    return started;
  }

  async restartServer(): Promise<void> {
    console.log("[teapot] live update: restarting...");
    this.updateInFlight = true;
    try {
      await this.handoverToNewImage();
    } finally {
      this.updateInFlight = false;
    }
  }

  private async handoverToNewImage(): Promise<void> {

    this.config.resumeAfterUpdate = this.takeResumeSet();
    const interrupted = await this.windDownAllAgents(this.updateWindDownMs);
    if (interrupted.length)
      console.log(
        `[teapot] live update: ${interrupted.length} agent(s) did not reach a turn boundary in ` +
          `time and were stopped: ${interrupted.join(", ")}`,
      );
    this.saveConfig();
    console.log(
      `[teapot] live update: ${this.config.resumeAfterUpdate.length} session(s) will resume`,
    );

    const closed = closeAllTerminals();
    if (closed) console.log(`[teapot] ⌻ closed ${closed} terminal(s)`);

    const env: NodeJS.ProcessEnv = { ...process.env, TEAPOT_RESUMED: "1" };
    const execve = (process as unknown as {
      execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<never>;
    }).execve;
    if (!execve) {
      throw new Error(
        "live update needs process.execve (Node 22+); restart the server by hand on this runtime",
      );
    }
    console.log("[teapot] live update: replacing this process in place (same pid, same terminal)");
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc === "function") {
      gc();
      gc();
    }
    const FORWARDABLE =
      /^--(experimental-strip-types|experimental-transform-types|no-warnings|enable-source-maps|import|require|conditions|expose-gc)$/;
    const forwardable = process.execArgv.filter((a) => FORWARDABLE.test(a.split("=")[0] ?? ""));
    await execve(process.execPath, [process.execPath, ...forwardable, ...process.argv.slice(1)], env);
    throw new Error("execve returned without replacing the process");
  }
}
