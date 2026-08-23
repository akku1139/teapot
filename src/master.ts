/**
 * Master server: owns all agents and one low-frequency scheduler tick.
 * Agents are in-process async loops (I/O bound only); all CPU-heavy work is
 * delegated to subprocesses managed by the bash tool with hard timeouts.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { Agent } from "./agent/agent.ts";
import { parseSchedule, matches, nextFireAt, type Schedule } from "./scheduler/cron.ts";
import type { LlmConfig } from "./agent/llm.ts";
import type { TeapotEvent } from "./log/events.ts";
import { bus, type BusEvent } from "./bus.ts";

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
  /** optional: this model's context window, for the UI usage gauge */
  contextWindowTokens?: number;
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
  /** progress prompts also require this much real model output since the last report */
  progressMinChars?: number;
  /** per-agent estimated-token history budget before compaction kicks in */
  contextTokenBudget?: number;
  /** default model context window for agents that don't set their own */
  contextWindowTokens?: number;
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

/* ---------- console activity log ---------- */

const isTTY = process.stdout.isTTY;
const c = (code: string, s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c("2", s);
const clip1 = (s: unknown, n: number) => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
};
const hhmmss = () => new Date().toTimeString().slice(0, 8);

/** Print one agent event as a compact human-readable console line. */
function printAgentEvent(e: TeapotEvent): void {
  const ts = dim(hhmmss());
  const who = c("36", e.agent); // cyan
  const d = e.data as Record<string, unknown>;
  let line: string | null = null;
  switch (e.type) {
    case "prompt":
      line = `${c("33", "▶ prompt")} (${d.source}) ${clip1(d.text, 110)}`;
      break;
    case "tool_call":
      line = `${c("36", "⚙ exec")} ${d.name} ${dim(clip1(JSON.stringify(d.args ?? {}), 130))}`;
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
      break; // regular assistant messages are visible in the UI
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
      if (d.event === "llm-retry")
        line = `${c("33", "↻ retry")} attempt ${d.attempt} in ${Math.round(Number(d.waitMs) / 1000)}s — ${clip1(d.error, 100)}`;
      else if (d.event === "context-compacted")
        line = `${c("33", "🗜 compact")} tokens ${d.tokensBefore}→${d.tokensAfter} (${d.mode})`;
      else if (d.event === "session-restored")
        line = `${c("33", "⟲ restore")} branch ${d.branch}, ${d.messages} messages`;
      else if (d.event === "model-changed")
        line = `${c("33", "🧦 model")} → ${d.model} (${d.provider})`;
      break;
    }
    default:
      break;
  }
  if (line) console.log(`${dim(ts)} ${who} ${line}`);
}

export class Master {
  readonly agents = new Map<string, Agent>();
  private tasks: {
    task: TaskConfig;
    schedule: Schedule;
    lastRunMin: number;
    lastRunAt?: number;
  }[] = [];
  private startedAt = Date.now();
  readonly config: TeapotConfig;
  readonly configPath: string;

  constructor(
    config: TeapotConfig,
    configPath: string,
  ) {
    this.config = config;
    this.configPath = configPath;
  }

  /** Persist current logical config back to disk (lossless via raw user config). */
  private saveConfig(): void {
    this.raw.agents = this.config.agents;
    this.raw.providers = this.config.providers;
    this.raw.defaultProvider = this.config.defaultProvider;
    this.raw.tasks = this.config.tasks;
    if (this.raw.progressIntervalMs === undefined && this.config.progressIntervalMs !== undefined)
      this.raw.progressIntervalMs = this.config.progressIntervalMs;
    if (this.raw.progressMinChars === undefined && this.config.progressMinChars !== undefined)
      this.raw.progressMinChars = this.config.progressMinChars;
    writeFileSync(this.configPath, JSON.stringify(this.raw, null, 2) + "\n");
  }
  private raw: Record<string, unknown> = loadedRaw();

  /** Apply partial config edits from the web UI and persist them. */
  updateConfig(patch: {
    providers?: Record<string, ProviderConfig>;
    defaultProvider?: string;
    progressIntervalMs?: number;
    progressMinChars?: number;
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
    if (patch.progressMinChars !== undefined) {
      this.config.progressMinChars = patch.progressMinChars;
      for (const a of this.agents.values())
        (a as unknown as { opts: { progressMinChars: number } }).opts.progressMinChars =
          patch.progressMinChars;
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
      try {
        await this.addAgent(ac);
      } catch (err) {
        // one bad entry (duplicate id, unknown provider, …) must not take the
        // whole master down — skip it loudly and keep serving the rest
        console.error(`[teapot] skipping agent "${ac.id}": ${(err as Error).message}`);
      }
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

  /**
   * Create an agent; optionally persist it to the config file.
   * Each incarnation gets its own session directory under
   * <dataDir>/sessions/<agentId>-<uuid>/ (chat.jsonl, goal.md, memory.md).
   * Restarts reuse the latest existing session; fresh creations never touch
   * an older one's history.
   */
  async addAgent(
    ac: AgentConfig,
    opts: { persist?: boolean; fresh?: boolean } = {},
  ): Promise<Agent> {
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
    const sessionDir = this.resolveSessionDir(ac.id, opts.fresh === true);
    await mkdirSync(sessionDir, { recursive: true });
    const agent = new Agent({
      id: ac.id,
      workspace: path.resolve(ac.workspace),
      llm,
      sessionDir,
      progressIntervalMs: this.config.progressIntervalMs,
      ...(this.config.progressMinChars ? { progressMinChars: this.config.progressMinChars } : {}),
      autoContinue: true,
      ...(this.config.contextTokenBudget ? { contextTokenBudget: this.config.contextTokenBudget } : {}),
      ...(ac.contextWindowTokens || this.config.contextWindowTokens
        ? { contextWindowTokens: (ac.contextWindowTokens ?? this.config.contextWindowTokens)! }
        : {}),
      globalSkillsDir: path.join(CONFIG_DIR, "skills"),
      provider: provName,
    });
    // console line + broadcast: the web UI only refreshes on bus traffic, so
    // every appended event must reach it (otherwise messages sit invisible
    // until an unrelated status change happens to fire)
    agent.log.onEvent = (e) => {
      printAgentEvent(e);
      bus.emit("update", { kind: "event", agentId: e.agent, event: e } satisfies BusEvent);
    };
    await agent.init();
    this.agents.set(ac.id, agent);
    if (opts.persist) {
      this.config.agents.push(ac);
      this.saveConfig();
    }
    return agent;
  }

  /** sessions root + helpers */
  private sessionsRoot(): string {
    return path.join(this.config.dataDir, "sessions");
  }

  private findLatestSessionDir(agentId: string): string | null {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(this.sessionsRoot())
        .filter((d) => d === agentId || d.startsWith(`${agentId}-`))
        .sort((a, b) => {
          // newest chat.jsonl wins
          const ma = this.sessionMtime(path.join(this.sessionsRoot(), a));
          const mb = this.sessionMtime(path.join(this.sessionsRoot(), b));
          return mb - ma;
        });
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

    // one-time migration from the ≤0.5.0 flat layout (<dataDir>/<id>.jsonl)
    if (!fresh) {
      const legacy = path.join(this.config.dataDir, `${agentId}.jsonl`);
      if (existsSync(legacy)) {
        const target = path.join(root, agentId);
        if (!existsSync(target)) {
          mkdirSync(target, { recursive: true });
          renameSync(legacy, path.join(target, "chat.jsonl"));
          console.log(`[teapot] migrated session storage: ${agentId}.jsonl → sessions/${agentId}/chat.jsonl`);
        }
      }
    }

    if (!fresh) {
      const existing = this.findLatestSessionDir(agentId);
      if (existing) return existing; // restart → continue where we left off
    }
    // fresh incarnation: guaranteed-unique directory
    let sid = "";
    do {
      sid = `${agentId}-${randomUUID().slice(0, 8)}`;
    } while (existsSync(path.join(root, sid)));
    return path.join(root, sid);
  }

  async removeAgent(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`no such agent: ${id}`);
    this.agents.delete(id);
    await agent.dispose();
    this.config.agents = this.config.agents.filter((a) => a.id !== id);
    this.saveConfig();
  }

  /**
   * Switch a running agent's model/provider mid-session.
   * With provider: use that named provider's baseUrl/key (+ model override).
   * Without: keep the current endpoint, swap only the model name.
   * The choice is persisted on the agent config so it survives restarts.
   */
  setAgentModel(id: string, providerName?: string, model?: string): { provider: string; model: string } {
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
    if (!llm.model) throw new Error("no model resolved (pass model or set one on the provider)");
    if (!llm.baseUrl) throw new Error("no baseUrl resolved");
    agent.setLlmConfig(llm);
    const ac = this.config.agents.find((a) => a.id === id);
    if (ac && providerName) ac.provider = providerName;
    if (ac) ac.model = llm.model;
    this.saveConfig();
    void agent.log.append("system_note", agent.currentSession, agent.currentBranch, {
      event: "model-changed",
      provider: effectiveProvider,
      model: llm.model,
    });
    return { provider: effectiveProvider, model: llm.model };
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
        t.lastRunAt = Date.now();
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

  /** Everything the UI needs to make cron schedules legible. */
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
