/**
 * Agent: an event-driven loop over one workspace.
 *
 * CPU discipline: the agent only consumes CPU while waiting on LLM/tool I/O
 * promises; when idle it holds zero timers and zero polling loops. All
 * periodic behaviour (progress reports, scheduled tasks) is driven by the
 * master's single low-frequency scheduler tick or by turn boundaries.
 */
import { promises as fs, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { EventLog, readEvents, type TeapotEvent } from "../log/events.ts";
import { chat, chatStream, type ChatFn, type ChatMessage, type LlmConfig } from "./llm.ts";
import { executeTool, toolSpecs, currentSkills, safeJoin, isContextOverflow, hasRunningBgShells, type ToolContext } from "./tools.ts";
import { skillRootsFingerprint, foreignSkillRoots, type SkillDef } from "./skills.ts";
import { bus, type BusEvent } from "../bus.ts";

/**
 * Harness nudges, named and exported so they can be asserted on directly.
 *
 * Both were fixed for a reason invisible in the prose:
 *
 *  - AUTO_CONTINUE_NUDGE (#43) used to say only "continue working". The model
 *    was never told HOW TO STOP, so it worked forever: it replied in prose, the
 *    loop saw an active goal and no finish(), and nudged again. The sub-agent
 *    variant already named finish() — the ROOT one did not.
 *  - PROGRESS_REQUEST (#45) used to DESCRIBE the report instead of asking for
 *    the tool, so the model answered in prose, then — not knowing that had
 *    satisfied the request — sent a voluntary report_progress right after, and
 *    every requested report appeared TWICE on the timeline.
 */
export const AUTO_CONTINUE_NUDGE =
  "Continue working toward the current goal. If you are blocked, explain why briefly. " +
  // name the tool explicitly, the way the sub-agent nudge already does
  "When the goal is genuinely met — or truly blocked — call finish() " +
  "(finish(goalComplete=true) when met, finish(goalComplete=false) when blocked) " +
  "instead of replying in prose; prose here does not stop the loop.";

export const PROGRESS_REQUEST =
  // The leading sentence is kept VERBATIM: it is what existing harness prompts,
  // tests and any operator muscle-memory key off. #45 changed the INSTRUCTION
  // (call the tool, don't answer in prose), not the identification of the request.
  "[harness] Please give a brief progress report now: what you are doing, goal progress, " +
  "what you recently tried, any problems, and your next step. Keep it under 10 lines. " +
  // ask for the TOOL, not prose — a prose answer left the model unsure whether it
  // had satisfied the request, so it sent a voluntary report_progress right after
  // and every requested report appeared TWICE on the timeline (#45)
  "Record it with the report_progress TOOL (doing, goalStatus, recent, problems, next) — " +
  "call that tool; do NOT answer in prose, which would just duplicate this request.";

export type AgentStatus = "idle" | "running" | "stopped" | "error" | "waiting";

export interface GoalState {
  text: string;
  status: "active" | "done" | "paused";
  updatedAt: string;
  /** pi-goal-x-style verification contract: plain-text completion requirements
   * the agent must satisfy (e.g. "npm test passes with zero failures") before
   * finish(goalComplete=true) is honored. Empty/absent = no audit. */
  verify?: string;
  /** outcome of the last completion audit */
  audit?: {
    verdict: "approved" | "changes-required";
    feedback: string;
    at: string;
  };
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
  /** reasoning effort for models that support it (#47) */
  reasoningEffort?: string;
  /** the endpoint catalogue's per-model capabilities; gates the effort field */
  supportedParameters?: string[];
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
  /**
   * Soft cap on LLM turns in ONE round. Reaching it is not an error: the
   * harness nudges the model to report progress and wrap up, then a fresh
   * round begins. 0 disables the cap entirely.
   */
  maxTurnsPerRound?: number;
  /**
   * Safety valve for CONSECUTIVE rounds that neither call a tool nor finish
   * (#106). `maxTurnsPerRound` cannot catch this: a root agent that ends on a
   * bare message leaves its round after ONE turn, so the per-round cap is never
   * reached and auto-continue spins forever. Any tool call resets the counter.
   * 0 disables.
   */
  maxConsecutiveIdleRounds?: number;
  /**
   * Retry policy for round-fatal API errors (rate limits, 5xx, provider
   * hiccups). "stop" (default) ends the loop with status=error. "retry"
   * keeps the goal alive: wait retryDelayMs, then start a fresh round —
   * for long-running unattended agents that should ride out outages.
   */
  onError?: "stop" | "retry";
  /** backoff between error retries (ms); doubles each attempt, capped at 10 min */
  retryDelayMs?: number;
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

Most session state is not injected into prompts — fetch it with tools instead:
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

## Rules
- Project instructions from AGENTS.md (workspace root) are EMBEDDED in this
  prompt below when present — read them here, don't re-read_file it. Keep the
  file current by editing it when it goes stale.
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
- When you make meaningful progress, call report_progress. Its output is
  shown to the operator directly (rendered as markdown in the progress
  panel) — do NOT also repeat the same content as a chat message; end the
  turn right after the call (a short "reported." is fine).
- Be frugal: prefer small precise edits, avoid runaway loops.`;

/**
 * A message whose ENTIRE text is parenthesised is an acknowledgement, not work.
 *
 * #94: the first version of this listed three literals — `(tool call)`,
 * `(no content)`, `(no output)` — and caught 2 of the 10 forms actually reaching
 * a parent. Measured across every session log, the rest are harness
 * acknowledgements written by `answerMeta` and the meta-tool handlers:
 *
 *     (goal complete)  (round ended)  (tool try)  (no sub-agents)
 *     (tool_call)      (nothing running to stop)  (no result recorded)
 *     (todo.md is empty …)  (decisions.md is empty …)
 *
 * So it matches the SHAPE — a whole line wrapped in parentheses — rather than an
 * enumeration that is stale the moment another ack is added.
 *
 * The trade: a genuine message that happens to be entirely parenthesised would
 * also be dropped. That is vanishingly rare in this feed, and the alternative —
 * an enumeration — was measured to be wrong 80% of the time. If it ever matters,
 * the ack should be marked structurally rather than by its punctuation.
 */export const PLACEHOLDER_TEXT = /^\(.*\)$/;

/**
 * Harness acknowledgements — meta-lines about the run itself rather than the
 * work ("decision recorded to decisions.md", "progress recorded", …).
 *
 * #94: these are addressed to the OPERATOR, not to whoever reads the next
 * agent's report, and they consumed slots in a six-deep window that the parent
 * reads as its only account of the work.
 */
export const HARNESS_ACK =
  /^(decision recorded|progress recorded|goal saved|feedback saved|memory saved|todo saved|no skills yet|skills created|read_memory|memory|\(tool call\)|\(no content\)|\(no output\)|true|false|null|none)\b/i;

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
    /** running cost estimate in USD (pricing known only) */
    costUsd: 0 as number | undefined,
  };

  private opts: Required<Omit<AgentOptions, "chatFn">> & { chatFn?: ChatFn };
  private messages: ChatMessage[] = [];
  /**
   * User prompts waiting for the next turn boundary. Deliberately NOT queued
   * on runChain: that chain holds the long-running loop, so queueing behind
   * it would delay both the log entry (UI) and delivery until the round —
   * sometimes the whole goal — finished.
   */
  private pendingPrompts: { source: string; text: string; images?: { url: string; name?: string }[]; id?: string }[] = [];
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
  /** workspace dir absent at boot — session runs "as ghost" until created */
  private workspaceMissing = false;
  private lastProgressAt = Date.now();
  /** the provider's own prompt_tokens from the last completed turn */
  private lastUsage?: { input: number; output: number; cached?: number };
  /** USD per token for the CURRENT model (from provider /models metadata);
      undefined = pricing unknown → cost estimate stays 0 and hidden */
  modelPricing?: { prompt: number; completion: number };
  /** messages.length right after the last successful compaction */
  private compactedAtLen = 0;
  /**
   * A sub-agent's latest bare text turn, held back until the round ends.
   * Models usually end a sub-agent task with a plain message instead of calling
   * finish(); only finish() forwards a report to the parent, so without this the
   * parent got nothing (#42). Held (not sent immediately) so a mid-task
   * narration never pre-empts a real finish() summary.
   */
  private pendingSubReport = "";
  /** live compaction phase for UI progress ("summarizing"/"harvesting") */
  private compactPhase = "";
  /** set by ask_user: the loop is parked until the operator replies */
  private awaitingUser = false;
  /** real assistant output since the last progress report (chars / turns) */
  private activityChars = 0;
  private turnsSinceProgress = 0;
  private consecutiveToolErrors = 0;
  /** consecutive round-fatal API errors (drives the retry backoff) */
  private consecutiveApiErrors = 0;
  /**
   * Consecutive auto-continued rounds that did no work (#106).
   *
   * Reset by any tool call, any finish, a stop, or fresh operator input — only a
   * round that produced neither a tool call nor a finish increments it.
   */
  private consecutiveIdleRounds = 0;

  constructor(opts: AgentOptions) {
    this.opts = {
      progressIntervalMs: 10 * 60_000,
      progressMinChars: 4_000,
      progressMaxQuietTurns: 40,
      autoContinue: true,
      continueDelayMs: 15_000,
      autoCompact: true,
      // #47: no effort and no catalogue entry means "provider default" — the
      // effort field is then never sent, which is the safe default
      reasoningEffort: "",
      supportedParameters: [],
      maxConsecutiveToolErrors: 5,
      maxTurnsPerRound: 200,
      // generous: only a model that never acts and never finishes reaches it
      maxConsecutiveIdleRounds: 50,
      onError: "stop",
      retryDelayMs: 60_000,
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
      // OTHER HARNESSES' skill directories (#28). The SKILL.md format is shared,
      // so these are readable as-is — verified against real third-party skills
      // (terminalskills/skills, trailofbits/skills, …). They sit below the
      // workspace and teapot's own global dir so a project always wins, and
      // missing directories are skipped silently. Paths are the documented
      // native locations plus the cross-tool ones several tools also read.
      ...foreignSkillRoots(opts.workspace),
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
      onBackgroundExit: (info) => void this.onBackgroundJobExit(info),
      onFileRead: (p) => this.trackFileRead(p),
    };
    // the session id IS the directory name — one directory per incarnation
    this.mainSession = path.basename(opts.sessionDir);
    this.currentSession = this.mainSession;
  }

  private skillRoots: { dir: string; source: string }[];
  private skillsCache: SkillDef[] = [];
  /** fingerprint of the roots that produced skillsCache ("" = not scanned yet) */
  private skillsStamp = "";

  /**
   * Rescan skill roots — but only when something actually changed (#14).
   * This used to run a readdir per root plus a read of every SKILL.md at the
   * top of EVERY turn; the cache is only ever read by list_skills, so that
   * was pure I/O on the hot path. A cheap stat fingerprint of the roots and
   * their SKILL.md files gates the real scan, so a turn only pays when a
   * skill was added, edited or removed (save_skill writes one, so a
   * self-created skill still shows up on the very next turn).
   */
  /**
   * Render the skill catalogue for the system prompt (#31).
   *
   * Name + description only, one line each — the full SKILL.md is what
   * load_skill() is for, and this block goes into EVERY request of the session,
   * so it has to stay small. The description is what the model matches its task
   * against, so a skill with a poor description is effectively undiscoverable;
   * that is worth knowing when authoring one.
   */
  private skillCatalogueText(): string {
    if (!this.skillsCache.length) return "";
    const lines = this.skillsCache.map((s) => {
      const desc = (s.description || "(no description)").replace(/\s+/g, " ").slice(0, 200);
      return `- ${s.name}: ${desc}`;
    });
    return lines.join("\n");
  }

  private async refreshSkills(): Promise<void> {
    try {
      const stamp = await skillRootsFingerprint(this.skillRoots);
      if (stamp === this.skillsStamp) return; // unchanged → reuse the cache
      this.skillsCache = await currentSkills(this.toolCtx);
      this.skillsStamp = stamp;
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
    // #47: carry the effort setting + the model's advertised capabilities into
    // the request config. chat() applies effortForRequest(), which sends the
    // field ONLY for OpenRouter endpoints whose catalogue lists support.
    return fn(
      {
        ...this.opts.llm,
        ...(this.opts.reasoningEffort ? { reasoningEffort: this.opts.reasoningEffort } : {}),
        ...(this.opts.supportedParameters
          ? { supportedParameters: this.opts.supportedParameters }
          : {}),
      },
      messages,
      tools,
      this.abort?.signal,
      onDelta,
    );
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

  /**
   * Attach USD-per-token pricing for the CURRENT model (provider /models
   * metadata). Late resolution is normal: the metadata lookup races boot.
   * Recomputes the session cost from the log so a restart with pricing now
   * known still shows the full number instead of starting from zero.
   */
  async setModelPricing(p?: { prompt: number; completion: number }): Promise<void> {
    const wasUndefined = !this.modelPricing;
    this.modelPricing = p;
    if (!p || !wasUndefined) return; // already priced, or nothing to price
    // recompute from the usage events (cheap: file is mtime-cached)
    try {
      const events = await readEvents(this.log.filePath);
      let cost = 0;
      for (const e of events) {
        if (e.type !== "usage") continue;
        const u = e.data as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
        const inTok = u.inputTokens ?? 0;
        const cached = Math.min(u.cachedInputTokens ?? 0, inTok);
        cost += (inTok - cached) * p.prompt + (u.outputTokens ?? 0) * p.completion + cached * p.prompt * 0.1;
      }
      this.stats.costUsd = cost;
    } catch {
      /* no log yet — live accumulation takes over */
    }
  }

  get workspace(): string {
    return this.opts.workspace;
  }

  /** true while the workspace directory does not exist on disk yet */
  get isGhost(): boolean {
    return this.workspaceMissing;
  }

  /** Create the workspace on demand — before any tool touches the fs. */
  private async ensureWorkspace(): Promise<void> {
    if (!this.workspaceMissing) return;
    await fs.mkdir(this.opts.workspace, { recursive: true });
    this.workspaceMissing = false;
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
  }


  /** true when the operator pinned contextTokenBudget in the config */
  get compactBudgetIsManual(): boolean {
    return this.manualCompactBudget;
  }

  /**
   * A context size we are willing to act on.
   *
   * #73: `lastUsage.input` is the provider's own count, so it is normally the
   * most accurate number available — but a provider that under-reports (a proxy
   * that omits the field's real value, a broken gateway, a model served through
   * a shim) makes BOTH safety gates believe the context is nearly empty:
   *
   *     maybePrune()    est < budget * 0.6   -> 0 prunes, forever
   *     maybeCompact()  before < budget       -> 0 compactions, forever
   *
   * Reproduced: ~40k characters of real conversation, provider reporting
   * `prompt_tokens: 10` — zero prunes, zero compactions, and a gauge reading 10,
   * so nothing looks wrong. The context then overflows for real, with the
   * defence that exists to stop exactly that switched off.
   *
   * So the reported number is used, but never as the ONLY number: it is floored
   * against the local estimate. The estimate is a heuristic; the point is that
   * `??` was the wrong way to combine a measurement with a floor — it only falls
   * back when the value is ABSENT, so a confidently wrong value was trusted more
   * than the guess.
   *
   * The floor is a HALF of the local estimate. A quarter was tried first and
   * was too weak to clear the 0.6-of-budget threshold for a realistic session
   * (estimate 5108 → floored 1277 against a 3600 bar), so the guard still would
   * not have fired. Half keeps the intent — catch "reported 10 when the real
   * prompt is large" — without arguing with a provider whose tokenizer
   * legitimately differs from ours, since a provider within 2x of the estimate
   * is not the failure mode being defended against.
   */
  private contextSizeForBudgeting(): number {
    const estimated = this.estimateTokens();
    const reported = this.lastUsage?.input;
    if (reported === undefined) return estimated;
    // a provider reporting nothing at all is a different bug; treat it as unknown
    if (!Number.isFinite(reported) || reported <= 0) return estimated;
    return Math.max(reported, Math.floor(estimated / 2));
  }

  /**
   * Is this agent doing work that `stop()` would actually stop?
   *
   * `status` cannot answer this on its own. Three states count as live:
   *   - `running`: the obvious one;
   *   - a PARKED TOOL: `parkForTool()` flips the visible status to "idle" so a
   *     multi-minute `wait_children` doesn't look like a running spinner, but
   *     the loop is very much alive inside the tool;
   *   - QUEUED PROMPTS: prompts handed to a stopped agent are accepted and held,
   *     and a later `start()` will consume them.
   *
   * Anything keying "should this button stop or start?" off `status` alone
   * therefore offers **start** on a working agent, and the user cannot stop it
   * (#59) — the same trap #38 documented for editing history.
   */
  isLive(): boolean {
    // #127: a MANUAL compaction on an idle agent was rewriting `messages` — a
    // large, non-cancellable operation — while `isLive()` reported false, so the
    // UI offered "start". Measured DURING the summarizer call:
    //
    //   status = idle   live = false   ctx.compacting = "summarizing"
    //
    // `ctx.compacting` was already published, so the information existed and only
    // the live-state calculation ignored it. `start()` during that window would
    // compact the array the agent is about to resume into (#38's failure mode).
    return (
      this.status === "running" ||
      this.parkedByTool ||
      this.pendingPrompts.length > 0 ||
      this.compactPhase !== ""
    );
  }

  /**
   * A background shell (bash background=true) finished. Two channels:
   * 1. a system_note row in the timeline — the operator sees the outcome
   *    without opening anything;
   * 2. a queued harness prompt, delivered at the next turn boundary — the
   *    agent learns exit code + output tail WITHOUT having to poll
   *    bash_output blindly. Failed jobs say so loudly so the model reacts.
   */
  /** recently read workspace files (most recent first) — post-compact restore */
  private recentReads: string[] = [];
  private trackFileRead(p: string): void {
    this.recentReads = [p, ...this.recentReads.filter((x) => x !== p)].slice(0, 5);
  }

  private onBackgroundJobExit(info: { id: string; code: number | null; cmd: string; durationMs: number; outputTail: string }): void {
    const ok = info.code === 0;
    const one = info.cmd.replace(/\s+/g, " ").slice(0, 80);
    void this.log.append("system_note", this.currentSession, this.currentBranch, {
      event: "background-exit",
      jobId: info.id,
      code: info.code,
      durationMs: info.durationMs,
      cmd: one,
      failed: !ok,
    });
    // queue the report for the next turn boundary (agent-visible channel)
    this.onBackgroundJobExitQueued(info);
  }

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
    // NOTE: the workspace is NOT created here. Boot-time mkdir resurrected
    // deleted project directories on every restart, which operators hated.
    // It is created lazily in ensureWorkspace() when the agent first needs
    // to touch the filesystem. Until then a missing workspace marks the
    // session as "ghost" (visible-but-flagged in the UI).
    this.workspaceMissing = !(await fs
      .stat(this.workspace)
      .then(() => true)
      .catch(() => false));
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

  /**
   * Answer tool_calls in a RESTORED history that have no tool_result (#54).
   *
   * The ordinary backstop (`answerUnansweredToolCalls`) works on an assistant
   * turn inside a live loop. After a restart there is no loop: the call is in
   * the log, the process that was running it is gone, and nothing else will ever
   * write its result.
   */
  private async answerUnansweredRestoredCalls(): Promise<void> {
    const seen = new Set<string>();
    for (const ev of await readEvents(this.log.filePath)) {
      const d = (ev.data ?? {}) as { callId?: unknown };
      const id = d.callId ? String(d.callId) : null;
      if (!id) continue;
      if (ev.type === "tool_call") seen.add(id);
      else if (ev.type === "tool_result") seen.delete(id);
    }
    for (const id of seen) {
      await this.log.append("tool_result", this.currentSession, this.currentBranch, {
        callId: id,
        name: "unknown",
        ok: false,
        durationMs: 0,
        result: "not completed — the agent restarted while this tool was running",
        synthesized: true,
      });
    }
    if (seen.size)
      await this.log.append("system_note", this.currentSession, this.currentBranch, {
        event: "unfinished-tools-closed",
        count: seen.size,
        detail: "a restart left these tool calls without a result; they are marked not completed (#54)",
      });
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

    // Rebuild lifetime stats from the log: turns/tools/tokens/compactions are
    // SESSION totals, so a reload must not reset them to zero. Counted over
    // the whole file (not just the current branch) to match what the runtime
    // panel showed before the restart.
    for (const e of own) {
      if (e.type === "state") {
        const d = e.data as { detail?: string };
        if (d.detail === "llm turn start") this.stats.turns++;
      } else if (e.type === "tool_result") {
        this.stats.toolCalls++;
      } else if (e.type === "usage") {
        const u = e.data as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
        this.stats.inputTokens += u.inputTokens ?? 0;
        this.stats.outputTokens += u.outputTokens ?? 0;
        this.stats.cachedInputTokens += u.cachedInputTokens ?? 0;
        if (this.modelPricing) {
          const p = this.modelPricing;
          const inTok = u.inputTokens ?? 0;
          const cached = Math.min(u.cachedInputTokens ?? 0, inTok);
          // same blended-cache model as the live path (cached ≈ 10% of prompt)
          this.stats.costUsd =
            (this.stats.costUsd ?? 0) +
            ((inTok - cached) * p.prompt + (u.outputTokens ?? 0) * p.completion + cached * p.prompt * 0.1);
        }
      } else if (e.type === "system_note") {
        const d = e.data as { event?: string };
        if (d.event === "context-compacted") this.stats.compactions++;
      }
    }
    // newest usage event seeds the context gauge right after reload —
    // inputTokens from the LAST turn is the live context size, and cached
    // must ride along or the "⚡ N% cached" pill disappears after a restart
    for (let i = own.length - 1; i >= 0; i--) {
      if (own[i]!.type === "usage") {
        const u = own[i]!.data as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
        if (typeof u.inputTokens === "number") {
          this.lastUsage = {
            input: u.inputTokens,
            output: u.outputTokens ?? 0,
            ...(u.cachedInputTokens ? { cached: u.cachedInputTokens } : {}),
          };
          break;
        }
      }
    }

    if (msgs.length > 0) {
      this.messages = msgs;
      this.currentBranch = last.branch;
      // #50: re-apply pruning to the restored history. `maybePrune` clips
      // oversized tool output IN PLACE, so a live session keeps its clipped
      // text while the log still holds the full result — a restart therefore
      // handed the provider a strictly LARGER prompt than the one that had just
      // succeeded, which is a size regression that only shows up after a
      // reload. It is a size fix, not a semantic one: the model has already
      // seen and acted on that output, and the pruned form keeps the head plus
      // a marker, exactly as it did live.
      this.maybePrune();

      // #54: answer tool_calls the log says are still open.
      //
      // The restore path rebuilds `msgs` straight from the log, so a call whose
      // process died mid-command comes back as an assistant turn with
      // `tool_calls` and NO matching `tool_result`. Nothing ever answers it —
      // not `stop()` (there is no turn to stop) and not `dispose()` (the process
      // is already gone). The row then renders as still running for good.
      //
      // Measured across every session log: 43,483 tool_calls, and 4 unanswered —
      // every one a `bash`, each followed immediately by
      // `session-restored` / `idle->stopped disposed`. The shape is a restart
      // (or a crash) landing while a long command was in flight, which is
      // precisely when a human is most likely to notice "it never finished".
      //
      // So close them ON RESTORE, before the restored history is used. This is
      // the same backstop as the mid-turn paths, reached from the one place
      // those could not: after the process is gone.
      await this.answerUnansweredRestoredCalls();

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
    // "running" is not the only live state: parkForTool() rewrites the status to
    // "idle" while the loop is still very much alive inside a parked tool
    // (wait_children does this), and queued prompts have not been consumed yet.
    // Editing underneath either of those replaces the very `messages` array the
    // agent is about to resume into, so its old-branch work kept running
    // against the new branch (#38).
    if (this.status === "running" || this.parkedByTool || this.pendingPrompts.length)
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
    // Quiesce BEFORE rewriting history: an in-flight LLM call, a parked tool or
    // a queued prompt would otherwise resume into the NEW messages array and
    // keep running the old branch's work here (#38). Mirrors stop(), which is
    // the only other place that cancels this state.
    await this.quiesceForHistoryEdit();
    // The fork event must be appended while currentBranch is still the OLD
    // one. EventLog links parents PER BRANCH (lastByBranch), so appending it
    // under the new branch gave it parent:null — severing the chain, and
    // lineageOf() then returned only the post-fork events, so a restart rebuilt
    // the history with none of the pre-edit context (#38).
    await this.log.append("fork", this.currentSession, this.currentBranch, {
      fromSession: this.currentSession,
      fromBranch: this.currentBranch,
      fromEvent: kept.at(-1)?.id ?? null,
      newBranch,
      reason: "prompt-edited",
      droppedEvents: dropped.length,
      tailMode: tail,
    });
    // Seed the new branch's parent link so its first event chains across
    // instead of starting a disconnected parent:null history (#38).
    //
    // #69: seed from the CUT POINT, not from this branch's tip. The fork event
    // records where the edit was made (`fromEvent` = the last KEPT event), but
    // `lastEventId(currentBranch)` is the newest event on the branch — which is
    // one of the events this edit just DISCARDED. Seeding from the tip chained
    // the new branch to the discarded tail, so lineageOf() walked straight back
    // through it and a restart resurrected every dropped turn.
    //
    // The cut point is the right parent: it is the last event that survives.
    const cutPoint = kept.at(-1)?.id ?? null;
    this.log.seedBranch(newBranch, cutPoint);
    this.currentBranch = newBranch;
    this.messages = msgs;
    await this.log.append("prompt", this.currentSession, this.currentBranch, { source: "user", text });
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
    return { droppedEvents: dropped.length, branch: newBranch };
  }

  /**
   * Cancel everything that could resume against the history we are about to
   * replace, then wait for the loop to actually stop.
   *
   * An edit rewinds the conversation, so any work still in flight belongs to
   * the branch being discarded: an LLM call whose result would append to the
   * new messages, a parked tool, and queued prompts that were never delivered
   * (#38). stopRequested is set and cleared around the wait so the agent is
   * usable again once the edit lands.
   */
  private async quiesceForHistoryEdit(): Promise<void> {
    if (!this.stopRequested) {
      this.stopRequested = true;
      this.abort?.abort(); // interrupt an in-flight LLM call
      this.toolAbort.abort(); // kill subprocesses / interrupt a parked tool
      this.wake?.(); // release wait_children
      try {
        await this.settled();
      } catch {
        /* the loop is being abandoned; its errors are not ours to report */
      }
      this.parkedByTool = false;
      this.pendingPrompts = []; // undelivered prompts belong to the old branch
      this.stopRequested = false;
      // a fresh signal: toolCtx holds a copy of the reference, so republish
      if (this.toolAbort.signal.aborted) {
        this.toolAbort = new AbortController();
        (this.toolCtx as { signal: AbortSignal }).signal = this.toolAbort.signal;
      }
      this.bgExits = []; // old-branch job exits must not be folded in
    }
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
    // verification contract (pi-goal-x style): a `verify:` block at the tail
    let verify = "";
    const vm = body.match(/\nverify:\s*\n([\s\S]+)$/i) ?? body.match(/^verify:\s*(.+)$/im);
    if (vm) {
      verify = vm[1]!.trim();
      body = (body.slice(0, vm.index).trimEnd());
    }
    const out: GoalState = { text: body, status, updatedAt: new Date().toISOString() };
    if (verify) out.verify = verify;
    return out;
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
      `${body}\n\nstatus: ${this.goal.status}\nupdated: ${this.goal.updatedAt}\n` +
        (this.goal.verify ? `verify:\n${this.goal.verify}\n` : ""),
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

  /**
   * Update SPECIFIC checkbox items without rewriting the whole list — the
   * full-replacement path made agents lazy (a mid-task progress tick meant
   * re-emitting the entire markdown, so they skipped updates) and risky (one
   * sloppy regeneration mangled unrelated sections). Items are matched by
   * normalized text; unknown items are reported back instead of silently
   * dropped. Returns a short human-readable summary for the tool result.
   */
  async updateTodoItems(
    updates: { item: string; done: boolean }[],
    by = "agent",
  ): Promise<string> {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const lines = this.todo.split("\n");
    let matched = 0;
    const unmatched: string[] = [];
    for (const u of updates) {
      const target = norm(u.item);
      // find the LAST matching checkbox line (later duplicates win)
      let idx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i]!.match(/^(\s*[-*+] \[)([ xX])(\].*)$/);
        if (!m) continue;
        if (norm(m[3]!.slice(1)) === target) {
          idx = i;
          break;
        }
      }
      if (idx === -1) {
        unmatched.push(u.item);
        continue;
      }
      lines[idx] = lines[idx]!.replace(/^(.* \[)[ xX](\].*)$/, (_s, a, b) => `${a}${u.done ? "x" : " "}${b}`);
      matched++;
    }
    if (matched > 0) {
      this.todo = lines.join("\n");
      await fs.writeFile(this.todoFile, this.todo, "utf8");
      await this.log.append("todo", this.currentSession, this.currentBranch, {
        event: "items",
        by,
        matched,
        ...(unmatched.length ? { unknown: unmatched } : {}),
      });
    }
    const parts = [`${matched} item(s) updated`];
    if (unmatched.length)
      parts.push(
        `NOT FOUND in todo.md: ${unmatched.map((s) => `"${s}"`).join(", ")} — check get_todo and retry with the exact wording`,
      );
    return parts.join(". ");
  }

  async setGoalStatus(status: GoalState["status"]): Promise<void> {
    this.goal = { ...this.goal, status, updatedAt: new Date().toISOString() };
    await this.writeGoalFile();
    await this.log.append("goal", this.currentSession, this.currentBranch, { event: "status", status });
  }

  /** Set the goal's verification contract (completion requirements). */
  async setGoalVerify(verify: string): Promise<void> {
    this.goal = { ...this.goal, verify: verify.slice(0, 4000), updatedAt: new Date().toISOString() };
    await this.writeGoalFile();
    await this.log.append("goal", this.currentSession, this.currentBranch, {
      event: "verify-set",
      verify: verify.slice(0, 2000),
    });
  }

  /** Record a verification-contract audit outcome (pi-goal-x style review). */
  async setGoalAudit(verdict: "approved" | "changes-required", feedback: string): Promise<void> {
    this.goal = {
      ...this.goal,
      updatedAt: new Date().toISOString(),
      audit: { verdict, feedback: feedback.slice(0, 4000), at: new Date().toISOString() },
    };
    if (verdict === "approved") this.goal.status = "done";
    else if (this.goal.status === "done") this.goal.status = "active"; // reopened
    await this.writeGoalFile();
    await this.log.append("goal", this.currentSession, this.currentBranch, {
      event: "audit",
      verdict,
      feedback: feedback.slice(0, 2000),
    });
  }

  snapshot() {
    return {
      id: this.opts.id,
      status: this.status,
      statusReason: this.statusReason,
      /**
       * Is there work in flight that `stop` would actually stop?
       *
       * `status` alone is not enough to answer that, and the UI needs it: a
       * parked tool (`wait_children`) rewrites the status to "idle" while the
       * loop is very much alive, so a client keying "stop vs start" off
       * `status === "running"` offered **start** on a running agent and the
       * user could not stop it (#59). This is the same "running is not the
       * only live state" fact #38 had to be taught about editing.
       */
      live: this.isLive(),
      workspace: this.workspace,
      workspaceMissing: this.workspaceMissing,
      session: this.currentSession,
      branch: this.currentBranch,
      goal: {
        status: this.goal.status,
        text: this.goal.text.slice(0, 400),
        ...(this.goal.verify ? { verify: this.goal.verify.slice(0, 1000) } : {}),
        ...(this.goal.audit ? { audit: this.goal.audit } : {}),
      },
      latestProgress: this.latestProgress,
      stats: { ...this.stats, costUsd: this.modelPricing ? this.stats.costUsd : undefined },
      model: this.opts.llm.model,
      provider: this.opts.provider,
      // #47: the effort in force, and whether this model can take one at all
      ...(this.opts.reasoningEffort ? { reasoningEffort: this.opts.reasoningEffort } : {}),
      effortSupported: (this.opts.supportedParameters ?? []).includes("reasoning_effort"),
      sessionDir: this.opts.sessionDir,
      ctx: {
        usedTokens: this.lastUsage?.input ?? this.estimateTokens(),
        compactAt: this.opts.contextTokenBudget,
        // false when the budget was derived (75% of a known window) instead of
        // being pinned in config — lets the UI say "75% of window" rather than
        // mislabeling every inferred-window model "manual override"
        compactAtIsManual: this.compactBudgetIsManual,
        window: this.opts.contextWindowTokens || 0,
        // live compaction phase ("summarizing"/"harvesting"/"done") — lets any
        // client show progress even if it missed the bus event
        ...(this.compactPhase ? { compacting: this.compactPhase } : {}),
      },
      pendingPrompts: this.pendingPrompts.length,
      // #78: the IDS as well as the count. The web UI reconciles its local echo
      // list against the live queue, and it was doing that by POSITION
      // (slice(0, queued)) because only a count was published — so whenever the
      // count dipped below the true queue length (a mid-queue cancellation, or a
      // momentary gap), the NEWEST still-queued echoes were dropped and their
      // undelivered log rows reappeared as settled "sent" rows. Identity needs
      // the ids to travel; the count alone cannot express "these two".
      //
      // Bounded like the rest of the snapshot, and ids are opaque, so this
      // cannot carry prompt text.
      pendingPromptIds: this.pendingPrompts.map((p) => p.id).filter((x): x is string => !!x).slice(0, 64),
      // #87: the QUEUE itself, not just its ids. The UI's echo rows are
      // memory-only (like liveByAgent and timelineCache), so after a reload the
      // queue survives on the server while the UI has nothing to render — the
      // queued message then appears only as its log row, i.e. already sent.
      //
      // Ids alone cannot fix that: they identify a prompt, they do not carry its
      // text, so the UI cannot rebuild an echo from them. This is the queue the
      // operator is looking at, already on screen in the ⏳ badge, so shipping it
      // is not new exposure — it is the same data in a shape the timeline can
      // use.
      //
      // `at` is the enqueue time so the echo keeps a stable position and id
      // across rebuilds; `sent` mirrors the echo flag the UI already tracks.
      pendingPromptQueue: this.pendingPrompts
        .filter((p) => !!p.id)
        .slice(0, 64)
        .map((p, i) => ({
          id: p.id!,
          text: p.text.slice(0, 8000),
          source: p.source,
          at: Date.now() - (this.pendingPrompts.length - i),
          ...(p.images?.length ? { images: p.images.slice(0, 8) } : {}),
        })),
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
  enqueuePrompt(
    text: string,
    source = "user",
    images?: { url: string; name?: string }[],
  ): string {
    // a prompt during a tool park (wait_children) takes over instantly:
    // unpark fixes the DISPLAY, aborting the park signal actually ends the
    // wait — the run chain resumes with this prompt drained at the boundary
    if (this.parkedByTool) {
      this.toolAbort.abort();
      // the abort signal is one-shot — rearm it AND republish on toolCtx
      // (toolCtx holds a COPY of the signal reference, so replacing only
      // this.toolAbort left the park listening to the dead controller)
      this.toolAbort = new AbortController();
      (this.toolCtx as { signal: AbortSignal }).signal = this.toolAbort.signal;
    }
    this.unparkFromTool();
    this.wake?.();
    // a user message means the operator JUST checked in — they obviously know
    // the state, so don't nag with a progress report right after
    if (source === "user") {
      this.lastProgressAt = Date.now();
      this.activityChars = 0;
      this.turnsSinceProgress = 0;
    }
    // stable id shared by the log event and the UI's pending echo — the UI
    // flips its echo to "sent" when prompt-delivered carries this id back
    const promptId =
      source === "user" ? `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` : "";
    // #108: the queue entry is registered SYNCHRONOUSLY, before the async work.
    //
    // It used to be pushed inside the `.then()`, so it only existed once
    // `ensureReady()` resolved — while `cancelPrompt` reads the array
    // synchronously. A cancel issued in that window found nothing, returned null,
    // got a 409, and the UI discarded the draft: the operator saw a withdrawn
    // prompt that the model then received and acted on.
    //
    // The wide case is worse than the same-tick one: an agent still restoring a
    // 4,000-event session log holds that promise for real wall-clock time, so the
    // cancel essentially always loses.
    //
    // Registering first is safe because the queue is drained only at a turn
    // boundary (`drainPendingPrompts`), which cannot run inside this
    // synchronous stretch. The log append still happens in order, after.
    const entry = { source, text, images, ...(promptId ? { id: promptId } : {}) };
    this.pendingPrompts.push(entry);
    void this.ensureReady()
      .then(() =>
        this.log.append("prompt", this.currentSession, this.currentBranch, {
          source,
          text,
          ...(images?.length ? { images: images.map((i) => ({ url: i.url, name: i.name })) } : {}),
          ...(promptId ? { promptId } : {}),
        }),
      )
      .then(() =>
        bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent),
      )
      .catch(() => {});
    return promptId;
  }

  /**
   * Withdraw a still-pending user prompt (before it reaches an LLM call).
   * Returns the text so the UI can put it back into the composer draft.
   */
  cancelPrompt(promptId: string): string | null {
    const i = this.pendingPrompts.findIndex((p) => p.id === promptId);
    if (i === -1) return null; // already delivered or unknown
    const [p] = this.pendingPrompts.splice(i, 1);
    void this.log
      .append("system_note", this.currentSession, this.currentBranch, {
        event: "prompt-cancelled",
        promptId,
        preview: p.text.slice(0, 80),
      })
      .then(() =>
        bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent),
      )
      .catch(() => {});
    return p.text;
  }

  /**
   * Hand queued user prompts to the model at a turn boundary. Each consumed
   * prompt is logged as a system_note (prompt-delivered) so the UI can flip
   * its pending echo to "sent" at exactly the moment the text enters an LLM
   * call payload — not merely when it was logged.
   */
  private drainPendingPrompts(): void {
    this.drainBackgroundExits();
    for (const p of this.pendingPrompts.splice(0)) {
      // multimodal: images ride as OpenAI content parts (text first, then
      // images); plain prompts keep the string form for cache friendliness
      if (p.images?.length) {
        this.messages.push({
          role: "user",
          content: p.text,
          content_parts: [
            { type: "text", text: p.text },
            ...p.images.map((i) => ({ type: "image_url" as const, image_url: { url: i.url } })),
          ],
        });
      } else {
        this.messages.push({ role: "user", content: p.text });
      }
      if (p.source === "user") {
        const id = p.id ?? `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        // #37: queued here, MARKED at the request boundary instead — see
        // markDeliveredPrompts(). Text is kept so the marker can carry the same
        // preview the UI shows.
        this.undeliveredPrompts.push({ id, preview: p.text.slice(0, 80) });
      }
    }
  }

  /** ids of user prompts that have entered an LLM call payload (recent first-capped) */
  private deliveredPrompts: string[] = [];
  /**
   * User prompts consumed from the queue but not yet MARKED as delivered (#37).
   *
   * They are drained at a turn boundary, but the `prompt-delivered` marker must
   * wait until the request that carries them actually starts — which is later,
   * and after `maybeCompact()`, which can itself call the LLM.
   */
  private undeliveredPrompts: { id: string; preview: string }[] = [];

  /**
   * Log `prompt-delivered` for every prompt whose outbound request is starting.
   *
   * #37: the marker's meaning is "the request carrying this prompt has begun".
   * It used to fire in drainPendingPrompts, i.e. before the request, so the
   * timeline reordered by a moment the API never saw.
   */
  private async markDeliveredPrompts(): Promise<void> {
    if (this.undeliveredPrompts.length === 0) return;
    const pending = this.undeliveredPrompts;
    this.undeliveredPrompts = [];
    for (const { id, preview } of pending) {
      this.deliveredPrompts.push(id);
      // cap: the UI only needs recent confirmations
      if (this.deliveredPrompts.length > 64) this.deliveredPrompts.shift();
      await this.log.append("system_note", this.currentSession, this.currentBranch, {
        event: "prompt-delivered",
        promptId: id,
        preview,
      });
    }
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
  }

  /**
   * Background jobs that exited since the last LLM call. Their outcomes are
   * folded into ONE harness message at the turn boundary — the agent learns
   * exit codes and output tails without polling bash_output.
   */
  private bgExits: { id: string; code: number | null; cmd: string; durationMs: number; outputTail: string }[] = [];

  private onBackgroundJobExitQueued(info: { id: string; code: number | null; cmd: string; durationMs: number; outputTail: string }): void {
    this.bgExits.push(info);
    if (this.bgExits.length > 32) this.bgExits.shift(); // cap runaway spam
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
    // the round ended BECAUSE this job was running (auto-continue is
    // suppressed while bg jobs are alive) — its exit IS the wake-up call.
    // Without this the report would sit unread until the operator poked
    // the agent. Stopped agents stay stopped (a deliberate human stop).
    //
    // Checking status once is NOT enough: the exit can land in the window
    // between the loop's hasRunningBgShells() check (which breaks the round
    // out) and the loop actually flipping to idle. The callback then sees
    // "running", skips start(), and the agent goes idle with the report
    // unread — wedged until a human pokes it. So remember that the loop was
    // still winding down, and re-check once it has settled.
    const windingDown = this.status === "running";
    if (!this.stopRequested && (this.status === "idle" || windingDown)) {
      // park the decision until the in-flight round has actually settled
      void this.enqueue(async () => {
        if (this.stopRequested) return; // a stop raced us — respect it
        if (this.status === "idle") this.start(`background job ${info.id} finished`);
      });
    }
  }

  /** fold queued background-exit reports into the next LLM call (once each) */
  private drainBackgroundExits(): void {
    if (!this.bgExits.length) return;
    const exits = this.bgExits.splice(0);
    const lines = exits.map((e) => {
      const status = e.code === 0 ? "finished OK" : `FAILED with exit code ${e.code ?? "?"}`;
      const tail = e.outputTail.trim();
      return (
        `- job ${e.id}: ${status} after ${(e.durationMs / 1000).toFixed(1)}s — ${e.cmd.slice(0, 100)}` +
        (tail ? `\n  output tail:\n${tail.split("\n").slice(-8).map((l) => "  | " + l).join("\n")}` : "")
      );
    });
    const text =
      `[harness] Background job report:\n${lines.join("\n")}\n\n` +
      "React to failures now if needed. Full output stays available via bash_output(job_id).";
    this.messages.push({ role: "user", content: text });
    void this.log.append("prompt", this.currentSession, this.currentBranch, { source: "harness", text }).catch(() => {});
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
    // #76: a stop() immediately followed by start() USED TO BE SILENTLY LOST.
    //
    // `stop()` only flips the status via an ENQUEUED task, so between the two
    // calls the status is still "running" and the guard below returned early —
    // before `stopRequested = false` could run. The stop then landed, the loop
    // exited, and the agent ended "stopped" with the restart discarded. The same
    // window made a stop+restart abort the new round's first tool.
    //
    // So a pending stop is not a reason to refuse a start. The loop's own
    // guards (`stopRequested` re-checked after every await) keep the old turn
    // from running on, and enqueue() serialises the two tasks, so the restart
    // is ordered after the stop rather than racing it.
    const pendingStop = this.stopRequested;
    if (this.status === "running" && !pendingStop) return;
    this.stopRequested = false;
    // claim the status against any stop write still queued behind us (#86)
    this.stopSeq++;
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
    // interrupt an in-flight LLM call AND any parked tool (wait_children):
    // without aborting toolCtx.signal the park ran to its full timeout
    this.abort?.abort();
    this.toolAbort.abort();
    this.wake?.();
    // #86: the status write is DEFERRED onto the run chain, so it can land
    // AFTER a start() that followed it. Observed: `idle -> stopped -> running ->
    // running -> idle`. The agent did resume — but it flashed "stopped" on the
    // way, and finished idle rather than running, so from the UI the operator's
    // ▶ start looked like it had done nothing.
    //
    // `start()` clears stopRequested synchronously, which is what makes this
    // detectable: by the time this task runs, a start has already claimed the
    // agent and the stop no longer owns the status.
    //
    // So record WHEN the stop was requested, and let a start that came after it
    // win. A stop issued while the agent is genuinely still running behaves
    // exactly as before.
    const stopSeq = ++this.stopSeq;
    void this.enqueue(() => {
      // Only a start() that arrived AFTER this stop may claim the status. The
      // seq check alone does that — no status test, because a genuinely running
      // agent must still be reported "stopped" (#86).
      if (this.stopSeq !== stopSeq) return Promise.resolve();
      this.setStatus("stopped", reason);
      return Promise.resolve();
    });
  }

  /** monotonic counter: a start() bumps it, so a pending stop status write loses */
  private stopSeq = 0;
  /** #95: set when this round already injected a harness progress request */
  private progressRequestedThisRound = false;

  /**
   * CONTROL PLANE: fired on every status change, immediately, independent of the
   * log.
   *
   * #126: `wait_children` wakeups used to ride `EventLog.onEvent`, so a status
   * change reached the parent only AFTER the write completed. After the
   * write-before-notify fix that meant a FAILED or slow write left a parked parent
   * waiting forever — persistence latency became control flow. Measured with every
   * write failing: `onEvent fired: 0`, so no wakeup at all.
   *
   * Control flow must not depend on durability, so this is separate from the
   * event pipeline. The log's `onEvent` now means "persisted, tell the world";
   * this means "my state changed, react now".
   */
  onControlStatusChange: ((agentId: string, status: AgentStatus) => void) | null = null;

  private setStatus(s: AgentStatus, reason = ""): void {
    // Update the field FIRST. The control-plane hook fires synchronously below
    // (see onControlStatusChange), and it is what wakes parked wait_children
    // callers — those
    // re-check agent.status at that instant. Updating after the append made
    // every waiter observe the OLD status ("running"), conclude "someone is
    // still working", and stay parked until timeout even though the child had
    // just settled.
    const prev = this.status;
    this.status = s;
    this.statusReason = reason;
    if (prev !== s) {
      // #126: control plane FIRST, and not via the log. A parent's wait_children
      // must wake on the status change itself, not on the durability of the write
      // that records it.
      try {
        this.onControlStatusChange?.(this.opts.id, s);
      } catch {
        /* a control-plane listener must never break a status change */
      }
      void this.log.append("state", this.currentSession, this.currentBranch, {
        from: prev,
        to: s,
        reason,
      });
    }
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
  }

  /** Main auto-run loop: turn -> tools -> turn ... -> done/idle/stop. */
  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      try {
        // stop() aborted the tool signal and nothing re-armed it (only the
        // parkedByTool path ever did), so EVERY tool after a stop returned
        // "aborted (harness shutdown)" until process restart. A new round is
        // new work: give it a live signal (re-arm AND republish — toolCtx
        // holds a copy of the reference).
        if (this.toolAbort.signal.aborted) {
          this.toolAbort = new AbortController();
          (this.toolCtx as { signal: AbortSignal }).signal = this.toolAbort.signal;
        }
        // failures from the previous round must not poison this one — the
        // counter only ever reset on success, so a tripped limit re-tripped
        // on the first failure after restart ("6 consecutive" right after start)
        this.consecutiveToolErrors = 0;
        // a round that got as far as an LLM call means the API is reachable
        // again — reset the error-retry backoff to its base delay
        this.consecutiveApiErrors = 0;
        const turnsAtStart = this.stats.turns;
        let finished = await this.runTurnsUntilIdle();
        // Round ended on the per-round turn cap. NO model-facing nudge: telling
        // the model "the round ended, consider finish()" invited premature
        // finishes that conflicted with the goal. The cap is harness-side only
        // (logged for observability); continuation goes through the normal
        // auto-continue path below.
        const cap = Math.max(0, this.opts.maxTurnsPerRound ?? 200);
        if (!finished && cap > 0 && this.stats.turns - turnsAtStart >= cap && !this.stopRequested) {
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "round-turn-cap",
            turns: cap,
          });
        }
        if (this.stopRequested) break;
        // fresh user input arrived while we were finishing up — another round now
        if (this.pendingPrompts.length) continue;
        // A round that parked its work on a background bash (dev server,
        // watcher, long build) ENDED ON PURPOSE — the job's exit notification
        // is the wake-up. Nagging with "continue working" here just made the
        // agent spin up duplicate work while it meant to wait. Checked BEFORE
        // the finished/goal gates: a finish(goalComplete=false) round that
        // leaves a bg job running is exactly the "wait for it" pattern.
        if (hasRunningBgShells(this.toolCtx.cwd)) {
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "auto-continue-suppressed",
            reason: "background job still running — the agent resumes when it exits",
          });
          break;
        }
        // A SUB-AGENT that ended its round on a bare message (no finish call)
        // still owes the parent a report — nothing else will carry it (#42).
        // Emitted HERE, after the loop, so a real finish() on a later turn
        // always wins and this never pre-empts a better summary.
        if (this.pendingSubReport) {
          const report = this.pendingSubReport;
          this.pendingSubReport = "";
          if (!finished) {
            await this.handleFinish(
              JSON.stringify({ goalComplete: true, summary: report }),
            );
            finished = true; // it IS finished now — don't auto-nudge a reporter
          }
        }
        // #106: a round that did real work resets the idle counter. `finished`
        // covers the finish() paths; a round that ran tool calls is caught by the
        // turn counter below, which is checked before this point.
        if (finished) this.consecutiveIdleRounds = 0;
        // auto-continue only makes sense with an active goal to continue toward
        if (
          finished ||
          !this.opts.autoContinue ||
          this.goal.status !== "active" ||
          !this.goal.text.trim()
        )
          break;
        // auto-continue: wait quietly, then nudge with a fresh round.
        // Sub-agents get a SCOPE-ANCHORED nudge instead of a generic one:
        // "Continue working toward the current goal" made a forked sub-agent
        // re-read its inherited context and drift into one of the parent's
        // older tasks — it would keep going forever without ever finish()ing.
        // #106: bound CONSECUTIVE auto-continued rounds.
        //
        // maxTurnsPerRound cannot bound this loop, and the reason is structural:
        // a ROOT agent that answers with a bare message ends its round after ONE
        // turn (`return finished` in runTurnsUntilIdle), so no single round ever
        // reaches the per-round cap. `finished` stays false, the goal stays
        // active, and auto-continue starts the next round — forever.
        //
        // Measured: maxTurnsPerRound=40 produced 997 turns and ZERO
        // `round-turn-cap` notes, because the cap is only ever evaluated once a
        // round ENDS, and these rounds end at turn 1. A tool-calling model does
        // trip it (8 turns, 1 note) — the gap is specific to the talk-only shape.
        //
        // So the bound belongs here, where the real loop is: consecutive rounds
        // that produced neither a finish() nor a tool call. Any tool call resets
        // it — that is real work, not stalling — and so does a stop, a fresh
        // user prompt, or an operator reply.
        //
        // This is a SAFETY VALVE, not a policy. It is deliberately generous
        // (default 50) because a long autonomous stretch that keeps calling tools
        // resets the counter on every turn and is never affected; only a model
        // that never acts and never finishes trips it.
        if (++this.consecutiveIdleRounds > this.opts.maxConsecutiveIdleRounds) {
          this.consecutiveIdleRounds = 0;
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "auto-continue-bounded",
            rounds: this.opts.maxConsecutiveIdleRounds,
            detail:
              "the agent produced no tool calls and no finish() across this many " +
              "consecutive rounds — stopping the loop rather than letting it spin (#106)",
          });
          break;
        }
        await this.sleepInterruptible(this.opts.continueDelayMs);
        if (this.stopRequested) break;
        // #95: do NOT pair this with a progress request. Both fire at the turn
        // boundary and both inject a user message, so the model received two
        // harness instructions back to back — "Continue working toward the
        // current goal" immediately followed by "Please give a brief progress
        // report now", which reads as the harness talking to itself.
        //
        // The progress request already re-enters the loop, so it IS the
        // continuation: suppressing the nudge when one is pending costs nothing
        // and leaves exactly one instruction per boundary.
        if (this.progressRequestedThisRound) {
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "auto-continue-suppressed",
            detail: "a progress report was already requested this round (#95)",
          });
          break;
        }
        const isSub = !!this.opts.parent;
        const nudge = isSub
          ? `[harness] Auto-nudge. Re-anchor on YOUR task — and only that:\n\n${this.goal.text.slice(0, 1500)}\n\nThe inherited conversation is reference only; other agents own any older tasks in it. If your task is complete, call finish() now instead of continuing. If blocked, explain why briefly and finish().`
          : AUTO_CONTINUE_NUDGE;
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
        // onError:"retry" keeps an unattended agent alive across failures —
        // BOTH provider outages (API errors) and runaway trips (a tool that
        // keeps failing). Back off, then start a fresh round; the delay
        // doubles per consecutive failure so a hard failure doesn't spin,
        // and any stop/prompt still interrupts the sleep instantly.
        const isRunaway = /runaway detection/.test(msg);
        if (this.opts.onError === "retry" && !this.awaitingUser && !this.pendingPrompts.length) {
          this.consecutiveApiErrors++;
          const wait = Math.min(
            (this.opts.retryDelayMs || 60_000) * 2 ** Math.min(this.consecutiveApiErrors - 1, 6),
            600_000,
          );
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "error-retry",
            attempt: this.consecutiveApiErrors,
            waitMs: wait,
            kind: isRunaway ? "runaway" : "api",
          });
          this.setStatus("error", `${msg.slice(0, 220)} — retrying in ${Math.round(wait / 1000)}s`);
          await this.sleepInterruptible(wait);
          if (this.stopRequested) break;
          continue; // fresh round; the loop re-arms the tool signal itself
        }
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
      // #37: `prompt-delivered` must mean "the outbound request CARRYING this
      // prompt has started", not "the prompt moved from the queue into
      // `this.messages`".
      //
      // It used to be logged in drainPendingPrompts, which runs BEFORE
      // refreshSkills, maybeRequestProgress and — critically — maybeCompact. So
      // the marker preceded the request, and `maybeCompact()` can itself make an
      // LLM call, which meant the timeline claimed a delivery order the API never
      // saw. Measured before the fix:
      //
      //     LLM CALL #1
      //       seq=5  prompt-delivered("first prompt")
      //       seq=6  llm turn start
      //
      // The UI reorders by this marker (resequenceToDelivery), so the semantics
      // were the bug — not timeline-order.ts.
      //
      // Emitted ONCE per request, not per attempt: a retry sends the same payload,
      // so re-emitting would move the marker after a later event on each try.
      if (attempt === 1) await this.markDeliveredPrompts();
      try {
        return await this.callLlm(messages, tools, onDelta);
      } catch (err) {
        this.abort = null;
        const name = (err as Error).name;
        if (name === "StopRequested" || name === "AbortError" || this.stopRequested) throw err;
        // #76: a context-overflow error is the caller's to handle, not ours to
        // retry. Retrying the SAME oversized request four times with 5s/5s/30s
        // waits cannot succeed, and it delays the compact-and-retry that would
        // — so the overflow path never even ran. This is the same
        // "present, correct, and inert" shape as #54.
        if (isContextOverflow(err)) throw err;
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
    // maxTurnsPerRound is a SOFT cap (0 disables): reaching it nudges the
    // model to wrap up instead of hard-failing the round — long autonomous
    // stretches are normal here, and a throw used to leave status=error with
    // no auto-recovery even though autoContinue would happily keep going.
    const cap = Math.max(0, this.opts.maxTurnsPerRound ?? 200);
    for (let guard = 0; cap === 0 || guard < cap; guard++) {
      if (this.stopRequested) return finished;
      // deliver prompts queued while the previous turn was running
      this.drainPendingPrompts();
      // skills may have been created last turn — refresh the prompt listing
      await this.refreshSkills();
      // periodic progress report at turn boundary (no mid-turn interruption)
      // #95: the flag is per-TURN, not per-round. `maybeRequestProgress` sits
      // inside the turn loop and auto-continue is checked after the round
      // ends, so the flag has to mean "this boundary already carried an
      // instruction" — reset here, set below if the request fires.
      this.progressRequestedThisRound = false;
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
        // Provider context overflow → compact ONCE and retry the turn
        // (OpenCode-style overflow recovery). even with autoCompact off, an
        // actual overflow is proof the estimate missed; a second overflow is
        // returned as a real error instead of looping.
        if (isContextOverflow(err) && !this.stopRequested) {
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "overflow-recovery",
            detail: String((err as Error).message).slice(0, 200),
          });
          const before = this.stats.compactions;
          await this.maybeCompact(true);
          if (this.stats.compactions > before) {
            await this.log.append("system_note", this.currentSession, this.currentBranch, {
              event: "overflow-recovered",
            });
            guard--; // the retry does not count against this round's cap
            continue;
          }
        }
        throw err;
      }
      if (res.usage) {
        const inTok = res.usage.inputTokens ?? 0;
        const cached = res.usage.cachedInputTokens ?? 0;
        this.stats.inputTokens += inTok;
        this.stats.cachedInputTokens += cached;
        this.stats.outputTokens += res.usage.outputTokens ?? 0;
        // cost estimate: uncached input at prompt rate, cache hits usually
        // bill at a fraction (OpenRouter reports the blended prompt price, so
        // cached tokens are charged separately at ~10% — a common provider
        // convention; without per-provider detail this is the honest guess)
        if (this.modelPricing) {
          const p = this.modelPricing;
          const uncached = Math.max(0, inTok - cached);
          this.stats.costUsd =
            (this.stats.costUsd ?? 0) +
            (uncached * p.prompt + (res.usage.outputTokens ?? 0) * p.completion + cached * p.prompt * 0.1);
        }
        this.lastUsage = {
          input: res.usage.inputTokens ?? 0,
          output: res.usage.outputTokens ?? 0,
          cached: res.usage.cachedInputTokens,
        };
        await this.log.append("usage", this.currentSession, this.currentBranch, res.usage);
      }

      const m = res.message;
      // sanitize() fills empty content with "(tool call)" for providers that
      // reject blank content — that placeholder is request-only and must NOT
      // reach the timeline as if the agent had said something
      const isPlaceholder = m.content === "(tool call)" || m.content === "(no content)";
      await this.log.append("message", this.currentSession, this.currentBranch, {
        role: "assistant",
        content: isPlaceholder ? "" : (m.content ?? ""),
        toolCalls: m.tool_calls?.map((c) => ({ id: c.id, name: c.function.name })),
        reasoning: res.reasoning,
      });
      this.messages.push(m);
      this.turnsSinceProgress++;
      this.activityChars += m.content?.length ?? 0;

      // A round that ends with a plain assistant message and NO tool calls is
      // the end of the agent's work. For a ROOT agent that is just "done" — but
      // for a SUB-AGENT it means the work is over and the parent is waiting.
      //
      // Models overwhelmingly prefer writing their report as the final message
      // over calling finish(), and only handleFinish() emits the `final: true`
      // event that onChildEvent() forwards to the parent. So that habit silently
      // cost the parent the ENTIRE result (#42) — the report existed only in the
      // child's own log, which the parent's model context never replays.
      // Harvest it here so both paths share one code path.
      if (!m.tool_calls?.length) {
        // A turn with no tool calls and real text is how models overwhelmingly
        // signal "I'm done" — far more often than by calling finish(), which
        // the spawn directive asks for but they routinely ignore.
        //
        // Two things were wrong (#42):
        //  1. only handleFinish() emits the `final: true` event that
        //     onChildEvent() forwards to the parent, so a sub-agent that ended
        //     with a plain message sent the parent NOTHING — the report lived
        //     only in the child's log, which the parent's context never
        //     replays;
        //  2. the round then returned "not finished" with an active goal, so
        //     auto-continue re-nudged and the child looped forever (measured:
        //     257 consecutive turns) re-reporting the same text.
        //
        // A bare message might be a mid-task narration though — sub-agents
        // often say "here's what I found so far…" and call finish() later with
        // a better summary. So do NOT report yet: remember it and give the child
        // ONE more turn to call finish() properly. The harness nudge makes that
        // turn explicit, so a child that just wanted to narrate ends here (and
        // its held report is forwarded by the loop's end-of-round path), while
        // a child that has a real summary delivers it instead. A real finish()
        // clears the held note, so it is forwarded exactly once (#42).
        if (this.opts.parent) {
          if (this.pendingSubReport) {
            // already offered a turn after a bare message — take the held report
            this.messages.push({
              role: "user",
              content:
                "[harness] Report delivered. If this IS your final answer, call finish() now with a summary for your parent; otherwise continue the task.",
            });
          } else {
            this.pendingSubReport = (m.content ?? "").trim();
            this.messages.push({
              role: "user",
              content:
                "[harness] If you are done, call finish() with a summary for your parent so it receives your report. Otherwise continue the task.",
            });
          }
          continue; // one more turn before we treat the message as final
        }
        return finished;
      }

      for (const call of m.tool_calls) {
        if (this.stopRequested) {
          // #54: this returned straight out of the turn, SKIPPING the
          // answerUnansweredToolCalls backstop below — so every remaining
          // tool_call in this assistant message stayed logged with NO
          // tool_result anywhere, and its row rendered as "waiting for
          // output…" for the rest of the session.
          await this.answerUnansweredToolCalls(m);
          return finished;
        }
        if (call.function.name === "finish") {
          this.pendingSubReport = ""; // the real summary supersedes it
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
          // #105: `continue` advanced the TOOL-CALL loop, so every later call in
          // this same assistant message still executed — a model emitting
          // finish() plus one more call got real filesystem writes AFTER it had
          // reported `final: true` and the goal was already done. The parent was
          // told the work finished while the workspace was still being mutated.
          //
          // So finish ends the BATCH: answer anything still outstanding (so no
          // tool_call is left unpaired — the provider rejects the next request
          // otherwise, #76) and leave the tool loop. The outer loop then returns
          // on `finished`.
          await this.answerUnansweredToolCalls(m);
          return true;
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
          // pi-goal-x-style verification contract: plain-text completion
          // requirements audited before finish(goalComplete=true) is honored
          if (typeof a.verify === "string" && a.verify.trim())
            await this.setGoalVerify(a.verify.trim().slice(0, 4000));
          await this.answerMeta(
            call,
            text ? "goal updated" : "empty goal rejected",
          );
          continue;
        }
        if (call.function.name === "get_goal") {
          await this.answerMeta(
            call,
            JSON.stringify(
              {
                goal: this.goal.text || "(none set)",
                status: this.goal.status,
                ...(this.goal.verify ? { verify: this.goal.verify } : {}),
                ...(this.goal.audit ? { lastAudit: this.goal.audit } : {}),
              },
              null,
              1,
            ),
          );
          continue;
        }
        if (call.function.name === "ask_user") {
          const a = safeParse(call.function.arguments);
          const question = String(a.question ?? "").slice(0, 2000);
          // models sometimes pass objects ({label}, {option}, {value}) —
          // extract the label instead of rendering "[object Object]" buttons
          const options = Array.isArray(a.options)
            ? a.options
                .slice(0, 6)
                .map((o: unknown) => {
                  if (typeof o === "string") return o;
                  if (o && typeof o === "object") {
                    const obj = o as Record<string, unknown>;
                    for (const k of ["label", "option", "choice", "value", "text"])
                      if (typeof obj[k] === "string" && obj[k]) return obj[k] as string;
                  }
                  return "";
                })
                .filter((o: string) => o.trim())
            : [];
          // the callId lets the UI tell "still open" from "already answered"
          // (a settled tool_result for this id exists) and disable re-answering
          await this.log.append("question", this.currentSession, this.currentBranch, {
            question,
            options,
            callId: call.id,
          });
          await this.answerMeta(
            call,
            "question shown to the operator — the loop is parked until they reply. " +
              "Their reply (possibly free text, not one of the options) arrives as your next user message.",
          );
          this.awaitingUser = true;
          this.setStatus("waiting", question.slice(0, 80));
          // control flow: park the loop; the operator's next prompt resumes it
          //
          // #54: answer the rest of this assistant batch BEFORE parking. The
          // throw leaves the whole tool loop, so any EARLIER call in the same
          // message that was logged but not yet run kept no tool_result — the
          // comment on the backstop below says as much, and it is exactly the
          // path that bites in practice because ask_user is common.
          await this.answerUnansweredToolCalls(m);
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
          // Preferred: surgical checkbox updates — no full rewrite, no risk
          // of mangling unrelated sections, cheap enough to do mid-task.
          const updates = Array.isArray(a.updates)
            ? a.updates
                .map((u: unknown) => {
                  const o = (u ?? {}) as { item?: unknown; done?: unknown };
                  return { item: String(o.item ?? ""), done: o.done !== false };
                })
                .filter((u: { item: string }) => u.item.trim())
            : [];
          if (updates.length > 0) {
            const note = await this.updateTodoItems(updates, "agent");
            await this.answerMeta(call, `${note} (visible to the operator)`);
            continue;
          }
          const content = String(a.content ?? "").slice(0, 32_000);
          if (!content.trim()) {
            await this.answerMeta(
              call,
              "nothing to do: pass updates:[{item,done}] to check items off, or content to replace the whole list",
            );
            continue;
          }
          await this.setTodo(content, "agent");
          await this.answerMeta(call, "task list replaced (visible to the operator)");
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
        // first filesystem touch creates a missing workspace (never at boot)
        // #54: this is awaited BETWEEN the tool_call append above and the
        // tool_result append below, and `fs.mkdir` has no catch — so a failure
        // propagated out of the whole loop, leaving the call logged with no
        // result ANYWHERE, and its row read "waiting for output…" for good.
        //
        // The loop's own backstop could not save it: it sits at the bottom of
        // the same loop, which a throw skips. So the tool_result is written in a
        // `finally` — the call is answered whatever happens.
        // the type is inferred from executeTool, so this cannot drift from it
        let result: Awaited<ReturnType<typeof executeTool>>;
        try {
          await this.ensureWorkspace();
          result = await executeTool(call.function.name, call.function.arguments, this.toolCtx);
        } catch (err) {
          result = { ok: false, result: `tool could not run: ${(err as Error).message}` };
        }
        this.stats.toolCalls++;
        // #106: a tool call is real work, so it clears the idle-round counter.
        this.consecutiveIdleRounds = 0;
        // #109: ONE clip, applied to BOTH the log and the live message.
        //
        // The log stored `result.slice(0, 8000)` while `messages` kept the full
        // text, and a restore rebuilds `messages` from the log — so a model
        // resuming work saw a different (and much smaller) tool result than it
        // had just seen live. Measured: 8000 bytes logged, 436 after restart.
        //
        // The 8000-byte log clip is deliberate — it bounds the log file — so the
        // fix is not to log everything. It is to clip the live message the SAME
        // way, so the two views agree and a restart is not a silent downgrade.
        // Restore is byte-exact everywhere else (`answerMeta` preserves its exact
        // content); this was the one place the replay diverged.
        const capped = result.result.slice(0, 8000);
        await this.log.append("tool_result", this.currentSession, this.currentBranch, {
          callId: call.id,
          name: call.function.name,
          ok: result.ok,
          durationMs: Date.now() - t0,
          result: capped,
        });
        this.messages.push({ role: "tool", tool_call_id: call.id, content: capped });
        this.consecutiveToolErrors = result.ok ? 0 : this.consecutiveToolErrors + 1;
        if (this.consecutiveToolErrors >= this.opts.maxConsecutiveToolErrors) {
          // structured, greppable AND visible: the note carries what failed so
          // the operator (and the UI) can show "WHICH tool, with what error"
          // instead of a bare counter
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "runaway-detected",
            failures: this.consecutiveToolErrors,
            limit: this.opts.maxConsecutiveToolErrors,
            lastTool: call.function.name,
            lastError: result.result.slice(0, 300),
          });
          throw new Error(
            `runaway detection: ${this.consecutiveToolErrors} consecutive tool failures ` +
              `(last: ${call.function.name})`,
          );
        }
      }
      // #76: every tool_call an assistant message issued must have a matching
      // tool result, or the provider REJECTS the next request — which is the
      // "`200 with no choices`" shape #50 traced to a malformed history.
      //
      // Two exits could leave some unanswered: `stopRequested` returns early
      // mid-batch, and a handler that throws (ask_user parking the loop is the
      // one that bites in practice) propagates out of the whole loop. Restore
      // has a hole-filler for exactly this; the LIVE array did not, so a session
      // that hit it produced an invalid next request and then failed with
      // something that looked like a provider fault.
      //
      // So the invariant is enforced here rather than at each exit: whatever
      // happened, answer what is still outstanding before moving on.
      await this.answerUnansweredToolCalls(m);
      if (finished) return true;
    }
    // cap reached — loop() logs the note, asks for a progress report and
    // nudges the model; this round simply ends (no hard error)
    return finished;
  }

  /**
   * Append a tool result for every tool_call in `m` that has not been answered.
   *
   * Scans the tail of `messages` for `tool_call_id`s, so it is correct whichever
   * path left the batch unfinished — a stop, a throw, or a normal completion
   * where a handler returned early. Answered calls are left alone.
   */
  private async answerUnansweredToolCalls(m: ChatMessage): Promise<void> {
    const calls = m.tool_calls ?? [];
    if (!calls.length) return;
    const answered = new Set<string>();
    for (const existing of this.messages) {
      if (existing.role === "tool" && existing.tool_call_id) answered.add(existing.tool_call_id);
    }
    for (const call of calls) {
      if (answered.has(call.id)) continue;
      const content = "(not completed — the tool did not run)";
      this.messages.push({ role: "tool", tool_call_id: call.id, content });
      await this.log.append("tool_result", this.currentSession, this.currentBranch, {
        callId: call.id,
        name: call.function.name,
        ok: false,
        durationMs: 0,
        result: content,
        synthesized: true,
      });
    }
  }

  private buildMessages(): ChatMessage[] {
    // deliberately static: [system] + append-only history keeps prefix caches hot.
    // The workspace context block (AGENTS.md + ls snapshot) is appended to the
    // system message ONCE per session — changing it mid-session would re-price
    // the whole prefix cache, so it is captured at first use and frozen.
    const sys = this.systemPrompt();
    const hasSystem = this.messages[0]?.role === "system";
    const head: ChatMessage[] = [{ role: "system", content: sys }];
    return hasSystem ? [...head, ...this.messages.slice(1)] : [...head, ...this.messages];
  }

  /**
   * Re-read AGENTS.md and adopt it if it changed. Returns the new text when it
   * did, or null when there is nothing to do.
   *
   * Called on compaction (#64 follow-up) and nowhere else. The one-shot capture
   * in systemPrompt() exists to keep the system prompt byte-identical for the
   * session so the provider's prefix cache survives; this is the single point
   * where breaking that identity is free, because compaction has just rewritten
   * the history underneath it.
   *
   * Failure is deliberately non-destructive: a read error, or a file that
   * vanished, leaves the previous content in place. Dropping the instructions
   * because of a transient error would be far worse than running one compaction
   * on slightly stale rules.
   */
  private reloadAgentsMd(): string | null {
    if (!this.agentsMdLoaded) return null; // nothing captured yet; nothing to update
    let fresh: string;
    try {
      const p = path.join(this.opts.workspace, "AGENTS.md");
      if (!existsSync(p)) return null; // deleted → keep the last known rules
      fresh = readFileSync(p, "utf8").slice(0, 12_000);
    } catch {
      return null; // unreadable → keep what we have
    }
    if (fresh === this.agentsMd) return null;
    this.agentsMd = fresh;
    return fresh;
  }

  /** AGENTS.md content cached for the session (empty string = none/read-failed) */
  private agentsMd = "";
  /** captured once, with the rest of the session-frozen context */
  private agentsMdLoaded = false;
  /** one-time workspace listing injected with the system prompt */
  private wsSnapshot = "";
  /**
   * one-time catalogue of available skills, injected with the system prompt
   * (#31). Built once alongside wsSnapshot so the prompt stays byte-identical
   * for the session and the provider prefix cache survives.
   */
  private skillCatalogue = "";

  private systemPrompt(): string {
    if (!this.agentsMdLoaded) {
      this.agentsMdLoaded = true;
      // AGENTS.md + workspace listing are captured ONCE and PERSISTED to the
      // session dir, so a restart re-issues the identical system prompt (the
      // prefix cache survives; the snapshot is a session artifact, not live
      // truth — list_dir shows current state).
      const snapPath = path.join(this.opts.sessionDir, "workspace-snapshot.txt");
      try {
        // a previous incarnation already froze a snapshot → reuse it verbatim.
        // The sentinel covers EMPTY workspaces too ("" would look like "no
        // file" and make the restart re-list, breaking prefix-cache identity).
        this.wsSnapshot = readFileSync(snapPath, "utf8");
      } catch {
        this.wsSnapshot = "";
      }
      if (this.wsSnapshot === "" && existsSync(snapPath)) {
        this.wsSnapshot = "(empty workspace)"; // the file exists but was empty
      }
      if (!this.wsSnapshot) {
        try {
          this.agentsMd = existsSync(path.join(this.opts.workspace, "AGENTS.md"))
            ? readFileSync(path.join(this.opts.workspace, "AGENTS.md"), "utf8").slice(0, 12_000)
            : "";
        } catch {
          this.agentsMd = "";
        }
        try {
          const entries = readdirSync(this.opts.workspace, { withFileTypes: true });
          const lines: string[] = [];
          for (const e of entries.slice(0, 60)) {
            if (e.name.startsWith(".")) continue;
            let size = "";
            if (!e.isDirectory()) {
              try {
                size = `${(statSync(path.join(this.opts.workspace, e.name)).size / 1024).toFixed(1)}K`;
              } catch {
                /* vanished */
              }
            }
            lines.push(e.isDirectory() ? `${e.name}/` : `${e.name} (${size})`);
          }
          this.wsSnapshot = lines.join("\n");
          if (!this.wsSnapshot) this.wsSnapshot = "(empty workspace)";
          try {
            void fs.writeFile(snapPath, this.wsSnapshot, "utf8");
          } catch {
            /* best-effort persistence */
          }
        } catch {
          this.wsSnapshot = "(workspace not readable)";
        }
      } else {
        try {
          this.agentsMd = existsSync(path.join(this.opts.workspace, "AGENTS.md"))
            ? readFileSync(path.join(this.opts.workspace, "AGENTS.md"), "utf8").slice(0, 12_000)
            : "";
        } catch {
          this.agentsMd = "";
        }
      }
      // #31: capture the skill catalogue in the SAME one-shot block, so the
      // system prompt stays byte-identical for the session (prefix cache).
      this.skillCatalogue = this.skillCatalogueText();
    }
    let sys = SYSTEM_TEMPLATE;
    if (this.agentsMd.trim()) {
      sys += `\n\n## Project instructions (AGENTS.md)\n\n${this.agentsMd}`;
    }
    if (this.wsSnapshot) {
      sys += `\n\n## Workspace snapshot (top level)\n${this.wsSnapshot}\nUse list_dir/read_file for anything deeper — do NOT list again what is already here.`;
    }
    // #31: the catalogue of AVAILABLE SKILLS. The prompt previously named the
    // skill TOOLS but never the skills themselves, so the only way to discover
    // one was to spend a tool call on list_skills() — and a model that does not
    // know a skill exists will never think to look.
    //
    // Appended ONCE, in the same one-shot block as AGENTS.md and the workspace
    // snapshot, so SYSTEM_TEMPLATE stays byte-identical for the session and the
    // provider prefix cache survives (#14's constraint). list_skills() remains
    // for the full detail (a skill saved mid-session shows up there).
    if (this.skillCatalogue) {
      sys +=
        `\n\n## Skills available in this workspace\n${this.skillCatalogue}\n` +
        `Load one with load_skill(name, instructions) when its description matches your task — ` +
        `pass what you want done so the instructions arrive with the playbook. ` +
        `list_skills() shows the full detail.`;
    }
    return sys;
  }

  /**
   * The last few conversation turns, for a parent's `final` report.
   *
   * Captured BEFORE the final marker is written so the parent gets real
   * substance (findings, file paths, numbers), not just whatever the model
   * typed into the finish() summary argument.
   *
   * Extracted as its own method because a REJECTED completion audit also needs
   * it (#89) — the retry prompt should carry the same context an approved one
   * would — while emitting no `final: true`.
   */
  private async captureRecentTurns(): Promise<string[]> {
    const recent: string[] = [];
    for (let i = this.messages.length - 1; i >= 0 && recent.length < 6; i--) {
      const m = this.messages[i]!;
      if (m.role === "user") continue; // prompts/noise — keep agent output only
      const text = String(m.content ?? "").trim();
      // #94: a message whose text is a PLACEHOLDER carries no information.
      //
      // `llm.ts` rewrites any assistant/tool message that has no usable text to
      // the literal "(tool call)" or "(no content)". Those are display
      // artifacts, and the parent's report was landing them verbatim — in the
      // real log, TWO of the six entries in an accepted report were literally
      // "[assistant] (tool call)", so half of what the parent was told about the
      // work was a placeholder.
      //
      // A tool CALL is real work, but it is represented in the tool RESULT that
      // follows, so dropping the placeholder loses nothing.
      if (!text || PLACEHOLDER_TEXT.test(text)) continue;
      // #94: a window this small must not be spent on BOOKKEEPING. The real log
      // showed a 6-slot window where two 23-char "(tool call)" placeholders and a
      // 40-char "decision recorded to decisions.md" took half the slots, pushing
      // out the reasoning a parent would need to judge the work. Harness
      // acknowledgements carry no findings, so they cost a slot for nothing.
      if (HARNESS_ACK.test(text)) continue;
      const who = m.role === "tool" ? "tool" : m.role;
      let line = `[${who}] ${text}`;
      if (m.role === "tool") {
        // tool results are prefixed "(failed)" by the logger when they fail —
        // the raw content is what matters here, and cap hard: these can be huge
        line = `[${who}] ${(m.content ?? "").trim().slice(0, 1200)}`;
      }
      // A generous cap, but not unbounded: one runaway turn must not blow up
      // the parent's context. The old 1500 char clip cut findings in half —
      // a review's conclusions routinely live past that mark (#42) — and this
      // text is bounded by 6 turns, so the worst case is ~120k chars.
      recent.unshift(line.slice(0, 20_000));
    }
    return recent;
  }

  private async handleFinish(argsJson: string): Promise<void> {
    const args = safeParse(argsJson);
    if (args.goalComplete === true && this.goal.status !== "done") {
      if (this.goal.verify?.trim()) {
        // pi-goal-x-style INDEPENDENT COMPLETION REVIEW: a separate LLM call
        // checks the verification contract against the conversation + summary
        // before "done" is honored. changes-required reopens the goal and
        // queues the auditor's feedback as the next user prompt.
        await this.log.append("goal", this.currentSession, this.currentBranch, {
          event: "audit-started",
          verify: this.goal.verify.slice(0, 2000),
        });
        try {
          const auditPrompt =
            `You are an independent completion AUDITOR (not the worker). Decide whether the goal is genuinely complete.\n\n` +
            `GOAL:\n${this.goal.text.slice(0, 4000)}\n\nVERIFICATION CONTRACT (must ALL hold):\n${this.goal.verify.slice(0, 2000)}\n\n` +
            `WORKER'S FINAL SUMMARY:\n${String(args.summary ?? "").slice(0, 3000)}\n\n` +
            `Conversation evidence follows. Reply with EXACTLY one line starting either\n` +
            `"APPROVED: <one-sentence justification>" or\n` +
            `"CHANGES-REQUIRED: <the specific gaps that must be addressed>".`;
          const res = await this.callLlm(
            [
              ...this.buildMessages(),
              { role: "user", content: auditPrompt },
            ],
            [], // no tools — verdict only
          );
          const text = String(res.message.content ?? "");
          // #90: a reply that is NOT a verdict must not be read as a rejection.
          //
          // `/^APPROVED\b/i.test("")` is false, so an auditor that returned
          // nothing — truncated, refused, or leaked provider tool-call markup —
          // was scored `changes-required` with no reason. Seven times in one
          // session: the worker was told to "address these gaps" while being
          // given none, and the fallback text was the contract it had already
          // read. A reason-less rejection carries no information and only
          // teaches everyone that the audit is noise.
          //
          // So an unusable reply is treated as NO VERDICT, exactly like an
          // auditor that threw — the `catch` below already fails open with the
          // reasoning "a flaky provider can't trap work in an unauditable
          // loop". The same situation reached by another route gets the same
          // answer.
          const verdictLine = text.trim();
          // provider fallbacks for a message with no usable text; treating one
          // of these as a "reason" is worse than treating it as nothing
          const PLACEHOLDER = /^\((tool call|no content|no output)\)$/i;
          const usable = verdictLine.length > 0 && !PLACEHOLDER.test(verdictLine);
          const decided = usable && /^(APPROVED|CHANGES-REQUIRED)\b/i.test(verdictLine);
          if (!decided) {
            await this.log.append("system_note", this.currentSession, this.currentBranch, {
              event: "audit-failed",
              detail: usable
                ? `auditor reply had no verdict: ${verdictLine.slice(0, 200)}`
                : "auditor returned no verdict",
            });
            await this.setGoalStatus("done");
            return;
          }
          const approved = /^APPROVED\b/i.test(verdictLine);
          const feedback = verdictLine.replace(/^(APPROVED|CHANGES-REQUIRED)\s*[:—-]?\s*/i, "").trim();
          // #51: storing the literal "(no detail)" made the UI draw a card
          // whose whole content was the absence of a reason, and that same
          // string landed in goal.md for the right panel. An empty string is
          // the honest value: the auditor returned a verdict and no reason,
          // which every consumer can already render as "label only".
          await this.setGoalAudit(approved ? "approved" : "changes-required", feedback);
          // `operatorFacing: true` — the verdict is written for the TIMELINE
          // only. The audit ran in its own side conversation (a tools-less call
          // over buildMessages() + an audit prompt), so it was never in
          // `this.messages` and must not come back through a restore: doing so
          // injected an assistant turn that answers nothing into the model's
          // context, which providers answer with a 200 and no choices (#50).
          // The rejection feedback reaches the agent as a real prompt below.
          await this.log.append("message", this.currentSession, this.currentBranch, {
            role: "assistant",
            operatorFacing: true,
            content: approved
              ? `✅ completion audit: APPROVED — ${feedback}`
              : `🔍 completion audit: CHANGES REQUIRED — ${feedback}`,
          });
          if (!approved) {
            // hand the gaps back to the worker as its next instruction.
            // #51: with the "(no detail)" placeholder gone, an empty verdict
            // would leave this prompt saying "address these gaps" and then
            // naming none — so restate the contract as the thing to re-check.
            const gaps = feedback.trim()
              ? feedback.slice(0, 2000)
              : `The auditor returned no specific gaps. Re-read the verification contract above and re-run it yourself, item by item, before finishing again:\n\n${this.goal.verify?.slice(0, 2000) || this.goal.text.slice(0, 2000)}`;
            this.pendingPrompts.push({
              source: "harness",
              text: `[harness] The completion audit REJECTED this finish. Address these gaps, then finish again with goalComplete=true:\n\n${gaps}`,
            });
            // #89: RETURN before the final message is written.
            //
            // Falling through emitted `final: true` while the goal was still
            // active — and that is the event onChildEvent forwards to the
            // parent. So a REJECTED completion told the parent the work was
            // DONE, and the child then sat retrying against a parent that had
            // already moved on and stopped listening.
            //
            // The goal stays active and the retry prompt is queued above, so
            // the loop simply continues; the parent's notification is deferred
            // until a finish that actually survives the audit.
            await this.captureRecentTurns();
            return;
          }
        } catch (err) {
          // auditor unavailable → fail open (record it, honor the finish) so a
          // flaky provider can't trap work in an unauditable loop
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "audit-failed",
            detail: String((err as Error).message).slice(0, 300),
          });
          await this.setGoalStatus("done");
        }
      } else {
        await this.setGoalStatus("done");
      }
    }
    const recent = await this.captureRecentTurns();
    await this.log.append("message", this.currentSession, this.currentBranch, {
      role: "assistant",
      final: true,
      content: String(args.summary ?? ""),
      ...(recent.length ? { recentContext: recent } : {}),
    });
  }

  private async maybeRequestProgress(): Promise<void> {
    const elapsedOk = Date.now() - this.lastProgressAt >= this.opts.progressIntervalMs;
    const activityOk =
      this.activityChars >= this.opts.progressMinChars ||
      this.turnsSinceProgress >= this.opts.progressMaxQuietTurns;
    if (!elapsedOk || !activityOk) return; // stalling provider → don't waste a turn asking
    // #95: remember that this boundary already carries an instruction, so the
    // auto-continue nudge can stand down instead of pairing with it.
    this.progressRequestedThisRound = true;
    this.lastProgressAt = Date.now();
    this.activityChars = 0;
    this.turnsSinceProgress = 0;
    const request = PROGRESS_REQUEST;
    // log both sides so a session restore replays this exchange faithfully
    await this.log.append("prompt", this.currentSession, this.currentBranch, {
      source: "harness",
      text: request,
    });
    this.messages.push({ role: "user", content: request });
    // Give the model the report_progress TOOL here. The old no-tools call
    // made the model answer in plain text while its own mental "did I report?"
    // ledger stayed unsolved — it then re-sent a voluntary report_progress
    // right after, and the timeline showed every requested report TWICE.
    const res = await this.llmCall(this.buildMessages(), allToolSpecs());
    const calls = res.message.tool_calls ?? [];
    // the assistant turn MUST enter history before its tool answers, or the
    // sequence [user, tool] is invalid and every later request 400s
    this.messages.push(res.message);
    await this.log.append("message", this.currentSession, this.currentBranch, {
      role: "assistant",
      content: res.message.content ?? "",
      reasoning: res.reasoning,
      ...(calls.length ? { toolCalls: calls.map((c) => ({ id: c.id, name: c.function.name })) } : {}),
      progressEcho: true,
    });
    let reported = calls.some((c) => c.function.name === "report_progress");
    for (const call of calls) {
      if (call.function.name === "report_progress") {
        await this.recordProgress(call.function.arguments);
      }
      this.messages.push({ role: "tool", tool_call_id: call.id, content: "progress recorded" });
      // log both sides so restores replay the exact exchange (meta-style)
      await this.log.append("tool_call", this.currentSession, this.currentBranch, {
        callId: call.id,
        name: call.function.name,
        args: safeParse(call.function.arguments),
        argsRaw: call.function.arguments,
      });
      await this.log.append("tool_result", this.currentSession, this.currentBranch, {
        callId: call.id,
        name: call.function.name,
        ok: true,
        durationMs: 0,
        result: "progress recorded",
      });
    }
    if (!reported && !(res.message.content ?? "").trim()) {
      // degenerate: neither a tool call nor prose — record a stub so the
      // operator sees SOMETHING at the requested moment
      await this.recordProgress(JSON.stringify({ freeform: "(no report produced)" }));
    }
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
    const est = this.contextSizeForBudgeting(); // floored — see #73
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
    // Tool-kind aware pruning (Claude Code MicroCompact style): high-volume,
    // REPRODUCIBLE results (file reads, shell, grep) are safe to clip because
    // the model can re-issue them; one-shot results (spawned agent reports,
    // web fetches) are kept — re-fetching is impossible or expensive.
    const PRUNABLE_TOOLS = new Set([
      "bash", "read_file", "list_dir", "grep", "glob", "write_file", "edit_file", "apply_patch",
      "bash_output",
    ]);
    let saved = 0;
    let count = 0;
    // callId → tool name, from the assistant turn that issued each call
    // (a tool result's PREVIOUS message is not reliably its caller when
    // parallel calls interleave)
    const callerTool = new Map<string, string>();
    for (const m of this.messages) {
      for (const t of m.tool_calls ?? []) callerTool.set(t.id, t.function.name);
    }
    for (let i = 0; i < boundary; i++) {
      const m = this.messages[i]!;
      const toolName = m.tool_call_id ? callerTool.get(m.tool_call_id) ?? "" : "";
      if (
        m.role === "tool" &&
        PRUNABLE_TOOLS.has(toolName) &&
        (m.content?.length ?? 0) > PRUNE_MIN
      ) {
        const len = m.content!.length;
        saved += len - 400;
        m.content = m.content!.slice(0, 400) + `\n…[pruned ${len} bytes of ${toolName || "tool"} output]`;
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
    const before = this.contextSizeForBudgeting(); // floored — see #73
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
    if (cut <= 0) return; // nothing safely compactable (phase never armed yet)

    const old = this.messages.slice(0, cut);
    const oldCount = old.length;
    let summary = "";
    let mode: "summarize" | "truncate" = "summarize";
    let summarizedCount = oldCount;
    let droppedCount = 0;
    // progress is visible: announce the phase up front, then stream the
    // summarizer's output as it generates (a long summarize used to look like
    // the agent silently hung — hundreds of thousands of tokens take a while)
    bus.emit("update", {
      kind: "compaction-progress",
      agentId: this.opts.id,
      phase: "summarizing",
      summarized: oldCount,
    } satisfies BusEvent);
    // #56: the START belongs on the timeline too. Only the right panel showed
    // compaction, and it reports the *outcome*; a long summarize (hundreds of
    // thousands of tokens) looks exactly like a hung agent on the timeline,
    // because the first `context-compacted` event is only appended once the
    // whole pass is over. Log the announcement as a visible system_note so
    // the operator sees WHERE the conversation was rewritten, even if the
    // pass later fails — `before`/`oldCount` are known at this point, and the
    // completion divider still carries the authoritative after-figures.
    await this.log.append("system_note", this.currentSession, this.currentBranch, {
      event: "context-compaction-started",
      tokensBefore: before,
      messages: oldCount,
      reason: force ? "manual" : "auto",
    });
    this.compactPhase = "summarizing";
    try {
      summary = await this.summarize(old, (text) => {
        bus.emit("update", {
          kind: "llm-delta",
          agentId: this.opts.id,
          text: `[compact] ${text}`,
          reasoning: "",
        } satisfies BusEvent);
      });
      this.compactPhase = "harvesting";
      bus.emit("update", { kind: "compaction-progress", agentId: this.opts.id, phase: "harvesting" } satisfies BusEvent);
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
      // Cut at a safe boundary, but never at index 0 — that would drop the
      // ENTIRE history (including the prompt just delivered) and leave the agent
      // with nothing. On a short history floor(oldCount/2) can round to 0, and
      // the old code then bailed out silently: compaction "ran", reported
      // nothing, and the context stayed over budget, so the very next provider
      // call overflowed — the "unstable after compact" report (#8). Always drop
      // at least one message, and say so.
      const halfCut = this.safeCut(Math.max(1, Math.floor(oldCount / 2)));
      if (halfCut <= 0) {
        // nothing in the prefix is safe to drop (e.g. it is all tool results).
        // Report it instead of pretending compaction happened.
        await this.log.append("system_note", this.currentSession, this.currentBranch, {
          event: "context-compaction-skipped",
          reason: "summarize failed and no safe prefix to truncate",
        });
        this.compactPhase = "";
        bus.emit("update", { kind: "compaction-progress", agentId: this.opts.id, phase: "done" } satisfies BusEvent);
        return;
      }
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
    // Post-compact file restore (Claude Code style): re-attach the most
    // recently read files so the model doesn't burn its first turns re-reading
    // exactly what it had in context a moment ago. Budget: 3 files × 400 lines.
    if (this.recentReads.length && mode === "summarize") {
      const restored: string[] = [];
      for (const rel of this.recentReads.slice(0, 3)) {
        try {
          const abs = safeJoin(this.opts.workspace, rel);
          const text = await fs.readFile(abs, "utf8");
          const head = text.split("\n").slice(0, 400).join("\n");
          restored.push(`--- ${rel}${text.length > head.length ? " (first 400 lines)" : ""} ---\n${head}`);
        } catch {
          /* file vanished since the read — skip */
        }
      }
      if (restored.length) {
        this.messages.splice(1, 0, {
          role: "user",
          content:
            `[harness] These files were recently read and are re-attached for continuity ` +
            `(they may have changed — re-read if precision matters):\n\n${restored.join("\n\n")}`,
        });
        this.recentReads = this.recentReads.slice(0, restored.length); // keep order, drop misses
      }
    }
    // #64 follow-up: compaction is the ONE point in a session where re-reading
    // AGENTS.md is both safe and expected.
    //
    // It is expected because compaction exists precisely to summarise work
    // against the CURRENT instructions: an agent that spent an hour under one
    // set of project rules, then compacted, would otherwise carry the old rules
    // over the summary and never see the edit.
    //
    // It is safe because the prefix-cache concern that motivates freezing the
    // prompt does not apply here. That concern is about a prompt changing
    // mid-turn, re-pricing the whole prefix on every call. A compaction
    // ALREADY rewrote the history the prompt sits on top of, so the cache is
    // being re-priced regardless — one more changed block costs nothing extra.
    //
    // Only AGENTS.md is re-read, deliberately. The workspace listing and the
    // skills catalogue stay frozen: both are a snapshot of the workspace as it
    // was, and re-listing mid-session would contradict the instruction to
    // "not list again what is already here". AGENTS.md is different — it is
    // instructions, not a listing, and a stale copy is actively misleading.
    const refreshed = this.reloadAgentsMd();
    if (refreshed) {
      await this.log.append("system_note", this.currentSession, this.currentBranch, {
        event: "agents-md-reloaded",
        bytes: refreshed.length,
      });
    }

    // the operator can inspect WHAT was remembered — a dedicated typed event
    // (not an agent message) keeps it out of the model's own voice
    await this.log.append("compaction", this.currentSession, this.currentBranch, {
      tokensBefore: before,
      tokensAfter: after,
      summarized: summarizedCount,
      dropped: droppedCount,
      mode,
      ...(summary ? { summary: String(summary).slice(0, 20_000) } : {}),
    });
    await this.log.append("system_note", this.currentSession, this.currentBranch, {
      event: "context-compacted",
      tokensBefore: before,
      tokensAfter: after,
      summarized: summarizedCount,
      dropped: droppedCount,
      mode,
    });
    this.compactPhase = "";
    bus.emit("update", { kind: "compaction-progress", agentId: this.opts.id, phase: "done" } satisfies BusEvent);
  }

  /** Ask the model for dense continuation notes over the compacted range. */
  private async summarize(old: ChatMessage[], onDelta?: (text: string) => void): Promise<string> {
    const full = old
      .map((m) => {
        const who = m.role === "tool" ? "tool" : m.role;
        const tc = m.tool_calls?.map((t) => `\n[calls ${t.function.name}(${t.function.arguments})]`).join("");
        return `${who}: ${m.content ?? ""}${tc}`;
      })
      .join("\n\n");
    // #127: this was a bare `.slice(-120_000)` — the TAIL only.
    //
    // The question the issue raises is the right one: when a compaction starts,
    // the context window opens dramatically, and the summarizer saw only the last
    // 120k characters of what it was asked to summarise. Anything older was not
    // summarised and not kept — it was silently DISCARDED. So the original user
    // requirement, which sits at the very front of the history, was the single
    // most likely thing to be lost, and losing it is the one failure compaction
    // cannot recover from: the summary is now the only record.
    //
    // Head + tail, with the seam marked so the model can tell a gap from a
    // boundary. The head is where the goal, the constraints and the original ask
    // live; the tail is where the recent state and any in-flight error do.
    const BUDGET = 120_000;
    const HEAD = Math.floor(BUDGET * 0.35);
    const TAIL = BUDGET - HEAD;
    let transcript: string;
    if (full.length <= BUDGET) {
      transcript = full;
    } else {
      transcript = [
        full.slice(0, HEAD),
        `\n\n[... ${full.length - BUDGET} characters elided from the middle of this history ...]\n\n`,
        full.slice(full.length - TAIL),
      ].join("");
    }
    const fn = this.opts.chatFn ?? chat;
    // Structured sections (Claude Code style): fixed headings survive MULTIPLE
    // successive compactions far better than free-form prose — each pass knows
    // where "pending tasks" vs "user messages" live, so nothing silently
    // merges away. The <analysis> scratchpad gives the model a thinking space;
    // it is stripped from the stored summary (formatCompactSummary).
    const res = await fn(
      this.opts.llm,
      [
        {
          role: "system",
          content:
            "You compress a coding agent's conversation into dense notes for it to continue working.\n\n" +
            "First think inside an <analysis> block: what mattered, what changed, what is unresolved.\n" +
            "Then output ONLY the following sections, each starting with its exact heading:\n\n" +
            "## Primary request and intent\n" +
            "## Key technical concepts\n" +
            "## Files and code sections\n" +
            "## Errors and fixes\n" +
            "## Problem solving\n" +
            "## All user messages\n" + // verbatim-ish: intent survives repeated compaction
            "## Pending tasks\n" +
            "## Current work\n" +
            "## Next step\n" +
            "## Durable lessons\n\n" +
            "Rules: be terse bullet points, no prose flourishes. Quote file paths and key numbers exactly. " +
            "All user messages are listed nearly verbatim — they carry intent that must survive every future compaction. " +
            'Durable lessons lists reusable insights worth keeping forever (gotchas, preferences, what worked); omit the section if empty. ' +
            "The <analysis> block is discarded before your notes are stored, so think freely there.",
        },
        { role: "user", content: `Conversation:\n\n${transcript}\n\nWrite the continuation notes now.` },
      ],
      [],
      undefined, // never abortable by stop(): losing the summary would lose history
      onDelta
        ? (s: { text: string; reasoning: string }) => onDelta(s.text)
        : undefined,
    );
    return this.formatCompactSummary(res.message.content ?? "");
  }

  /** strip the <analysis> scratchpad — it improves thinking but must not
      consume post-compact context tokens */
  private formatCompactSummary(raw: string): string {
    const m = raw.match(/<analysis>[\s\S]*?<\/analysis>\s*/);
    return m ? raw.slice(m[0].length).trim() : raw.trim();
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
    // Where the fork leaves the source branch. Recorded on the event AND used
    // to seed the new branch, so the two can never disagree.
    const fromEvent = fromEventId ?? this.log.lastEventId(parentBranch);
    // #69: the fork event must be appended under the SOURCE branch. Appending it
    // under the new one gave it parent:null (nothing had been written to that
    // branch yet), so lineageOf() walked an empty chain and a restart rebuilt
    // the fork with NO history at all — the same class of bug editPromptAt had,
    // fixed on one path only. editPromptAt already appends under the old
    // branch for exactly this reason.
    await this.log.append("fork", this.currentSession, parentBranch, {
      fromSession: this.currentSession,
      fromBranch: parentBranch,
      fromEvent,
      newBranch,
    });
    // Seed the new branch's parent to the point it leaves the source, so its
    // first event chains across instead of starting at parent:null.
    this.log.seedBranch(newBranch, fromEvent);
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
          "Replace the harness-managed goal text. Use when the objective itself changes — not for routine updates. " +
          "Optionally attach a verification contract (plain-text completion requirements); finish(goalComplete=true) " +
          "is then audited against it by an independent reviewer before the goal counts as done.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string" },
            verify: {
              type: "string",
              description:
                "completion requirements that must verifiably hold, e.g. 'npm test passes with zero failures; " +
                "the new endpoint appears in README'. Omit for no audit.",
            },
          },
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
          "Update the operator-visible task list (todo.md). PREFERRED: pass updates to check specific " +
          "items off as you finish them — cheap, surgical, no risk of mangling other sections. Only pass " +
          "content to rewrite the whole list when restructuring it. Call this promptly on every item you complete.",
        parameters: {
          type: "object",
          properties: {
            updates: {
              type: "array",
              description: "surgical checkbox flips — match items by their exact text in todo.md",
              items: {
                type: "object",
                properties: {
                  item: { type: "string", description: "checkbox item text (without the \"- [ ]\" marker)" },
                  done: { type: "boolean", description: "true = check off, false = reopen (default true)" },
                },
                required: ["item"],
              },
            },
            content: {
              type: "string",
              description: "full replacement markdown — only for restructures; prefer updates",
            },
          },
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
  // callId -> the tool_call entry on its assistant message (fast arg enrichment)
  const assistantCalls = new Map<string, { function: { name: string; arguments: string } }>();
  const rememberAssistantCalls = (m: ChatMessage) => {
    if (Array.isArray(m.tool_calls))
      for (const t of m.tool_calls) assistantCalls.set(t.id, t as never);
  };
  // meta answers are now logged as regular tool_results; the legacy progress
  // synthesizer below must not duplicate them
  const loggedResults = new Set(
    list.filter((e) => e.type === "tool_result").map((e) => String((e.data as Record<string, unknown>).callId ?? "")),
  );
  const bufferedUsers: string[] = [];
  // image attachments paired with buffered prompts (multimodal replay)
  const bufferedParts: { url: string }[][] = [];
  const flushUsers = () => {
    if (openCalls.size === 0) {
      const texts = bufferedUsers.splice(0);
      const parts = bufferedParts.splice(0);
      texts.forEach((text, i) => {
        const imgs = parts[i] ?? [];
        msgs.push(
          imgs.length
            ? {
                role: "user",
                content: text,
                content_parts: [
                  { type: "text", text },
                  ...imgs.map((im) => ({ type: "image_url" as const, image_url: { url: im.url } })),
                ],
              }
            : { role: "user", content: text },
        );
      });
    }
  };
  for (const e of list) {
    const d = e.data as Record<string, unknown>;
    if (e.type === "prompt" && typeof d.text === "string") {
      // restore image attachments so replays stay byte-identical with the
      // original request (prefix caches stay warm across restarts)
      const text: string = d.text;
      const imgs = Array.isArray(d.images) ? (d.images as { url: string }[]) : [];
      const mk = (): ChatMessage =>
        imgs.length
          ? {
              role: "user",
              content: text,
              content_parts: [
                { type: "text", text },
                ...imgs.map((i) => ({ type: "image_url" as const, image_url: { url: i.url } })),
              ],
            }
          : { role: "user", content: text };
      if (openCalls.size > 0) bufferedUsers.push(text), bufferedParts.push(imgs);
      else msgs.push(mk());
    } else if (e.type === "message") {
      // Operator-facing rows are TIMELINE content, not conversation: the live
      // loop never put them in `messages`, so a restore must not either.
      // `final` is the finish() summary; `operatorFacing` covers harness notes
      // such as the completion audit verdict. Replaying either produced a
      // history shape no live run emits, and a provider given that answers
      // 200 with zero choices (#50).
      if (d.final === true || d.operatorFacing === true) continue;
      const role = d.role === "assistant" ? "assistant" : "user";
      const content = typeof d.content === "string" ? d.content : "";
      const hasCalls = Array.isArray(d.toolCalls) && d.toolCalls.length > 0;
      // A blank assistant turn that issued NO tool calls is an artefact of a
      // kill mid-stream: the model streamed nothing, so the live run never had
      // this turn, yet the restore replays it as a real utterance. sanitize()
      // then rewrites blank assistant content to the literal "(no content)",
      // so the agent is told it previously said a sentence it never said — a
      // history shape no live run produces (#50). A blank turn that DID call
      // tools is legitimate and must stay, or its results are orphaned.
      if (role === "assistant" && !content && !hasCalls) continue;
      const m: ChatMessage = { role, content };
      if (hasCalls) {
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
      rememberAssistantCalls(m);
      msgs.push(m);
      } else if (e.type === "tool_call") {
        // enrich the preceding assistant tool_calls with real arguments —
        // prefer the provider's raw string so restored requests stay
        // byte-identical (prefix caches stay warm across restarts).
        // Indexed by call id: the old [...msgs].reverse().find() scanned the
        // whole message list per call — O(n²) on multi-thousand-event logs.
        let tc = assistantCalls.get(String(d.callId ?? ""));
        if (!tc) {
          const prev = [...msgs].reverse().find((x) => x.role === "assistant" && x.tool_calls?.some((t) => t.id === d.callId));
          tc = prev?.tool_calls?.find((t) => t.id === d.callId);
        }
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
    } else if (e.type === "compaction") {
      // A compaction REPLACED everything before this point with a summary.
      // Replaying the raw prefix as well resurrected the full pre-compact
      // history after every restart/fork (one live session came back at
      // ~580k tokens after a 580k→207k compaction): the model re-read weeks
      // of settled work it was told had been summarized, and its behavior
      // fell apart. Mirror the runtime transform instead — the summary note
      // becomes the history's head. Compactions only run at turn boundaries
      // (serialized on the run chain), so no tool batch can be split here.
      if (d.mode === "truncate") {
        // `dropped` IS the number of leading messages the live pass removed
        msgs.splice(0, Math.min(msgs.length, Number(d.dropped ?? 0)));
      } else {
        const summarized = Math.min(msgs.length, Number(d.summarized ?? 0) || msgs.length);
        const sum = typeof d.summary === "string" ? d.summary : "";
        msgs.splice(
          0,
          summarized,
          {
            role: "user",
            content:
              `[harness] Context was compacted: ${summarized} earlier messages were summarized. ` +
              "Goal and notes are managed by the harness (AGENTS.md / memory.md are injected into your prompt when present).\n\n" +
              `## Summary of earlier conversation\n${sum || "(summary unavailable)"}`,
          },
        );
      }
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
  {
    const texts = bufferedUsers.splice(0);
    const parts = bufferedParts.splice(0);
    texts.forEach((text, i) => {
      const imgs = parts[i] ?? [];
      msgs.push(
        imgs.length
          ? {
              role: "user",
              content: text,
              content_parts: [
                { type: "text", text },
                ...imgs.map((im) => ({ type: "image_url" as const, image_url: { url: im.url } })),
              ],
            }
          : { role: "user", content: text },
      );
    });
  }
  return msgs;
}
