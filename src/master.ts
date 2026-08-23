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
import type { LlmConfig, ChatFn } from "./agent/llm.ts";
import type { TeapotEvent } from "./log/events.ts";
import { bus, type BusEvent } from "./bus.ts";

/** how deep sub-agent spawning may nest (parent=0, its subs=1, …) */
const MAX_SPAWN_DEPTH = 3;

/** default sub-agent personas — mentionable from the composer (@name) and
 *  usable by agents via spawn_agent({persona}) */
export const SUB_PERSONAS: Record<string, { label: string; directive: string }> = {
  reviewer: {
    label: "🔍 reviewer",
    directive:
      "ROLE: code reviewer. Read-only except notes. Inspect the change set, judge correctness, " +
      "style, tests; report concrete findings as a prioritized list. Do not rewrite the code.",
  },
  tester: {
    label: "🧪 tester",
    directive:
      "ROLE: test engineer. Write and run tests for the task at hand, hunt edge cases, " +
      "report pass/fail with exact commands so results are reproducible.",
  },
  researcher: {
    label: "🔎 researcher",
    directive:
      "ROLE: read-only explorer. Search the codebase/docs, map how things work, and report a " +
      "compact briefing with file:line references. Do not modify anything.",
  },
  implementer: {
    label: "🔨 implementer",
    directive:
      "ROLE: hands-on implementer. Make the change end-to-end (code + tests), keep edits small " +
      "and verified, then report what changed and why.",
  },
};

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
  /** set when this agent was spawned by another agent — survives restarts */
  parent?: string;
  /** test hook: inject a mock LLM function */
  chatFn?: ChatFn;
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
    // spawn-tree depth: computed from the config chain (ac may not be
    // registered yet when this runs — spawnChildFor persists AFTER creation)
    const myDepth = ac.parent ? this.depthOf(ac.parent) + 1 : 0;
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
      spawnDepth: myDepth,
      ...(ac.chatFn ? { chatFn: ac.chatFn } : {}),
    });
    // console line + broadcast: the web UI only refreshes on bus traffic, so
    // every appended event must reach it (otherwise messages sit invisible
    // until an unrelated status change happens to fire)
    agent.log.onEvent = (e) => {
      printAgentEvent(e);
      bus.emit("update", { kind: "event", agentId: e.agent, event: e } satisfies BusEvent);
      this.onChildEvent(ac, e);
    };
    // sub-agent management hooks — only when this agent can legally spawn
    if (myDepth < MAX_SPAWN_DEPTH) {
      const self = agent;
      const hooks = {
        depth: myDepth,
        spawn: (o: { task: string; context: "none" | "fork"; name?: string; persona?: string }) =>
          this.spawnChildFor(self, o),
        list: () =>
          this.childrenOf(ac.id).map((c) => ({
            id: c.id,
            status: c.agent.status,
            goal: c.agent.goal.text,
          })),
        stop: (ids?: string[]) => this.stopChildrenFor(ac.id, ids),
        message: (id: string, text: string) => this.messageChild(ac.id, id, text),
      };
      (
        agent as unknown as {
          toolCtx: { subAgents: typeof hooks };
        }
      ).toolCtx.subAgents = hooks;
    }
    await agent.init();
    this.agents.set(ac.id, agent);
    if (opts.persist) {
      this.config.agents.push(ac);
      this.saveConfig();
    }
    return agent;
  }

  /** spawn-tree depth of an agent (0 = top level); unknown → 0 */
  private depthOf(id: string, seen = new Set<string>()): number {
    let depth = 0;
    let cur = this.config.agents.find((a) => a.id === id);
    while (cur?.parent && !seen.has(cur.id) && depth < MAX_SPAWN_DEPTH + 2) {
      seen.add(cur.id);
      cur = this.config.agents.find((a) => a.id === cur!.parent);
      depth++;
    }
    return depth;
  }

  /** direct children of an agent, with their Agent instances */
  private childrenOf(id: string): { id: string; agent: Agent }[] {
    const kids = this.config.agents.filter((a) => a.parent === id);
    const out: { id: string; agent: Agent }[] = [];
    for (const k of kids) {
      const inst = this.agents.get(k.id);
      if (inst) out.push({ id: k.id, agent: inst });
    }
    return out;
  }

  /**
   * Create a sub-agent on behalf of `parent`. context "fork" writes a
   * sub_fork header into the child log pointing at the parent's current
   * tip — the parent's history is NEVER copied into the child's file; the
   * child resolves it at restore time.
   */
  async spawnChildFor(
    parent: Agent,
    o: { task: string; context: "none" | "fork"; name?: string; persona?: string },
  ): Promise<{ id: string }> {
    const parentId = parent.opts_id();
    const persona = o.persona && SUB_PERSONAS[o.persona] ? o.persona : undefined;
    const base = `${parentId}-sub${persona ? `-${persona}` : ""}${o.name ? `-${o.name.replace(/[^\w.-]/g, "-").slice(0, 24)}` : ""}`.slice(0, 60);
    let id = base;
    let n = 2;
    while (this.agents.has(id) || this.config.agents.some((a) => a.id === id))
      id = `${base.slice(0, 56)}-${n++}`;

    // persona directives shape how the sub approaches the task
    const directive = persona ? `${SUB_PERSONAS[persona].label}\n${SUB_PERSONAS[persona].directive}\n\n` : "";
    const pcfg = this.config.agents.find((a) => a.id === parentId);
    let forkTip: string | null | undefined;
    let forkBranch: string | undefined;
    if (o.context === "fork") {
      // capture the fork tip BEFORE creating the child (parent keeps running)
      forkTip = parent.log.lastEventId(parent.currentBranch);
      forkBranch = parent.currentBranch;
    }
    const child = await this.addAgent(
      {
        id,
        workspace: parent.workspace,
        provider: pcfg?.provider,
        model: pcfg?.model,
        contextWindowTokens: pcfg?.contextWindowTokens,
        parent: parentId,
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
      // the inherited prefix becomes visible history for the child's loop
      child.importMessages(parent.exportMessages());
    }
    await child.setGoal(`${directive}${o.task}`.slice(0, 2000));
    await child.enqueuePrompt(
      (o.context === "fork"
        ? `[harness] You are sub-agent ${id}, spawned by @${parentId} with the conversation above. `
        : `[harness] You are sub-agent ${id}, spawned by @${parentId}. `) +
        `Work solely on this task:\n\n${directive}${o.task}`,
      "harness",
    );
    child.start(`spawned by ${parentId}`);
    console.log(`[teapot] sub-agent ${id} spawned by ${parentId} (context: ${o.context ?? "none"}${persona ? `, persona: ${persona}` : ""})`);
    return { id };
  }

  /** Stop direct children (and their descendants by default) of an agent. */
  async stopChildrenFor(parentId: string, ids?: string[]): Promise<{ stopped: string[] }> {
    const stopped: string[] = [];
    const walk = (pid: string) => {
      for (const { id, agent } of this.childrenOf(pid)) {
        if (ids && !ids.includes(id)) {
          // still descend: stopping a parent implies stopping its subtree
          walk(id);
          continue;
        }
        agent.stop("stopped by parent agent");
        stopped.push(id);
        if (ids) {
          // explicit id → also take its subtree
          const sub = this.childrenOf(id);
          for (const { id: gid, agent: g } of sub) {
            g.stop("stopped with parent");
            stopped.push(gid);
          }
        } else {
          walk(id); // full-subtree default
        }
      }
    };
    walk(parentId);
    return { stopped };
  }

  /** Deliver a parent's message into a child's mailbox (and wake it). */
  private async messageChild(parentId: string, childId: string, text: string): Promise<void> {
    const cfg = this.config.agents.find((a) => a.id === childId);
    if (!cfg || cfg.parent !== parentId) throw new Error(`not your sub-agent: ${childId}`);
    const child = this.agents.get(childId);
    if (!child) throw new Error(`sub-agent not running: ${childId}`);
    child.enqueuePrompt(`[harness] Message from @${parentId}:\n\n${text}`, "harness");
    if (child.status !== "running") child.start(`message from ${parentId}`);
  }

  /**
   * Mirror interesting child events into the parent's timeline (tagged with
   * the acting sub id) and forward terminal outcomes to the parent's mailbox.
   */
  private onChildEvent(ac: { parent?: string; id: string }, e: { type: string; data: unknown; agent: string }): void {
    const parentId = ac.parent;
    if (!parentId) return;
    const parent = this.agents.get(parentId);
    if (!parent) return;

    // forward outcomes so the parent hears the result without polling
    if (e.type === "message" && (e.data as { final?: boolean; content?: string }).final) {
      const summary = String((e.data as { content?: string }).content ?? "").trim();
      parent.enqueuePrompt(
        `[harness] Sub-agent ${ac.id} finished. Final report:\n${summary.slice(0, 2000) || "(no summary)"}`,
        "harness",
      );
    } else if (e.type === "error") {
      parent.enqueuePrompt(
        `[harness] Sub-agent ${ac.id} hit an error: ${String((e.data as { message?: string }).message ?? "").slice(0, 500)}`,
        "harness",
      );
    }

    // mirror feed-worthy activity; nested subs keep their original actor id
    const MIRROR = new Set(["prompt", "message", "tool_call", "tool_result", "progress", "error", "question", "state"]);
    if (!MIRROR.has(e.type)) return;
    const inner = e.type === "sub" ? (e.data as { sub?: string; type?: string; data?: unknown }) : null;
    const actor = inner?.sub ?? ac.id;
    const payload = inner ? { sub: actor, type: inner.type, data: inner.data } : { sub: ac.id, type: e.type, data: e.data };
    void parent.log.append("sub", parent.currentSession, parent.currentBranch, payload);
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
