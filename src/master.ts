/**
 * Master server: owns all agents and one low-frequency scheduler tick.
 * Agents are in-process async loops (I/O bound only); all CPU-heavy work is
 * delegated to subprocesses managed by the bash tool with hard timeouts.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Agent } from "./agent/agent.js";
import { parseSchedule, matches } from "./scheduler/cron.js";
import type { LlmConfig } from "./agent/llm.js";

export interface ProviderConfig {
  /** OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1 */
  baseUrl: string;
  apiKey?: string;
  /** optional default model for this provider */
  model?: string;
}

export interface AgentConfig {
  id: string;
  workspace: string;
  /** which named provider to use (defaults to config.defaultProvider) */
  provider?: string;
  model?: string;
  /** inline overrides win over the provider entry */
  baseUrl?: string;
  apiKey?: string;
}

export interface TaskConfig {
  id: string;
  agent: string;
  schedule: string;
  prompt: string;
  /** run in a forked branch so scheduled chatter never disturbs the main line */
  forked?: boolean;
}

export interface TeapotConfig {
  port: number;
  dataDir: string;
  llm: Partial<LlmConfig>;
  /** named OpenAI-compatible providers */
  providers?: Record<string, ProviderConfig>;
  /** provider used when an agent does not specify one (default "openrouter") */
  defaultProvider?: string;
  agents: AgentConfig[];
  tasks?: TaskConfig[];
  progressIntervalMs?: number;
  /** per-agent estimated-token history budget before compaction kicks in */
  contextTokenBudget?: number;
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

/** Where config is looked up / stored. */
export function configDir(): string {
  return CONFIG_DIR;
}

/**
 * Resolution order:
 *   1. explicit path argument (CLI)
 *   2. $TEAPOT_CONFIG
 *   3. ~/.config/teapot-coding-agent/config.json
 *   4. ./teapot.config.json (legacy project-local)
 */
export function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath) return path.resolve(explicitPath);
  if (process.env.TEAPOT_CONFIG) return path.resolve(process.env.TEAPOT_CONFIG);
  const xdg = path.join(CONFIG_DIR, "config.json");
  if (existsSync(xdg)) return xdg;
  return path.resolve("teapot.config.json");
}

let masterRawConfig: Record<string, unknown> = {};

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
    providers: { ...user.providers },
  };
}

/** Raw parsed user config (for lossless persistence of web edits). */
export function loadedRaw(): Record<string, unknown> {
  return masterRawConfig;
}

export class Master {
  readonly agents = new Map<string, Agent>();
  private tasks: { task: TaskConfig; schedule: ReturnType<typeof parseSchedule>; lastRunMin: number }[] = [];
  private startedAt = Date.now();

  constructor(
    readonly config: TeapotConfig,
    readonly configPath: string,
  ) {}

  /** Persist current logical config back to disk (lossless via raw user config). */
  private saveConfig(): void {
    this.raw.agents = this.config.agents;
    this.raw.providers = this.config.providers;
    this.raw.defaultProvider = this.config.defaultProvider;
    this.raw.tasks = this.config.tasks;
    if (this.raw.progressIntervalMs === undefined && this.config.progressIntervalMs !== undefined)
      this.raw.progressIntervalMs = this.config.progressIntervalMs;
    writeFileSync(this.configPath, JSON.stringify(this.raw, null, 2) + "\n");
  }
  private raw: Record<string, unknown> = loadedRaw();

  /** Apply partial config edits from the web UI and persist them. */
  updateConfig(patch: {
    providers?: Record<string, ProviderConfig>;
    defaultProvider?: string;
    progressIntervalMs?: number;
    tasks?: TaskConfig[];
  }): void {
    if (patch.providers) this.config.providers = patch.providers;
    if (patch.defaultProvider !== undefined) this.config.defaultProvider = patch.defaultProvider;
    if (patch.progressIntervalMs !== undefined) {
      this.config.progressIntervalMs = patch.progressIntervalMs;
      for (const a of this.agents.values())
        (a as unknown as { opts: { progressIntervalMs: number } }).opts.progressIntervalMs =
          patch.progressIntervalMs;
    }
    if (patch.tasks) {
      this.config.tasks = patch.tasks;
      // rebuild schedule table live
      this.tasks = patch.tasks.map((t) => ({
        task: t,
        schedule: parseSchedule(t.schedule),
        lastRunMin: -1,
      }));
    }
    this.saveConfig();
  }

  async start(): Promise<void> {
    mkdirSync(this.config.dataDir, { recursive: true });
    for (const ac of this.config.agents) {
      await this.addAgent(ac);
    }
    for (const t of this.config.tasks ?? []) {
      this.tasks.push({
        task: t,
        schedule: parseSchedule(t.schedule),
        lastRunMin: -1,
      });
    }
    // single low-frequency tick for everything periodic (idle cost ≈ 0)
    setInterval(() => void this.tick(), 15_000).unref();
  }

  /** Create an agent; optionally persist it to the config file. */
  async addAgent(ac: AgentConfig, persist = false): Promise<Agent> {
    if (this.agents.has(ac.id)) throw new Error(`agent id already exists: ${ac.id}`);
    // provider resolution: inline overrides > named provider > legacy llm block
    const provName = ac.provider ?? this.config.defaultProvider ?? "openrouter";
    const prov = this.config.providers?.[provName];
    if (!prov && !ac.baseUrl && !this.config.llm.baseUrl) {
      throw new Error(`agent ${ac.id}: unknown provider "${provName}" and no fallback`);
    }
    const llm: LlmConfig = {
      baseUrl: ac.baseUrl ?? prov?.baseUrl ?? this.config.llm.baseUrl!,
      apiKey: ac.apiKey ?? prov?.apiKey ?? this.config.llm.apiKey!,
      model: ac.model ?? prov?.model ?? this.config.llm.model!,
      timeoutMs: 120_000,
    };
    if (!llm.model) throw new Error(`agent ${ac.id}: no model configured (set model on the agent or on its provider)`);
    const logFile = path.join(this.config.dataDir, `${ac.id}.jsonl`);
    const agent = new Agent({
      id: ac.id,
      workspace: path.resolve(ac.workspace),
      llm,
      logFile,
      progressIntervalMs: this.config.progressIntervalMs,
      autoContinue: true,
      ...(this.config.contextTokenBudget ? { contextTokenBudget: this.config.contextTokenBudget } : {}),
      globalSkillsDir: path.join(CONFIG_DIR, "skills"),
    });
    await agent.init();
    this.agents.set(ac.id, agent);
    if (persist) {
      this.config.agents.push(ac);
      this.saveConfig();
    }
    return agent;
  }

  async removeAgent(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`no such agent: ${id}`);
    this.agents.delete(id);
    await agent.dispose();
    this.config.agents = this.config.agents.filter((a) => a.id !== id);
    this.saveConfig();
  }

  /** 4 ticks/min; each tick is a few integer compares per task. */
  private tick(): void {
    const now = new Date();
    const minuteKey = Math.floor(now.getTime() / 60_000);
    for (const t of this.tasks) {
      try {
        if (!matches(t.schedule, now)) continue;
        if (t.lastRunMin === minuteKey) continue; // dedupe within the same minute
        t.lastRunMin = minuteKey;
        const agent = this.agents.get(t.task.agent);
        if (!agent) continue;
        console.log(`[teapot] scheduled task "${t.task.id}" -> agent ${t.task.agent}`);
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

  metrics() {
    const mu = process.memoryUsage();
    const cu = process.cpuUsage();
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      rssMb: +(mu.rss / 1048576).toFixed(1),
      heapUsedMb: +(mu.heapUsed / 1048576).toFixed(1),
      cpuMsTotal: cu.user + cu.system,
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
}
