/**
 * Master server: owns all agents and one low-frequency scheduler tick.
 * Agents are in-process async loops (I/O bound only); all CPU-heavy work is
 * delegated to subprocesses managed by the bash tool with hard timeouts.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent/agent.ts";
import { parseSchedule, matches, nextFireAt, type Schedule } from "./scheduler/cron.ts";
import type { LlmConfig, ChatFn } from "./agent/llm.ts";
import type { TeapotEvent } from "./log/events.ts";
import { bus, type BusEvent } from "./bus.ts";
import { fetchModelList, contextLengthFor } from "./model-meta.ts";

/** how deep sub-agent spawning may nest (parent=0, its subs=1, …) */
const MAX_SPAWN_DEPTH = 3;

/**
 * Skills shipped with the package — resolved relative to this module so it
 * works from a global `npm install -g` install, an npx cache, or a repo
 * checkout alike. Lowest-priority skill root (workspace > global > bundled).
 */
const BUNDLED_SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../skills",
);

/** default sub-agent personas — mentionable from the composer (@name) and
 *  usable by agents via spawn_agent({persona}) */
export const SUB_PERSONAS: Record<
  string,
  { label: string; directive: string; readOnly?: boolean }
> = {
  reviewer: {
    label: "🔍 reviewer",
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
    label: "🔎 researcher",
    directive:
      "ROLE: read-only explorer. Search the codebase/docs, map how things work, and report a compact briefing with file:line references.",
    readOnly: true,
  },
  implementer: {
    label: "🔨 implementer",
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
  /** restrict to read-only tools (set automatically for read-only personas) */
  readOnly?: boolean;
  /** keep looping toward an active goal after each round (default true) */
  autoContinue?: boolean;
  /** automatically compact when context exceeds budget (default true) */
  autoCompact?: boolean;
};

export interface TaskConfig {
  id: string;
  agent: string;
  schedule: string;
  prompt: string;
  /** run in a forked branch so scheduled chatter never disturbs the main line */
  forked?: boolean;
  /** runtime dedupe marker, persisted across restarts */
  lastRunMin?: number;
}

export interface TeapotConfig {
  port: number;
  /** listen address — "127.0.0.1" (default), "0.0.0.0" for LAN, … */
  host?: string;
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
  /** how deep agents may nest sub-agent spawning (default 3) */
  maxSpawnDepth?: number;
  /** soft cap on LLM turns per round (0 disables); reaching it is not an error */
  maxTurnsPerRound?: number;
  /** optional shared secret protecting /api/* (env TEAPOT_API_TOKEN wins) */
  password?: string;
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
  host: process.env.TEAPOT_HOST,
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
      else if (d.event === "round-turn-cap")
        line = `${c("33", "⏸ round cap")} ${d.turns} turns — nudging report + wrap-up, next round continues`;
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
  private childWaiters = new Map<string, Set<(note: string) => void>>();
  private startedAt = Date.now();
  readonly config: TeapotConfig;
  readonly configPath: string;
  /** false on first boot with no config file → web UI shows the setup wizard */
  configFileExists = true;

  constructor(
    config: TeapotConfig,
    configPath: string,
  ) {
    this.config = config;
    this.configPath = configPath;
  }

  /** Persist current logical config back to disk (lossless via raw user config). */
  saveConfig(): void {
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
    contextTokenBudget?: number | null;
    maxSpawnDepth?: number;
    maxTurnsPerRound?: number;
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
    // explicit null clears a previously saved budget → back to per-model
    // derivation (75% of each agent's known window); a positive number pins it
    if (patch.contextTokenBudget !== undefined) {
      this.config.contextTokenBudget =
        (patch.contextTokenBudget ?? 0) > 0 ? patch.contextTokenBudget! : undefined;
    }
    if (patch.maxSpawnDepth !== undefined) this.config.maxSpawnDepth = patch.maxSpawnDepth;
    if (patch.maxTurnsPerRound !== undefined) this.config.maxTurnsPerRound = patch.maxTurnsPerRound;
    if (patch.tasks) {
      this.config.tasks = patch.tasks;
      // rebuild schedule table live
      this.tasks = patch.tasks.map((t) => ({
        task: t,
        schedule: parseSchedule(t.schedule),
        lastRunMin: t.lastRunMin ?? -1,
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
      try {
        this.tasks.push({
          task: t,
          schedule: parseSchedule(t.schedule),
          lastRunMin: t.lastRunMin ?? -1,
        });
      } catch (err) {
        // a hand-edited schedule typo must not stop the server from listening
        console.error(`[teapot] skipping task "${t.id}": ${(err as Error).message}`);
      }
    }
    // single low-frequency tick for everything periodic (idle cost ≈ 0)
    setInterval(() => void this.tick(), 15_000).unref();
  }

  /**
   * First-run wizard bootstrap: write a minimal config file, apply it to the
   * running master, and optionally create + start the first agent. Only
   * available while no config file exists — after this, edits go through
   * PUT /api/config behind whatever auth is configured.
   */
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

    // hot-apply to the running master (no restart needed)
    this.config.llm = { ...this.config.llm, ...llm };
    if (body.password) this.config.password = body.password;
    this.configFileExists = true;
    this.raw.llm = llm;
    if (body.password) this.raw.password = body.password;
    // learn the window size up front so compaction derives 75% of it
    try {
      const list = await fetchModelList(llm.baseUrl, body.apiKey);
      const cl = contextLengthFor(list, llm.model);
      if (cl) {
        this.config.contextWindowTokens = cl;
        this.raw.contextWindowTokens = cl;
        raw.contextWindowTokens = cl; // also persist into the fresh config file
        writeFileSync(this.configPath, JSON.stringify(raw, null, 2) + "\n");
      }
    } catch {
      /* metadata is best-effort */
    }

    let agentId: string | undefined;
    if (body.workspace?.trim()) {
      const ws = path.resolve(body.workspace.replace(/^~/, process.env.HOME ?? "~"));
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
    // learn the model's real context window from provider metadata (once per
    // endpoint, cached) unless the config already pins one explicitly
    let inferredWindow: number | undefined;
    if (!ac.contextWindowTokens && !this.config.contextWindowTokens) {
      // don't block the event loop on provider metadata: fire the lookup but
      // keep boot moving. The agent's gauge fills in when it resolves.
      const listPromise = fetchModelList(llm.baseUrl, llm.apiKey);
      inferredWindow = await Promise.race([
        listPromise.then((l) => contextLengthFor(l, llm.model)),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 1_500)),
      ]);
      void listPromise.catch(() => []);
    }
    const sessionDir = this.resolveSessionDir(ac.id, opts.fresh === true);
    await mkdirSync(sessionDir, { recursive: true });
    const agent = new Agent({
      id: ac.id,
      workspace: path.resolve(ac.workspace),
      llm,
      sessionDir,
      progressIntervalMs: this.config.progressIntervalMs,
      ...(this.config.progressMinChars ? { progressMinChars: this.config.progressMinChars } : {}),
      ...(this.config.maxTurnsPerRound !== undefined ? { maxTurnsPerRound: this.config.maxTurnsPerRound } : {}),
      autoContinue: ac.autoContinue ?? true,
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
      provider: provName,
      spawnDepth: myDepth,
      ...(ac.readOnly ? { readOnlyTools: true } : {}),
      ...(ac.parent ? { parent: ac.parent } : {}),
      ...(ac.chatFn ? { chatFn: ac.chatFn } : {}),
    });
    // pricing metadata (USD/token) for the runtime cost estimate — best
    // effort: providers without pricing in /models simply show no cost
    void fetchModelList(llm.baseUrl, llm.apiKey)
      .then((list) => agent.setModelPricing(list.find((m) => m.id === llm.model)?.pricing))
      .catch(() => {});
    // console line + broadcast: the web UI only refreshes on bus traffic, so
    // every appended event must reach it (otherwise messages sit invisible
    // until an unrelated status change happens to fire)
    agent.log.onEvent = (e) => {
      printAgentEvent(e);
      bus.emit("update", { kind: "event", agentId: e.agent, event: e } satisfies BusEvent);
      this.onChildEvent(ac, e);
    };
    // sub-agent management hooks — only when this agent can legally spawn
    if (myDepth < this.maxSpawnDepth()) {
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
        wait: (ids: string[] | undefined, ms: number) =>
          // wire the parent's tool-abort signal: a user stop / dispose must
          // interrupt the park immediately instead of leaving the run chain
          // blocked until the full timeout (up to 1h)
          this.waitChildren(ac.id, ids, ms, self.toolCtx.signal),
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

  /** configured nesting limit (config.maxSpawnDepth, default 3) */
  private maxSpawnDepth(): number {
    const v = this.config.maxSpawnDepth;
    return typeof v === "number" && v >= 0 ? v : MAX_SPAWN_DEPTH;
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
    const persona =
      o.persona && Object.prototype.hasOwnProperty.call(SUB_PERSONAS, o.persona)
        ? o.persona
        : undefined;
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
      // the inherited prefix becomes visible history for the child's loop
      child.importMessages(parent.exportMessages());
    }
    await child.setGoal(`${directive}${o.task}`.slice(0, 2000));
    // SCOPE GUARD: a forked child inherits the parent's whole conversation as
    // reference context — without an explicit boundary, models have been seen
    // "continuing" some EARLIER task that appears in that history instead of
    // the task they were actually spawned for. State the boundary twice
    // (goal + first prompt) so it survives goal-driven auto-continue.
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
  /**
   * Event-driven parking for a parent waiting on sub-agents: resolves as soon
   * as ANY listed child settles (finish/error/stop/waiting) — zero API cost
   * while parked. Falls back to a timeout so waits can never hang forever.
   */
  waitChildren(
    parentId: string,
    ids: string[] | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ note: string }> {
    const targets = (ids && ids.length
      ? ids
      : this.childrenOf(parentId).map((c) => c.id)
    ).filter((id) => this.agents.has(id));
    if (targets.length === 0)
      return Promise.resolve({ note: "no live sub-agents to wait for" });

    const active = () =>
      targets.filter((id) => {
        const s = this.agents.get(id)?.status;
        return s === "running" || s === "waiting";
      });

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
        if (left.length > 0) return; // something is still working — keep parked
        clearTimeout(timer);
        finish(`all sub-agents settled: ${targets.join(", ")}`);
      };

      const set = this.childWaiters.get(parentId) ?? new Set();
      if (!this.childWaiters.has(parentId)) this.childWaiters.set(parentId, set);
      set.add(wake);
      // re-check immediately: children may have settled between snapshot & register
if (active().length === 0) wake();
    });
  }

  /** wake every waiter of a parent (child lifecycle event happened) */
  private wakeParentWaiters(parentId: string): void {
    const set = this.childWaiters.get(parentId);
    if (!set) return;
    for (const fn of set) {
      try { fn("child event"); } catch { /* ignore */ }
    }
  }

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
    // any child lifecycle movement wakes a parked wait_children (the waiter
    // re-checks whether its targets are all settled)
    if (parentId) this.wakeParentWaiters(parentId);
    const parent = this.agents.get(parentId!);
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
        .filter((d) => {
          // an EMPTY chat.jsonl means the session was never used (created via
          // web, then abandoned). Reusing it would resurrect another agent's
          // timeline under this id, and two incarnations could even land in
          // one directory. Never treat empty logs as existing history.
          try {
            return statSync(path.join(this.sessionsRoot(), d, "chat.jsonl")).size > 0;
          } catch {
            return false;
          }
        })
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

    // exact-restart match first: <agentId> itself (or a previously generated
    // <agentId>-<suffix> dir when the bare name was taken). Prefix matching
    // alone could hand agent "proj-2" agent "proj"'s directory.
    const selfDir = path.join(root, agentId);
    if (!fresh && statSync(path.join(selfDir, "chat.jsonl"), { throwIfNoEntry: false })?.size) {
      return selfDir; // restart → continue where we left off
    }

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
  async setAgentModel(
    id: string,
    providerName?: string,
    model?: string,
    contextWindowTokens?: number,
  ): Promise<{ provider: string; model: string }> {
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
    // learn the new model's window (metadata lookup) unless explicitly given
    let win = contextWindowTokens;
    if (win === undefined && ac && !ac.contextWindowTokens && !this.config.contextWindowTokens) {
      try {
        const list = await fetchModelList(llm.baseUrl, llm.apiKey);
        win = contextLengthFor(list, llm.model);
      } catch {
        /* metadata is best-effort */
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
      // re-derive the compaction budget for the NEW window — unless the
      // operator pinned one. Without this, a model switch kept the previous
      // budget and the panel showed "manual override" out of nowhere.
      if (!agent.compactBudgetIsManual)
        opts.opts.contextTokenBudget = Math.round(win * 0.75);
    }
    // re-price for the NEW model (cost estimate follows the model switch)
    try {
      const list = await fetchModelList(llm.baseUrl, llm.apiKey);
      await agent.setModelPricing(list.find((m) => m.id === llm.model)?.pricing);
    } catch { /* pricing stays stale — cosmetic only */ }
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
        // persist so a master restart doesn't re-fire the same minute
        t.task.lastRunMin = minuteKey;
        this.saveConfig();
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
