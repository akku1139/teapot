/**
 * Master server: owns all agents and one low-frequency scheduler tick.
 * Agents are in-process async loops (I/O bound only); all CPU-heavy work is
 * delegated to subprocesses managed by the bash tool with hard timeouts.
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Agent } from "./agent/agent.js";
import { parseSchedule, matches } from "./scheduler/cron.js";
import type { LlmConfig } from "./agent/llm.js";

export interface AgentConfig {
  id: string;
  workspace: string;
  model?: string;
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
  agents: AgentConfig[];
  tasks?: TaskConfig[];
  progressIntervalMs?: number;
}

const DEFAULT_CONFIG: TeapotConfig = {
  port: Number(process.env.TEAPOT_PORT ?? 7788),
  dataDir: process.env.TEAPOT_DATA_DIR ?? ".teapot",
  llm: {
    baseUrl: process.env.TEAPOT_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: process.env.TEAPOT_API_KEY ?? "",
    model: process.env.TEAPOT_MODEL ?? "",
  },
  agents: [],
  tasks: [],
};

export function loadConfig(configPath: string): TeapotConfig {
  if (!existsSync(configPath)) return DEFAULT_CONFIG;
  const user = JSON.parse(readFileSync(configPath, "utf8")) as Partial<TeapotConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...user,
    llm: { ...DEFAULT_CONFIG.llm, ...user.llm },
  };
}

export class Master {
  readonly agents = new Map<string, Agent>();
  private tasks: { task: TaskConfig; schedule: ReturnType<typeof parseSchedule>; lastRunMin: number }[] = [];
  private startedAt = Date.now();

  constructor(readonly config: TeapotConfig) {}

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

  async addAgent(ac: AgentConfig): Promise<Agent> {
    const llm: LlmConfig = {
      baseUrl: ac.baseUrl ?? this.config.llm.baseUrl!,
      apiKey: ac.apiKey ?? this.config.llm.apiKey!,
      model: ac.model ?? this.config.llm.model!,
      timeoutMs: 120_000,
    };
    const logFile = path.join(this.config.dataDir, `${ac.id}.jsonl`);
    const agent = new Agent({
      id: ac.id,
      workspace: path.resolve(ac.workspace),
      llm,
      logFile,
      progressIntervalMs: this.config.progressIntervalMs,
      autoContinue: true,
    });
    await agent.init();
    this.agents.set(ac.id, agent);
    return agent;
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
