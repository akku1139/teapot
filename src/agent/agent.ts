/**
 * Agent: an event-driven loop over one workspace.
 *
 * CPU discipline: the agent only consumes CPU while waiting on LLM/tool I/O
 * promises; when idle it holds zero timers and zero polling loops. All
 * periodic behaviour (progress reports, scheduled tasks) is driven by the
 * master's single low-frequency scheduler tick or by turn boundaries.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { EventLog, readEvents, type TeapotEvent } from "../log/events.ts";
import { chat, chatStream, type ChatFn, type ChatMessage, type LlmConfig } from "./llm.ts";
import { executeTool, toolSpecs, currentSkills, type ToolContext } from "./tools.ts";
import type { SkillDef } from "./skills.ts";
import { bus, type BusEvent } from "../bus.ts";

export type AgentStatus = "idle" | "running" | "stopped" | "error" | "waiting";

export interface GoalState {
  text: string;
  status: "active" | "done" | "paused";
  updatedAt: string;
}

export interface ProgressReport {
  doing: string;
  goalStatus: string;
  recent: string;
  problems?: string;
  next?: string;
  ts: string;
}

export interface AgentOptions {
  id: string;
  workspace: string;
  llm: LlmConfig;
  /** per-session storage directory (chat.jsonl / goal.md / memory.md) */
  sessionDir: string;
  /** ms of activity after which the harness asks for a progress report */
  progressIntervalMs?: number;
  /**
   * Progress prompts fire only when BOTH gates pass: the interval above has
   * elapsed AND enough real model output happened since the last report.
   * This stops the harness from burning a turn asking for progress while the
   * provider is stalling (retries produce wall-clock time but no output).
   */
  progressMinChars?: number;
  /** escape hatch: even near-silent tool-grinding rounds get asked eventually */
  progressMaxQuietTurns?: number;
  /** continue automatically toward the goal without human input */
  autoContinue?: boolean;
  /** pause between auto-continue rounds */
  continueDelayMs?: number;
  /** automatically compact when context exceeds budget (default true) */
  autoCompact?: boolean;
  maxConsecutiveToolErrors?: number;
  /** estimated-token budget; older history is compacted when exceeded */
  /** estimated-token budget; older history is compacted when exceeded */
  contextTokenBudget?: number;
  /** the model's real context window — powers the % gauge in the web UI */
  contextWindowTokens?: number;
  /** rebuild conversation from the JSONL log on init (default true) */
  restoreSession?: boolean;
  /** provider name this agent was created with (for the UI's model switcher) */
  provider?: string;
  /** shared skill dir (defaults to none; workspace skills always enabled) */
  globalSkillsDir?: string;
  /** package-shipped skills (lowest priority root; auto-resolved by master) */
  bundledSkillsDir?: string;
  /** depth in the sub-agent spawn tree (0 = top level); enforced by the master */
  spawnDepth?: number;
  /** restrict this agent to read-only tools (sub-agent personas) */
  readOnlyTools?: boolean;
  /** set when spawned by another agent (sub-agent lineage) */
  parent?: string;
  /** injectable LLM call for tests (defaults to the real one) */
  chatFn?: ChatFn;
}

/**
 * SYSTEM_TEMPLATE must stay byte-identical across every request of a session:
 * provider prefix caches key on it, so changing it (or injecting per-turn
 * state) re-prices the whole context. That is why session state lives behind
 * meta tools instead. The cache rationale itself stays HERE in a comment —
 * the model does not need our cost-engineering notes every turn.
 */
const SYSTEM_TEMPLATE = `You are a coding agent working autonomously inside a workspace.

Session state is not injected into prompts — fetch it with tools instead:
- get_goal() → current objective + status. Call at session start, after a
  compaction notice, or whenever you lose the thread.
- set_goal(text) → change the objective itself (not routine updates).
- finish(goalComplete=true, summary) → goal fully achieved.
- ask_user(question, options?) → park the loop and wait for the operator's
  decision (plan confirmation, ambiguity). One concrete question at a time.
- read_memory() / set_memory(content) → your durable notes (memory.md).
- get_todo() / set_todo(content) → the operator-maintained task list
  (todo.md); check it when picking up work, keep it current as you go.
- When corrected, add_feedback(rule) so it sticks; review via get_feedback().
- Log significant choices with record_decision(decision, rationale,
  alternatives?) — compaction forgets reasoning, decisions.md doesn't.
- list_skills() / load_skill(name) / save_skill(...) → reusable playbooks.
- AGENTS.md in the workspace root (optional) holds project knowledge — read it
  with read_file at session start when present, keep it current.

## Rules
- Work step by step with tools. Verify results (run tests/builds) before claiming progress.
- File changes — pick by scope: write_file (one new file / full rewrite) ·
  edit_file (exactly one small unique replacement) · apply_patch (several
  edits, renames or deletes across one or more files, applied atomically).
  read_file numbers lines and can grep via its pattern option. bash
  text-munging (sed/awk/heredoc) remains available for quick bulk transforms
  when that is genuinely faster.
- When a loaded skill matches your task, follow its playbook.
- Turn proven procedures into skills: once something non-trivial worked well,
  save_skill(name, description, content, files=[{name, content}]) so future
  sessions can load_skill them — helper scripts go through files and are made
  executable automatically.
- When you make meaningful progress, call report_progress.
- Be frugal: prefer small precise edits, avoid runaway loops.`;

export class Agent {
  readonly log: EventLog;
  readonly toolCtx: ToolContext;

  status: AgentStatus = "idle";
  statusReason = "";
  mainSession: string;
  currentSession: string;
  currentBranch = "br0";
  goal: GoalState = { text: "", status: "active", updatedAt: new Date().toISOString() };
  latestProgress: ProgressReport | null = null;
  /** operator-maintained task list (todo.md) — humans edit, agent reads */
  todo = "";
  /** set once the conversation has been restored (lazy: on first interaction) */
  private readyPromise: Promise<void> | null = null;
  stats = {
    turns: 0,
    toolCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    compactions: 0,
    startedAt: null as string | null,
  };

  private opts: Required<Omit<AgentOptions, "chatFn">> & { chatFn?: ChatFn };
  private messages: ChatMessage[] = [];
  /**
   * User prompts waiting for the next turn boundary. Deliberately NOT queued
   * on runChain: that chain holds the long-running loop, so queueing behind
   * it would delay both the log entry (UI) and delivery until the round —
   * sometimes the whole goal — finished.
   */
  private pendingPrompts: { source: string; text: string }[] = [];
  private stopRequested = false;
  private wake: (() => void) | null = null;
  /** set while a long-parking tool (wait_children) holds the run chain */
  private parkedByTool = false;
  /** status before parking, restored on unpark */
  private preParkedStatus: { status: AgentStatus; reason: string } | null = null;
  private abort: AbortController | null = null;
  /** aborted only by dispose(): kills in-flight subprocess groups instantly */
  private toolAbort = new AbortController();
  private runChain: Promise<void> = Promise.resolve();
  /** whether contextTokenBudget came from config (manual) or was derived */
  private manualCompactBudget = false;
  private lastProgressAt = Date.now();
  /** the provider's own prompt_tokens from the last completed turn */
  private lastUsage?: { input: number; output: number; cached?: number };
  /** messages.length right after the last successful compaction */
  private compactedAtLen = 0;
  /** set by ask_user: the loop is parked until the operator replies */
  private awaitingUser = false;
  /** real assistant output since the last progress report (chars / turns) */
  private activityChars = 0;
  private turnsSinceProgress = 0;
  private consecutiveToolErrors = 0;

  constructor(opts: AgentOptions) {
    this.opts = {
      progressIntervalMs: 10 * 60_000,
      progressMinChars: 4_000,
      progressMaxQuietTurns: 40,
      autoContinue: true,
      continueDelayMs: 15_000,
      autoCompact: true,
      maxConsecutiveToolErrors: 5,
      contextTokenBudget: 96_000,
      contextWindowTokens: 0,
      restoreSession: true,
      globalSkillsDir: "",
      bundledSkillsDir: "",
      spawnDepth: 0,
      readOnlyTools: false,
      parent: "",
      provider: "",
      ...opts,
    };
    // remember WHERE the budget came from: config = manual, anything else is
    // derived from a known context window (or stays at the default)
    this.manualCompactBudget = opts.contextTokenBudget !== undefined;
    // a declared window implies its own budget: compact at ~75% of the
    // model's real context unless the config set an explicit one (the 96k
    // default only makes sense for unknown-window models)
    if (this.opts.contextWindowTokens && !opts.contextTokenBudget) {
      this.opts.contextTokenBudget = Math.round(this.opts.contextWindowTokens * 0.75);
    }
    this.log = new EventLog(path.join(opts.sessionDir, "chat.jsonl"), opts.id);
    this.skillRoots = [
      { dir: path.join(opts.workspace, "skills"), source: "workspace" },
      ...(opts.globalSkillsDir ? [{ dir: opts.globalSkillsDir, source: "global" }] : []),
      // shipped-with-package skills: lowest priority, always discoverable
      ...(opts.bundledSkillsDir ? [{ dir: opts.bundledSkillsDir, source: "bundled" }] : []),
    ];
    this.toolCtx = {
      cwd: opts.workspace,
      defaultTimeoutMs: 120_000,
      maxOutputBytes: 60_000,
      skillRoots: this.skillRoots,
      signal: this.toolAbort.signal,
      readOnly: this.opts.readOnlyTools,
      onIdlePark: (reason) => this.parkForTool(reason),
      onIdleUnpark: () => this.unparkFromTool(),
    };
    // the session id IS the directory name — one directory per incarnation
    this.mainSession = path.basename(opts.sessionDir);
    this.currentSession = this.mainSession;
  }

  private skillRoots: { dir: string; source: string }[];
  private skillsCache: SkillDef[] = [];

  /** Rescan skill roots (cheap: a readdir per root, done once per turn). */
  private async refreshSkills(): Promise<void> {
    try {
      this.skillsCache = await currentSkills(this.toolCtx);
    } catch {
      /* keep previous cache */
    }
  }

  private callLlm(
    messages: ChatMessage[],
    tools: ReturnType<typeof toolSpecs>,
    onDelta?: (snap: { text: string; reasoning: string }) => void,
  ) {
    const fn = this.opts.chatFn ?? chatStream;
    return fn(this.opts.llm, messages, tools, this.abort?.signal, onDelta);
  }

  /** expose id for metrics */
  opts_id(): string {
    return this.opts.id;
  }

  /** snapshot of the current conversation for fork-by-reference spawning */
  exportMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /** seed a conversation (fork-by-reference sub-agents) — replaces history */
  importMessages(msgs: ChatMessage[]): void {
    this.messages = msgs;
    this.compactedAtLen = 0;
  }

  get workspace(): string {
    return this.opts.workspace;
  }

  /** true when the operator pinned contextTokenBudget in the config */
  get compactBudgetIsManual(): boolean {
    return this.manualCompactBudget;
  }

  /**
   * Long-parking tools (wait_children) flip the visible status to idle so the
   * operator isn't staring at a running spinner for minutes. The run chain is
   * still parked inside the tool — but any prompt/stop wakes it immediately.
   */
  private parkForTool(reason: string): void {
    if (this.parkedByTool || this.status !== "running") return;
    this.parkedByTool = true;
    this.preParkedStatus = { status: this.status, reason: this.statusReason };
    this.status = "idle";
    this.statusReason = `${reason} (idle — send a message to take over; resumes automatically when a sub-agent settles)`;
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
  }

  private unparkFromTool(): void {
    if (!this.parkedByTool) return;
    this.parkedByTool = false;
    const prev = this.preParkedStatus;
    this.preParkedStatus = null;
    if (!this.stopRequested) {
      // restore the pre-park display state (running again)
      this.status = prev?.status ?? "running";
      bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
    }
  }

  /** current LLM settings (read-only view) */
  get llm(): LlmConfig {
    return this.opts.llm;
  }

  /** Swap LLM settings mid-flight; the next turn picks them up. */
  setLlmConfig(llm: LlmConfig): void {
    this.opts.llm = llm;
  }

  async init(): Promise<void> {
    await this.log.load();
    await fs.mkdir(this.workspace, { recursive: true });
    // goal lives next to the session log (dataDir), NOT in the workspace —
    // migrate a legacy workspace GOAL.md once, then never touch the workspace
    await this.migrateGoalFromWorkspace();
    const stored = await this.readGoalStore();
    this.goal = stored ?? { text: "", status: "active", updatedAt: new Date().toISOString() };
    // operator-maintained task list lives beside goal.md
    this.todo = await fs.readFile(this.todoFile, "utf8").catch(() => "");
    await this.refreshSkills();
    // the conversation is NOT restored here: boot cost stays O(agents), not
    // O(history). It is rebuilt lazily by ensureReady() on first interaction.
    if (this.opts.restoreSession) {
      this.status = "stopped";
      this.statusReason = "session not loaded — select it or send a prompt";
      bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
    }
  }

  /**
   * Restore the conversation from the JSONL log exactly once, on demand.
   * Everything that touches history (prompts, start, fork, UI selection)
   * funnels through here; boot stays cheap no matter how many sessions exist.
   */
  private ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        if (this.opts.restoreSession) {
          await this.restoreFromLog();
          if (this.status === "stopped") this.setStatus("idle", "session loaded");
        }
      })();
    }
    return this.readyPromise;
  }

  /** Explicit load (e.g. the user clicked the agent in the UI): stopped → idle. */
  async load(): Promise<void> {
    await this.ensureReady();
  }

  /** harness-managed files inside the session directory */
  private get goalFile(): string {
    return path.join(this.opts.sessionDir, "goal.md");
  }

  private get memoryFile(): string {
    return path.join(this.opts.sessionDir, "memory.md");
  }

  private get todoFile(): string {
    return path.join(this.opts.sessionDir, "todo.md");
  }

  private get feedbackFile(): string {
    return path.join(this.opts.sessionDir, "feedback.md");
  }

  private get decisionsFile(): string {
    return path.join(this.opts.sessionDir, "decisions.md");
  }

  private async readGoalStoreRaw(): Promise<string | null> {
    return fs.readFile(this.goalFile, "utf8").catch(() => null);
  }

  private async readGoalStore(): Promise<GoalState | null> {
    const raw = await this.readGoalStoreRaw();
    return raw === null ? null : this.parseGoalFile(raw);
  }

  /** One-time import of a pre-0.6.0 workspace GOAL.md; content is preserved. */
  private async migrateGoalFromWorkspace(): Promise<void> {
    const legacy = path.join(this.workspace, "GOAL.md");
    let wsText: string;
    try {
      wsText = await fs.readFile(legacy, "utf8");
    } catch {
      return; // nothing to migrate
    }
    const existing = await this.readGoalStoreRaw();
    if (existing === null) await fs.writeFile(this.goalFile, wsText, "utf8");
    await fs.rm(legacy).catch(() => {});
    await this.log.append("system_note", this.currentSession, this.currentBranch, {
      event: "goal-migrated",
      from: "GOAL.md",
      to: this.goalFile,
    });
  }

  /**
   * Rebuild the in-memory conversation from the JSONL event log so a restart
   * continues where the agent left off instead of starting blank.
   *
   * Strategy: find the most recent event overall (its branch is where the
   * agent was), walk the `parent` chain backwards (crossing fork points),
   * then replay events forward into ChatMessages. Meta-tool calls
   * (finish / report_progress) never produced logged tool results, so we
   * synthesize their responses to keep the message sequence valid.
   */
  /**
   * Resolve a leading sub_fork header: load the parent session's file (and
   * recurse if THAT one is itself a sub_fork), take its lineage up to the
   * recorded event, and return it prepended to our own events. Never copies
   * bytes into our log — the prefix lives in the parent's file. Cycle-safe.
   */
  private async spliceSubForkPrefix(
    own: TeapotEvent[],
    baseDir = path.dirname(this.log.filePath),
  ): Promise<TeapotEvent[]> {
    const header = own.find((e) => e.type === "sub_fork");
    if (!header) return own;
    const d = header.data as { parentAgent?: string; parentSession?: string; upToEvent?: string };
    if (!d.parentSession || !d.upToEvent) return own;

    const parentDir = path.join(baseDir, d.parentSession);
    let parentEvents = await readEvents(path.join(parentDir, "chat.jsonl")).catch(
      () => [] as TeapotEvent[],
    );
    // grandchild chains: the parent file may itself open with a sub_fork
    if (parentEvents.some((e) => e.type === "sub_fork")) {
      parentEvents = await this.spliceSubForkPrefix(parentEvents, parentDir);
    }
    if (parentEvents.length === 0) {
      console.warn(`[teapot] sub_fork: parent session ${d.parentSession} unreadable — starting without inherited context`);
      return own;
    }

    // lineage of the parent up to (and including) the recorded fork point
    const byId = new Map(parentEvents.map((e) => [e.id, e]));
    const tip = byId.get(d.upToEvent);
    if (!tip) {
      console.warn(`[teapot] sub_fork: fork point ${d.upToEvent} not found in ${d.parentSession}`);
      return own;
    }
    const prefix: TeapotEvent[] = [];
    for (let cur: TeapotEvent | undefined = tip; cur; cur = cur.parent ? byId.get(cur.parent) : undefined) {
      if (prefix.some((p) => p.id === cur!.id)) break; // cycle guard
      prefix.push(cur);
    }
    prefix.reverse();
    while (prefix.length && prefix[0].type === "fork") prefix.shift();
    return [...prefix, ...own.filter((e) => e !== header)];
  }

  private async restoreFromLog(): Promise<void> {
    const own = await readEvents(this.log.filePath);
    if (own.length === 0) return;
    // a sub_fork header points at the session this agent branched from —
    // splice that prefix in from the parent's file (recursively, cycle-safe)
    // instead of ever copying parent history into our own log
    const events = await this.spliceSubForkPrefix(own);
    const lineage = lineageOf(events);
    if (!lineage.length) return;
    const last = lineage[lineage.length - 1];
    const msgs = rebuildMessagesFrom(lineage);

    if (msgs.length > 0) {
      this.messages = msgs;
      this.currentBranch = last.branch;
      await this.log.append("system_note", this.currentSession, this.currentBranch, {
        event: "session-restored",
        branch: last.branch,
        messages: msgs.length,
      });
    }
  }

  /**
   * Force a compaction pass (manual /compact). Serialized on the run chain so
   * it lands at a safe point relative to a running loop; reports whether
   * anything was actually compacted.
   */
  async compactNow(): Promise<{ ran: boolean }> {
    const ran = await this.enqueue(async () => {
      await this.ensureReady();
      const before = this.stats.compactions;
      await this.maybeCompact(true);
      return this.stats.compactions > before;
    });
    return { ran };
  }

  /**
   * Edit a previously-sent prompt: fork the conversation at that point,
   * replace its text, and optionally fold everything that happened after it
   * into a summary note on the new branch (ChatGPT-edit style). The agent
   * must not be running — editing under a live loop would race its history.
   */
  async editPromptAt(
    eventId: string,
    text: string,
    tail: "discard" | "summarize",
  ): Promise<{ droppedEvents: number; branch: string }> {
    if (this.status === "running")
      throw new Error("agent is running — stop it before editing history");
    const all = await readEvents(this.log.filePath);
    const target = all.find((e) => e.id === eventId);
    if (!target || target.type !== "prompt")
      throw new Error("event not found on this session (or not a prompt)");

    const lineage = lineageOf(all);
    const tIdx = lineage.findIndex((e) => e.id === eventId);
    if (tIdx === -1) throw new Error("prompt is not on this agent's current lineage");

    const kept = lineage.slice(0, tIdx);
    const dropped = lineage.slice(tIdx); // includes the original prompt itself

    const msgs = rebuildMessagesFrom(kept);
    if (tail === "summarize" && dropped.length > 0) {
      try {
        const droppedMsgs = rebuildMessagesFrom(dropped);
        if (droppedMsgs.length) {
          const summary = await this.summarize(droppedMsgs);
          if (summary.trim()) {
            msgs.push({
              role: "user",
              content:
                "[harness] The conversation continued past this point on another timeline. " +
                `Notes from what happened there:\n\n${summary}`,
            });
          }
        }
      } catch {
        // summarization is best-effort; the fork proceeds without notes
      }
    }
    msgs.push({ role: "user", content: text });

    const newBranch = `br${this.branchCount()}${Date.now().toString(36).slice(-4)}`;
    await this.log.append("fork", this.currentSession, newBranch, {
      fromSession: this.currentSession,
      fromBranch: this.currentBranch,
      fromEvent: kept.at(-1)?.id ?? null,
      newBranch,
      reason: "prompt-edited",
      droppedEvents: dropped.length,
      tailMode: tail,
    });
    this.currentBranch = newBranch;
    this.messages = msgs;
    await this.log.append("prompt", this.currentSession, this.currentBranch, { source: "user", text });
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
    return { droppedEvents: dropped.length, branch: newBranch };
  }

  private parseGoalFile(text: string): GoalState {
    // humans and agents may append their own status lines — latest wins
    const all = [...text.matchAll(/status:\s*(\w+)/gi)];
    const last = all[all.length - 1]?.[1];
    const status = last === "done" ? "done" : last === "paused" ? "paused" : "active";
    // keep bookkeeping lines out of the injected goal text
    let body = text.trim();
    for (let i = 0; i < 4; i++) {
      const stripped = body.replace(/\n+(?:status|updated):[^\n]*$/i, "").trimEnd();
      if (stripped === body) break;
      body = stripped;
    }
    return { text: body, status, updatedAt: new Date().toISOString() };
  }

  private async writeGoalFile(): Promise<void> {
    // don't let previously-appended bookkeeping lines accumulate in the body
    let body = this.goal.text.trimEnd();
    for (let i = 0; i < 4; i++) {
      const stripped = body.replace(/\n+(?:status|updated):[^\n]*$/i, "").trimEnd();
      if (stripped === body) break;
      body = stripped;
    }
    await fs.writeFile(
      this.goalFile,
      `${body}\n\nstatus: ${this.goal.status}\nupdated: ${this.goal.updatedAt}\n`,
      "utf8",
    );
  }

  async setGoal(text: string): Promise<void> {
    this.goal = { text, status: "active", updatedAt: new Date().toISOString() };
    await this.writeGoalFile();
    await this.log.append("goal", this.currentSession, this.currentBranch, { event: "set", text });
  }

  /** Persist the operator-maintained task list (todo.md). */
  async setTodo(text: string, by = "human"): Promise<void> {
    this.todo = text;
    await fs.writeFile(this.todoFile, text, "utf8");
    await this.log.append("todo", this.currentSession, this.currentBranch, { event: "set", by });
  }

  async setGoalStatus(status: GoalState["status"]): Promise<void> {
    this.goal = { ...this.goal, status, updatedAt: new Date().toISOString() };
    await this.writeGoalFile();
    await this.log.append("goal", this.currentSession, this.currentBranch, { event: "status", status });
  }

  snapshot() {
    return {
      id: this.opts.id,
      status: this.status,
      statusReason: this.statusReason,
      workspace: this.workspace,
      session: this.currentSession,
      branch: this.currentBranch,
      goal: { status: this.goal.status, text: this.goal.text.slice(0, 400) },
      latestProgress: this.latestProgress,
      stats: { ...this.stats },
      model: this.opts.llm.model,
      provider: this.opts.provider,
      sessionDir: this.opts.sessionDir,
      ctx: {
        usedTokens: this.lastUsage?.input ?? this.estimateTokens(),
        compactAt: this.opts.contextTokenBudget,
        // false when the budget was derived (75% of a known window) instead of
        // being pinned in config — lets the UI say "75% of window" rather than
        // mislabeling every inferred-window model "manual override"
        compactAtIsManual: this.compactBudgetIsManual,
        window: this.opts.contextWindowTokens || 0,
      },
      pendingPrompts: this.pendingPrompts.length,
      todo: this.todo.slice(0, 32_000), // match set_todo's cap — no silent truncation
      parent: this.opts.parent,
      awaiting: this.awaitingUser,
      autoContinue: this.opts.autoContinue,
      autoCompact: this.opts.autoCompact,
    };
  }

  /**
   * Queue a user prompt. Returns immediately: the event is logged right away
   * (so every connected UI sees it instantly) and the text is handed to the
   * model at the next turn boundary — never mid-turn, and never blocked by
   * the running loop. The very first prompt on a fresh boot also triggers the
   * lazy session restore (before the mailbox is filled, so no duplicates).
   */
  enqueuePrompt(text: string, source = "user"): void {
    // a prompt during a tool park (wait_children) takes over instantly
    this.unparkFromTool();
    this.wake?.();
    // a user message means the operator JUST checked in — they obviously know
    // the state, so don't nag with a progress report right after
    if (source === "user") {
      this.lastProgressAt = Date.now();
      this.activityChars = 0;
      this.turnsSinceProgress = 0;
    }
    void this.ensureReady()
      .then(() => {
        this.pendingPrompts.push({ source, text });
        return this.log.append("prompt", this.currentSession, this.currentBranch, { source, text });
      })
      .then(() =>
        bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent),
      )
      .catch(() => {});
  }

  /** Hand queued user prompts to the model at a turn boundary. */
  private drainPendingPrompts(): void {
    for (const p of this.pendingPrompts.splice(0)) {
      this.messages.push({ role: "user", content: p.text });
    }
  }

  /** Resolves when all queued work (including a running loop) has settled. */
  settled(): Promise<void> {
    return this.runChain.catch(() => {});
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.runChain.then(fn);
    this.runChain = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  /** Start (or resume) autonomous operation toward the goal. */
  start(reason = "start"): void {
    if (this.status === "running") return;
    this.stopRequested = false;
    this.awaitingUser = false; // a fresh start answers/resumes past any ask_user
    void this.enqueue(async () => {
      await this.ensureReady(); // lazy restore before the loop touches history
      this.setStatus("running", reason);
      this.stats.startedAt ??= new Date().toISOString();
    });
    void this.enqueue(() => this.loop());
  }

  stop(reason = "stopped by user"): void {
    this.stopRequested = true;
    this.parkedByTool = false; // the park display must not outlive a stop
    // interrupt an in-flight LLM call immediately instead of waiting it out
    this.abort?.abort();
    this.wake?.();
    void this.enqueue(() => {
      this.setStatus("stopped", reason);
      return Promise.resolve();
    });
  }

  private setStatus(s: AgentStatus, reason = ""): void {
    if (this.status !== s) {
      void this.log.append("state", this.currentSession, this.currentBranch, {
        from: this.status,
        to: s,
        reason,
      });
    }
    this.status = s;
    this.statusReason = reason;
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
  }

  /** Main auto-run loop: turn -> tools -> turn ... -> done/idle/stop. */
  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      try {
        const finished = await this.runTurnsUntilIdle();
        if (this.stopRequested) break;
        // fresh user input arrived while we were finishing up — another round now
        if (this.pendingPrompts.length) continue;
        // auto-continue only makes sense with an active goal to continue toward
        if (
          finished ||
          !this.opts.autoContinue ||
          this.goal.status !== "active" ||
          !this.goal.text.trim()
        )
          break;
        // auto-continue: wait quietly, then nudge with a fresh round
        await this.sleepInterruptible(this.opts.continueDelayMs);
        if (this.stopRequested) break;
        const nudge =
          "Continue working toward the current goal. If you are blocked, explain why briefly.";
        await this.log.append("prompt", this.currentSession, this.currentBranch, {
          source: "harness",
          text: nudge,
        });
        this.messages.push({ role: "user", content: nudge });
      } catch (err) {
        const name = (err as Error).name;
        // a stop (user abort or pre-call guard) is control flow, not a failure
        if (this.stopRequested || name === "AbortError" || name === "StopRequested" || name === "WaitForUser") break;
        const msg = (err as Error).message ?? String(err);
        await this.log.append("error", this.currentSession, this.currentBranch, { message: msg });
        this.setStatus("error", msg.slice(0, 300));
        return;
      }
    }
    // waiting on an ask_user answer is a status of its own — not idle (which
    // would let auto-continue nag) and not stopped
    if (!this.stopRequested && !this.awaitingUser) this.setStatus("idle", "round complete");
  }

  /**
   * One LLM call with a fresh abort controller so stop() can interrupt it
   * immediately, plus loop-level retries for provider flakiness (the SDK
   * already backsoff 429/5xx; this covers exhausted rate limits and 400s).
   */
  /**
   * One LLM call with a fresh abort controller so stop() can interrupt it
   * immediately, plus loop-level retries for provider flakiness (the SDK
   * already backsoff 429/5xx; this covers exhausted rate limits and 400s).
   * When onDelta is given, cumulative stream snapshots are forwarded to the
   * UI via the bus (reset to empty at the start of every attempt).
   */
  private async llmCall(
    messages: ChatMessage[],
    tools: ReturnType<typeof toolSpecs>,
    onDelta?: (snap: { text: string; reasoning: string }) => void,
  ) {
    const maxAttempts = 4;
    // fail fast, escalate late: most provider hiccups recover in seconds;
    // only sustained failure earns a long cooldown (operator request)
    const waits = [5_000, 5_000, 30_000];
    for (let attempt = 1; ; attempt++) {
      if (this.stopRequested) throw Object.assign(new Error("stopped"), { name: "StopRequested" });
      this.abort = new AbortController();
      if (onDelta)
        bus.emit("update", {
          kind: "llm-delta",
          agentId: this.opts.id,
          text: "",
          reasoning: "",
        } satisfies BusEvent);
      try {
        return await this.callLlm(messages, tools, onDelta);
      } catch (err) {
        this.abort = null;
        const name = (err as Error).name;
        if (name === "StopRequested" || name === "AbortError" || this.stopRequested) throw err;
        if (attempt >= maxAttempts) throw err;
        const waitMs = waits[Math.min(attempt - 1, waits.length - 1)]!;
        await this.log.append("system_note", this.currentSession, this.currentBranch, {
          event: "llm-retry",
          attempt,
          waitMs,
          error: String((err as Error).message).slice(0, 300),
        });
        await this.sleepInterruptible(waitMs);
      }
    }
  }

  /**
   * One "round": alternate LLM turns and tool executions until the model
   * produces a final answer without tool calls. Returns true if the agent
   * called finish().
   */
  private async runTurnsUntilIdle(): Promise<boolean> {
    let finished = false;
    for (let guard = 0; guard < 200; guard++) {
      if (this.stopRequested) return finished;
      // deliver prompts queued while the previous turn was running
      this.drainPendingPrompts();
      // skills may have been created last turn — refresh the prompt listing
      await this.refreshSkills();
      // periodic progress report at turn boundary (no mid-turn interruption)
      await this.maybeRequestProgress();
      // keep the context window bounded before spending tokens on a turn
      await this.maybeCompact();

      await this.log.append("state", this.currentSession, this.currentBranch, {
        from: this.status,
        to: this.status,
        detail: "llm turn start",
        turn: ++this.stats.turns,
      });
      // stream the assistant reply live to connected clients
      let res;
      try {
        res = await this.llmCall(this.buildMessages(), allToolSpecs(), (s) => {
          bus.emit("update", {
            kind: "llm-delta",
            agentId: this.opts.id,
            text: s.text,
            reasoning: s.reasoning,
          } satisfies BusEvent);
        });
      } catch (err) {
        // user stop mid-stream: persist the partial output so the timeline
        // keeps what was already visible (otherwise it silently vanishes)
        const partial = (err as { partial?: { text?: string; reasoning?: string } }).partial;
        if (this.stopRequested && partial && (partial.text || partial.reasoning)) {
          await this.log.append("message", this.currentSession, this.currentBranch, {
            role: "assistant",
            content: partial.text ?? "",
            reasoning: partial.reasoning,
            interrupted: true,
          });
          this.messages.push({ role: "assistant", content: partial.text ?? "" });
        } else if (this.stopRequested) {
          // nothing had streamed — leave an explicit marker so the log shows
          // why this prompt has no reply
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "turn-interrupted",
            detail: "stopped before any output arrived",
          });
        }
        throw err;
      }
      if (res.usage) {
        this.stats.inputTokens += res.usage.inputTokens ?? 0;
        this.stats.cachedInputTokens += res.usage.cachedInputTokens ?? 0;
        this.stats.outputTokens += res.usage.outputTokens ?? 0;
        this.lastUsage = {
          input: res.usage.inputTokens ?? 0,
          output: res.usage.outputTokens ?? 0,
          cached: res.usage.cachedInputTokens,
        };
        await this.log.append("usage", this.currentSession, this.currentBranch, res.usage);
      }

      const m = res.message;
      await this.log.append("message", this.currentSession, this.currentBranch, {
        role: "assistant",
        content: m.content ?? "",
        toolCalls: m.tool_calls?.map((c) => ({ id: c.id, name: c.function.name })),
        reasoning: res.reasoning,
      });
      this.messages.push(m);
      this.turnsSinceProgress++;
      this.activityChars += m.content?.length ?? 0;

      if (!m.tool_calls?.length) return finished;

      for (const call of m.tool_calls) {
        if (this.stopRequested) return finished;
        if (call.function.name === "finish") {
          await this.handleFinish(call.function.arguments);
          // surface still-running children so the operator knows work may
          // continue after this agent goes idle
          try {
            const running = (this.toolCtx.subAgents?.list?.() ?? []).filter((k) => k.status === "running");
            if (running.length)
              await this.log.append("system_note", this.currentSession, this.currentBranch, {
                event: "subs-still-running",
                detail: running.map((k) => `${k.id} (${k.status})`).join(", "),
              });
          } catch { /* best-effort notice */ }
          // answer the tool_call so a follow-up round stays API-valid
          await this.answerMeta(
            call,
            this.goal.status === "done" ? "(goal complete)" : "(round ended)",
          );
          finished = true;
          continue;
        }
        if (call.function.name === "report_progress") {
          await this.recordProgress(call.function.arguments);
          await this.answerMeta(call, "progress recorded");
          continue;
        }
        if (call.function.name === "set_goal") {
          const a = safeParse(call.function.arguments);
          const text = String(a.text ?? "").trim();
          if (text) await this.setGoal(text);
          await this.answerMeta(call, text ? "goal updated" : "empty goal rejected");
          continue;
        }
        if (call.function.name === "get_goal") {
          await this.answerMeta(
            call,
            JSON.stringify(
              { goal: this.goal.text || "(none set)", status: this.goal.status },
              null,
              1,
            ),
          );
          continue;
        }
        if (call.function.name === "ask_user") {
          const a = safeParse(call.function.arguments);
          const question = String(a.question ?? "").slice(0, 2000);
          const options = Array.isArray(a.options) ? a.options.map(String).slice(0, 6) : [];
          await this.log.append("question", this.currentSession, this.currentBranch, {
            question,
            options,
          });
          await this.answerMeta(
            call,
            "question shown to the operator — the loop is parked until they reply",
          );
          this.awaitingUser = true;
          this.setStatus("waiting", question.slice(0, 80));
          // control flow: park the loop; the operator's next prompt resumes it
          throw Object.assign(new Error("waiting for user"), { name: "WaitForUser" });
        }
        if (call.function.name === "get_todo") {
          await this.answerMeta(
            call,
            this.todo.trim() || "(todo.md is empty — no task list yet)",
          );
          continue;
        }
        if (call.function.name === "set_todo") {
          const a = safeParse(call.function.arguments);
          const content = String(a.content ?? "").slice(0, 32_000);
          await this.setTodo(content, "agent");
          await this.answerMeta(call, "task list updated (visible to the operator)");
          continue;
        }
        if (call.function.name === "get_feedback") {
          const fb = await fs.readFile(this.feedbackFile, "utf8").catch(() => "");
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: fb.trim() || "(no feedback rules recorded yet)",
          });
          continue;
        }
        if (call.function.name === "add_feedback") {
          const a = safeParse(call.function.arguments);
          const rule = String(a.rule ?? "").trim().slice(0, 500);
          if (!rule) {
            this.messages.push({ role: "tool", tool_call_id: call.id, content: "rule required" });
            continue;
          }
          // repeated corrections gain weight: [xN] tag counts occurrences
          const existing = await fs.readFile(this.feedbackFile, "utf8").catch(() => "");
          const lines = existing.split("\n");
          const idx = lines.findIndex((l) => l.includes(rule.slice(0, 60)));
          if (idx !== -1 && /^\s*- /.test(lines[idx]!)) {
            const m = lines[idx].match(/\[x(\d+)\]/);
            const count = m ? Number(m[1]) + 1 : 2;
            lines[idx] = lines[idx].replace(/\[x\d+\]\s*/, "").replace(/- /, `- [x${count}] `);
            await fs.writeFile(this.feedbackFile, lines.join("\n"), "utf8");
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `rule already existed — count raised to ${count}. Repeated violations will be enforced more strictly.`,
            });
          } else {
            const entry = `\n- [x1] ${rule}`;
            await fs.writeFile(this.feedbackFile, existing + (existing ? "\n" : "") + "# Feedback rules\n" + entry, "utf8");
            this.messages.push({ role: "tool", tool_call_id: call.id, content: "feedback rule recorded — follow it from now on" });
          }
          continue;
        }
        if (call.function.name === "record_decision") {
          const a = safeParse(call.function.arguments);
          const decision = String(a.decision ?? "").trim().slice(0, 500);
          const rationale = String(a.rationale ?? "").trim().slice(0, 2000);
          const alternatives = Array.isArray(a.alternatives) ? a.alternatives.map(String).slice(0, 5) : [];
          if (!decision || !rationale) {
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: "decision and rationale are both required — record why, not just what",
            });
            continue;
          }
          await fs.appendFile(
            this.decisionsFile,
            `\n## ${new Date().toISOString()} — ${decision}\n` +
              `- Why: ${rationale}\n` +
              (alternatives.length ? `- Alternatives considered:\n${alternatives.map((x) => `  - ${x}`).join("\n")}\n` : ""),
            "utf8",
          );
          await this.log.append("decision", this.currentSession, this.currentBranch, {
            decision,
            rationale,
            alternatives,
          });
          await this.answerMeta(call, "decision recorded to decisions.md");
          continue;
        }
        if (call.function.name === "get_decisions") {
          const dec = await fs.readFile(this.decisionsFile, "utf8").catch(() => "");
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: dec.trim() || "(decisions.md is empty — no decisions recorded yet)",
          });
          continue;
        }
        if (call.function.name === "read_memory") {
          const mem = await fs.readFile(this.memoryFile, "utf8").catch(() => "");
          await this.answerMeta(call, mem.trim() || "(memory.md is empty — nothing noted yet)");
          continue;
        }
        if (call.function.name === "list_skills") {
          await this.refreshSkills();
          const list = this.skillsCache.length
            ? this.skillsCache.map((s) => `- ${s.name}: ${s.description || "(no description)"}`).join("\n")
            : "(no skills yet — create one with save_skill)";
          await this.answerMeta(call, list);
          continue;
        }
        if (call.function.name === "set_memory") {
          const a = safeParse(call.function.arguments);
          const content = String(a.content ?? "").slice(0, 32_000);
          await fs.writeFile(this.memoryFile, content, "utf8");
          await this.answerMeta(call, "memory saved (injected into future prompts)");
          continue;
        }
        await this.log.append("tool_call", this.currentSession, this.currentBranch, {
          callId: call.id,
          name: call.function.name,
          args: safeParse(call.function.arguments),
          argsRaw: call.function.arguments, // byte-exact for cache-safe restore
        });
        const t0 = Date.now();
        const result = await executeTool(call.function.name, call.function.arguments, this.toolCtx);
        this.stats.toolCalls++;
        await this.log.append("tool_result", this.currentSession, this.currentBranch, {
          callId: call.id,
          name: call.function.name,
          ok: result.ok,
          durationMs: Date.now() - t0,
          result: result.result.slice(0, 8000),
        });
        this.messages.push({ role: "tool", tool_call_id: call.id, content: result.result });
        this.consecutiveToolErrors = result.ok ? 0 : this.consecutiveToolErrors + 1;
        if (this.consecutiveToolErrors >= this.opts.maxConsecutiveToolErrors) {
          throw new Error(
            `runaway detection: ${this.consecutiveToolErrors} consecutive tool failures`,
          );
        }
      }
      if (finished) return true;
    }
    throw new Error("runaway detection: too many turns in one round (>200)");
  }

  private buildMessages(): ChatMessage[] {
    // deliberately static: [system] + append-only history keeps prefix caches hot
    const hasSystem = this.messages[0]?.role === "system";
    const head: ChatMessage[] = [{ role: "system", content: SYSTEM_TEMPLATE }];
    return hasSystem ? [...head, ...this.messages.slice(1)] : [...head, ...this.messages];
  }

  private async handleFinish(argsJson: string): Promise<void> {
    const args = safeParse(argsJson);
    if (args.goalComplete === true) await this.setGoalStatus("done");
    await this.log.append("message", this.currentSession, this.currentBranch, {
      role: "assistant",
      final: true,
      content: String(args.summary ?? ""),
    });
  }

  private async maybeRequestProgress(): Promise<void> {
    const elapsedOk = Date.now() - this.lastProgressAt >= this.opts.progressIntervalMs;
    const activityOk =
      this.activityChars >= this.opts.progressMinChars ||
      this.turnsSinceProgress >= this.opts.progressMaxQuietTurns;
    if (!elapsedOk || !activityOk) return; // stalling provider → don't waste a turn asking
    this.lastProgressAt = Date.now();
    this.activityChars = 0;
    this.turnsSinceProgress = 0;
    const request =
      "[harness] Please give a brief progress report now: what you are doing, goal progress, " +
      "what you recently tried, any problems, and your next step. Keep it under 10 lines.";
    // log both sides so a session restore replays this exchange faithfully
    await this.log.append("prompt", this.currentSession, this.currentBranch, {
      source: "harness",
      text: request,
    });
    this.messages.push({ role: "user", content: request });
    const res = await this.llmCall(this.buildMessages(), []); // no tools: pure report
    await this.recordProgress(JSON.stringify({ freeform: res.message.content }));
    await this.log.append("message", this.currentSession, this.currentBranch, {
      role: "assistant",
      content: res.message.content ?? "",
      reasoning: res.reasoning,
    });
    this.messages.push(res.message);
  }

  /* ---------- context compaction ---------- */

  /**
   * Rough token estimate good enough to trigger compaction before overflow.
   * ASCII runs ≈ 4 chars/token; CJK (kana/kanji/hanja and friends) ≈ 1
   * token/char — the old flat /4 underestimated Japanese sessions ~4x.
   * Adds a small per-message overhead for role/framing tokens.
   */
  private estimateTokens(): number {
    let ascii = 0;
    let wide = 0;
    const count = (s: string) => {
      for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) > 0x2e7f) wide++;
        else ascii++;
      }
    };
    for (const m of this.messages) {
      count(m.content ?? "");
      for (const t of m.tool_calls ?? []) {
        count(t.function.name);
        count(t.function.arguments);
      }
    }
    return Math.ceil(ascii / 4 + wide * 1.2 + this.messages.length * 8);
  }

  /**
   * Latest index whose message may START the kept tail of a compacted
   * history. Anything except a dangling tool result is safe: a kept
   * assistant-with-tool_calls always has its tool responses after it (they
   * are never cut apart — we only remove a prefix).
   */
  private safeCut(maxCut: number): number {
    for (let i = Math.min(maxCut, this.messages.length - 1); i >= 1; i--) {
      if (this.messages[i]!.role !== "tool") return i;
    }
    return -1;
  }

  /**
   * Answer a meta tool call (finish / get_goal / ask_user / …): into the
   * in-memory history AND the log as a regular tool_result, so session
   * restores replay the exact same bytes and provider prefix caches stay
   * warm across restarts.
   */
  private async answerMeta(
    call: { id: string; function: { name: string; arguments?: string } },
    content: string,
  ): Promise<void> {
    const raw = call.function.arguments ?? "{}";
    this.messages.push({ role: "tool", tool_call_id: call.id, content });
    // log the call AND its answer so restores replay byte-exact sequences
    // (meta calls previously went unlogged and restored as bare "{}" args)
    await this.log.append("tool_call", this.currentSession, this.currentBranch, {
      callId: call.id,
      name: call.function.name,
      args: safeParse(raw),
      argsRaw: raw,
    });
    await this.log.append("tool_result", this.currentSession, this.currentBranch, {
      callId: call.id,
      name: call.function.name,
      ok: true,
      durationMs: 0,
      result: content,
    });
  }

  /**
   * Stage 1 of context management (OpenCode-style): before paying for a full
   * summarize, clip OLD oversized tool outputs — they are the usual bulk and
   * their details rarely matter once executed. The most recent window is
   * protected so current work never loses its footing.
   */
  private maybePrune(): number {
    const est = this.lastUsage?.input ?? this.estimateTokens();
    const budget = this.opts.contextTokenBudget;
    if (!budget || est < budget * 0.6) return 0; // prune only when it matters
    // protect the recent tail (~half the budget in chars) from any pruning
    const protectChars = budget * 2;
    let seen = 0;
    let boundary = this.messages.length;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      seen += this.messages[i]!.content?.length ?? 0;
      boundary = i;
      if (seen >= protectChars) break;
    }
    const PRUNE_MIN = 3_000;
    let saved = 0;
    let count = 0;
    for (let i = 0; i < boundary; i++) {
      const m = this.messages[i]!;
      if (m.role === "tool" && (m.content?.length ?? 0) > PRUNE_MIN) {
        const len = m.content!.length;
        saved += len - 400;
        m.content = m.content!.slice(0, 400) + `\n…[pruned ${len} bytes of tool output]`;
        count++;
      }
    }
    if (count > 0)
      void this.log.append("system_note", this.currentSession, this.currentBranch, {
        event: "context-pruned",
        outputs: count,
        savedBytes: saved,
      });
    return count;
  }

  /** Compact history when the real prompt size exceeds the budget. */
  private async maybeCompact(force = false): Promise<void> {
    // prefer the provider's own count from the last response — it is exactly
    // what would overflow the window; the char heuristic is only a fallback
    // for providers that omit usage
    // stage 1: clip oversized old tool outputs before considering a summarize
    this.maybePrune();
    const before = this.lastUsage?.input ?? this.estimateTokens();
    if (!force && before < this.opts.contextTokenBudget) return;
    if (!force && this.opts.autoCompact === false) return;
    // a forced pass on an already-tiny history would just summarize the
    // summary — report ran=false instead
    if (force && this.messages.length <= this.compactedAtLen) return;
    this.lastUsage = undefined; // stale after compaction — re-armed next turn

    // keep roughly the most recent quarter of the budget as live context
    const keepCharBudget = (this.opts.contextTokenBudget / 4) * 4;
    let keepChars = 0;
    let cut = -1;
    for (let i = this.messages.length - 1; i >= 1; i--) {
      keepChars += (this.messages[i]!.content?.length ?? 0) + JSON.stringify(this.messages[i]!.tool_calls ?? "").length;
      if (keepChars > keepCharBudget) break;
      cut = i;
    }
    cut = this.safeCut(cut);
    if (cut <= 0) return; // nothing safely compactable (should not happen)

    const old = this.messages.slice(0, cut);
    const oldCount = old.length;
    let summary = "";
    let mode: "summarize" | "truncate" = "summarize";
    let summarizedCount = oldCount;
    let droppedCount = 0;
    try {
      summary = await this.summarize(old);
      if (summary) await this.harvestLessons(summary); // durable knowledge → memory.md
    } catch (err) {
      await this.log.append("error", this.currentSession, this.currentBranch, {
        message: `compaction summarize failed, falling back to truncation: ${(err as Error).message}`,
      });
    }
    if (!summary) {
      // fallback: drop the oldest half without LLM help so work can continue
      mode = "truncate";
      summarizedCount = 0;
      const halfCut = this.safeCut(Math.floor(oldCount / 2));
      if (halfCut <= 0) return;
      droppedCount = halfCut;
      this.messages = this.messages.slice(halfCut);
    } else {
      this.messages = [
        {
          role: "user",
          content:
            `[harness] Context was compacted: ${oldCount} earlier messages were summarized. ` +
            "Goal and notes are managed by the harness (AGENTS.md / memory.md are injected into your prompt when present).\n\n" +
            `## Summary of earlier conversation\n${summary}`,
        },
        ...this.messages.slice(cut),
      ];
    }
    const after = this.estimateTokens();
    this.stats.compactions++;
    this.compactedAtLen = this.messages.length;
    await this.log.append("system_note", this.currentSession, this.currentBranch, {
      event: "context-compacted",
      tokensBefore: before,
      tokensAfter: after,
      summarized: summarizedCount,
      dropped: droppedCount,
      mode,
    });
  }

  /** Ask the model for dense continuation notes over the compacted range. */
  private async summarize(old: ChatMessage[]): Promise<string> {
    const transcript = old
      .map((m) => {
        const who = m.role === "tool" ? "tool" : m.role;
        const tc = m.tool_calls?.map((t) => `\n[calls ${t.function.name}(${t.function.arguments})]`).join("");
        return `${who}: ${m.content ?? ""}${tc}`;
      })
      .join("\n\n")
      .slice(-120_000);
    const fn = this.opts.chatFn ?? chat;
    const res = await fn(
      this.opts.llm,
      [
        {
          role: "system",
          content:
            "You compress a coding agent's conversation into dense notes for it to continue working. " +
            "Preserve: current goal state, key decisions AND the reasoning behind them, files created/changed, " +
            "important command results, open problems, and the next step. Be terse bullet points, no prose flourishes. " +
            'Finish with a section "## Durable lessons" listing reusable insights worth keeping forever ' +
            "(gotchas, user preferences, what worked) — or omit the section if there are none.",
        },
        { role: "user", content: `Conversation:\n\n${transcript}\n\nWrite the continuation notes now.` },
      ],
      [],
      undefined, // never abortable by stop(): losing the summary would lose history
    );
    return res.message.content ?? "";
  }

  /**
   * Extract the "## Durable lessons" block from a compaction summary and
   * append it to memory.md — knowledge survives compaction automatically
   * (inspired by hook-driven CLAUDE.md growers; zero extra LLM calls).
   */
  private async harvestLessons(summary: string): Promise<void> {
    const m = summary.match(/##\s*Durable lessons?\s*\n([\s\S]*?)(?=\n##\s|$)/i);
    const lessons = m?.[1]?.trim();
    if (!lessons) return;
    const stamped = `\n<!-- lessons harvested from compaction ${new Date().toISOString()} -->\n${lessons}\n`;
    await fs.appendFile(this.memoryFile, stamped, "utf8").catch(() => {});
  }

  private async recordProgress(argsJson: string): Promise<void> {
    const a = safeParse(argsJson);
    this.latestProgress = {
      doing: str(a.doing) || str(a.freeform),
      goalStatus: str(a.goalStatus),
      recent: str(a.recent),
      problems: str(a.problems) || undefined,
      next: str(a.next) || undefined,
      ts: new Date().toISOString(),
    };
    // a report (voluntary or requested) restarts the progress gates
    this.lastProgressAt = Date.now();
    this.activityChars = 0;
    this.turnsSinceProgress = 0;
    await this.log.append("progress", this.currentSession, this.currentBranch, this.latestProgress);
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
  }

  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  async dispose(): Promise<void> {
    this.stop("disposed");
    // kill any in-flight subprocess group NOW so shutdown never waits out a
    // long-running command (up to 10 min otherwise)
    this.toolAbort.abort();
    await this.runChain.catch(() => {});
    await this.log.close();
  }

  /* ---------- fork / branch management (session layer) ---------- */

  /**
   * Fork the conversation: copy the message history into a fresh branch of the
   * SAME log file, recording lineage so reconstruction stays possible.
   */
  async fork(fromEventId?: string | null): Promise<{ session: string; branch: string }> {
    const newBranch = `br${this.branchCount()}${Date.now().toString(36).slice(-4)}`;
    const parentBranch = this.currentBranch;
    await this.log.append("fork", this.currentSession, newBranch, {
      fromSession: this.currentSession,
      fromBranch: parentBranch,
      fromEvent: fromEventId ?? this.log.lastEventId(parentBranch),
      newBranch,
    });
    this.currentBranch = newBranch;
    this.messages = [...this.messages]; // independent history copy
    return { session: this.currentSession, branch: newBranch };
  }

  private branchCount(): number {
    return this.branchCountCache++;
  }
  private branchCountCache = 0;

  switchTo(branch: string): void {
    this.currentBranch = branch;
  }
}

/** workspace tools + agent-meta tools (finish / report_progress / set_goal / set_memory) */
function allToolSpecs(): ReturnType<typeof toolSpecs> {
  return [
    ...toolSpecs(),
    {
      type: "function" as const,
      function: {
        name: "finish",
        description:
          "End the current round. Call with goalComplete=true only when the current goal (shown in your prompt) is fully achieved.",
        parameters: {
          type: "object",
          properties: {
            goalComplete: { type: "boolean" },
            summary: { type: "string" },
          },
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "report_progress",
        description:
          "Report current progress to humans: doing, goalStatus, recent attempts, problems, next step.",
        parameters: {
          type: "object",
          properties: {
            doing: { type: "string" },
            goalStatus: { type: "string" },
            recent: { type: "string" },
            problems: { type: "string" },
            next: { type: "string" },
          },
          required: ["doing", "goalStatus", "recent"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "set_goal",
        description:
          "Replace the harness-managed goal text. Use when the objective itself changes — not for routine updates.",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "ask_user",
        description:
          "Pause and ask the operator a question — plan confirmation, ambiguous requirements, " +
          "a decision only they can make. The loop parks until they reply; their message arrives " +
          "as your next user turn. Use sparingly: do your homework first, then ask once, concretely.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string", description: "what you need decided — include the context and trade-offs" },
            options: {
              type: "array",
              items: { type: "string" },
              description: "optional short answer choices the operator can tap",
            },
          },
          required: ["question"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "get_goal",
        description:
          "Fetch the current goal and its status. Cheap — call at session start, after a compaction notice, or when unsure.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "record_decision",
        description:
          "Log a significant choice you made AND why — alternatives considered, trade-offs. Compaction forgets reasoning; this file doesn't.",
        parameters: {
          type: "object",
          properties: {
            decision: { type: "string", description: "what was decided, in one sentence" },
            rationale: { type: "string", description: "why — the reasoning and trade-offs" },
            alternatives: {
              type: "array",
              items: { type: "string" },
              description: "options considered but rejected",
            },
          },
          required: ["decision", "rationale"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "get_decisions",
        description: "Read previously logged decisions and their rationale (decisions.md).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "get_feedback",
        description:
          "Read the operator's feedback rules (corrections they've given you, with repetition counts). Check after being corrected.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "add_feedback",
        description:
          "Record a correction as a durable rule (or raise an existing rule's count). Call whenever the operator corrects your behavior so the same mistake isn't repeated.",
        parameters: {
          type: "object",
          properties: { rule: { type: "string", description: "the rule in one imperative sentence" } },
          required: ["rule"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "get_todo",
        description:
          "Fetch the operator-maintained task list (todo.md). Check it when picking up work or when unsure what to do next.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "set_todo",
        description:
          "Replace the operator-visible task list (todo.md) — e.g. check off finished items or restate what remains. Keep it terse.",
        parameters: {
          type: "object",
          properties: { content: { type: "string" } },
          required: ["content"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "read_memory",
        description: "Read your durable notes (memory.md).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "set_memory",
        description:
          "Overwrite your durable notes (memory.md). Keep them terse: decisions, gotchas, where you left off.",
        parameters: {
          type: "object",
          properties: { content: { type: "string" } },
          required: ["content"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "list_skills",
        description:
          "List available skills (name + description). Call before load_skill or to avoid duplicating an existing skill.",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
}


function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Walk parent links backwards from the newest event, then flip forward. */
function lineageOf(events: TeapotEvent[]): TeapotEvent[] {
  if (events.length === 0) return [];
  const byId = new Map(events.map((e) => [e.id, e]));
  const last = events[events.length - 1]!;
  const lineage: TeapotEvent[] = [];
  const seen = new Set<string>();
  for (let cur: typeof last | undefined = last; cur; cur = cur.parent ? byId.get(cur.parent) : undefined) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    lineage.push(cur);
  }
  lineage.reverse();
  // the trailing fork event itself is bookkeeping, not conversation
  while (lineage.length && lineage[0].type === "fork") lineage.shift();
  return lineage;
}

/**
 * Replay ordered events into ChatMessages (shared by session restore and
 * prompt-edit forks). Prompts logged inside an open tool batch are buffered
 * until it closes, so user messages never split a tool_call/tool_result pair.
 */
function rebuildMessagesFrom(list: TeapotEvent[]): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  const META_TOOLS = new Set([
    "finish", "report_progress", "set_goal", "get_goal",
    "read_memory", "set_memory", "list_skills", "get_todo", "set_todo",
    "get_feedback", "add_feedback", "record_decision", "get_decisions",
  ]);
  const openCalls = new Map<string, string>(); // real tool_call id -> name
  // meta answers are now logged as regular tool_results; the legacy progress
  // synthesizer below must not duplicate them
  const loggedResults = new Set(
    list.filter((e) => e.type === "tool_result").map((e) => String((e.data as Record<string, unknown>).callId ?? "")),
  );
  const bufferedUsers: string[] = [];
  const flushUsers = () => {
    if (openCalls.size === 0) {
      for (const text of bufferedUsers.splice(0)) msgs.push({ role: "user", content: text });
    }
  };
  for (const e of list) {
    const d = e.data as Record<string, unknown>;
    if (e.type === "prompt" && typeof d.text === "string") {
      if (openCalls.size > 0) bufferedUsers.push(d.text);
      else msgs.push({ role: "user", content: d.text });
    } else if (e.type === "message") {
      // final summaries are operator-facing only — the live loop never puts
      // them in model history, so restores must skip them too
      if (d.final === true) continue;
      const role = d.role === "assistant" ? "assistant" : "user";
      const m: ChatMessage = { role, content: typeof d.content === "string" ? d.content : "" };
      if (Array.isArray(d.toolCalls) && d.toolCalls.length > 0) {
        m.tool_calls = (d.toolCalls as { id: string; name: string }[]).map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: "{}" },
        }));
        // meta tools are answered inline by the harness (no logged result);
        // the hole-filling pass below synthesizes theirs where they belong
        for (const t of m.tool_calls)
          if (!META_TOOLS.has(t.function.name)) openCalls.set(t.id, t.function.name);
      }
      msgs.push(m);
      } else if (e.type === "tool_call") {
        // enrich the preceding assistant tool_calls with real arguments —
        // prefer the provider's raw string so restored requests stay
        // byte-identical (prefix caches stay warm across restarts)
        const prev = [...msgs].reverse().find((x) => x.role === "assistant" && x.tool_calls?.some((t) => t.id === d.callId));
        const tc = prev?.tool_calls?.find((t) => t.id === d.callId);
        if (tc) {
          if (typeof d.argsRaw === "string") tc.function.arguments = d.argsRaw;
          else if (d.args !== undefined) tc.function.arguments = JSON.stringify(d.args ?? {});
        }
      } else if (e.type === "tool_result") {
      msgs.push({
        role: "tool",
        tool_call_id: String(d.callId ?? ""),
        content: `${d.ok === false ? "(failed) " : ""}${typeof d.result === "string" ? d.result : ""}`,
      });
      openCalls.delete(String(d.callId ?? ""));
      flushUsers();
    } else if (e.type === "progress") {
      // progress events may follow an assistant report_progress call that
      // has no logged tool result — patch it in when present
      const lastAssistant = [...msgs].reverse().find((x) => x.role === "assistant" && x.tool_calls?.length);
      if (lastAssistant?.tool_calls?.some((t) => t.function.name === "report_progress")) {
        for (const t of lastAssistant.tool_calls!) {
          if (!loggedResults.has(t.id) && !msgs.some((x) => x.role === "tool" && x.tool_call_id === t.id)) {
            msgs.push({ role: "tool", tool_call_id: t.id, content: "progress recorded" });
          }
          openCalls.delete(t.id);
        }
        flushUsers();
      }
    }
  }

  // every assistant tool_call must be answered by a tool message, or the
  // API rejects the sequence — close any holes left by meta tools (finish)
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const t of m.tool_calls) {
        if (!msgs.slice(i + 1).some((x) => x.role === "tool" && x.tool_call_id === t.id)) {
          msgs.splice(i + 1, 0, {
            role: "tool",
            tool_call_id: t.id,
            content: t.function.name === "finish" ? `(round ended: ${m.content || "finished"})` : "(no result recorded)",
          });
          i++;
        }
      }
    }
  }
  // prompts that were still waiting on a hole-filled tail land here
  for (const text of bufferedUsers.splice(0)) msgs.push({ role: "user", content: text });
  return msgs;
}
