import { promises as fs, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { EventLog, readEvents, type TeapotEvent } from "../log/events.ts";
import { chat, chatStream, type ChatFn, type ChatMessage, type LlmConfig } from "./llm.ts";
import { auditPrompt, parseAuditVerdict } from "./goal-audit.ts";
import { executeTool, toolSpecs, currentSkills, safeJoin, isContextOverflow, isRequestNodeLimit, hasRunningBgShells, hasRunningBgShellsFor, killBgShells, type ToolContext } from "./tools.ts";
import { effortChoosable } from "./llm.ts";
import { sessionTitleFrom } from "../session-title.ts";
import { mcp } from "./mcp-registry.ts";
import { flattenToolName } from "./mcp-registry.ts";
import { metaToolSpecs, META_TOOL_NAMES, type MetaToolName } from "./meta-tools.ts";
import { skillRootsFingerprint, foreignSkillRoots, type SkillDef } from "./skills.ts";
import { extractRules, enforceRules, type Rule, RULES_HEADING } from "./compact-rules.ts";
import { bus, type BusEvent } from "../bus.ts";

export const AUTO_CONTINUE_NUDGE =
  "[harness] " +
  "Continue working toward the current goal. If you are blocked, explain why briefly. " +
  "When the goal is genuinely met — or truly blocked — call finish() " +
  "(finish(goalComplete=true) when met, finish(goalComplete=false) when blocked) " +
  "instead of replying in prose; prose here does not stop the loop.";

export function autoContinueNudge(goalText: string): string {
  const goal = goalText.trim();
  if (!goal) return AUTO_CONTINUE_NUDGE;
  return `${AUTO_CONTINUE_NUDGE}\nCurrent goal:\n=====\n${goal.slice(0, 1500)}\n=====`;
}

export const PROGRESS_REQUEST =
  "[harness] Please give a brief progress report now: what you are doing, goal progress, " +
  "what you recently tried, any problems, and your next step. Keep it under 10 lines. " +
  "Record it with the report_progress TOOL (doing, goalStatus, recent, problems, next) — " +
  "call that tool; do NOT answer in prose, which would just duplicate this request.";

export type AgentStatus =
  | "idle"
  | "running"
  | "stopped"
  | "error"
  | "waiting"
  | "needs_operator";

export interface GoalState {
  text: string;
  status: "active" | "done" | "paused";
  updatedAt: string;
  verify?: string;
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
  sessionDir: string;
  progressIntervalMs?: number;
  progressMinChars?: number;
  progressMaxQuietTurns?: number;
  autoContinue?: boolean;
  continueDelayMs?: number;
  autoCompact?: boolean;
  shortContext?: boolean;
  reasoningEffort?: string;
  supportedParameters?: string[];
  supportedEfforts?: string[];
  maxConsecutiveToolErrors?: number;
  contextTokenBudget?: number;
  contextWindowTokens?: number;
  restoreSession?: boolean;
  onFirstUserPrompt?: (sessionId: string) => void;
  provider?: string;
  globalSkillsDir?: string;
  pluginSkillRoots?: { dir: string; source: string }[];
  bundledSkillsDir?: string;
  spawnDepth?: number;
  readOnlyTools?: boolean;
  maxTurnsPerRound?: number;
  maxConsecutiveIdleRounds?: number;
  maxAuditRejects?: number;
  onError?: "stop" | "retry";
  retryDelayMs?: number;
  llmRetryWaitsMs?: number[];
  parent?: string;
  chatFn?: ChatFn;
}

const KEEP_RECENT_TOKENS = 15_000;

const PRUNE_AT_SHARE = 0.95;

const SHORT_PRUNE_AT_SHARE = 0.6;
const SHORT_PRUNE_KEEP_CHARS = 200;

const SUMMARIZE_MIN_SHARE = 0.02;

const SUMMARIZE_MIN_TOKENS = 2_000;

const SUMMARIZE_OVERFLOW_RETRIES = 3;
const SUMMARIZE_SHRINK = 0.6;

const MAX_AUTO_COMPACT_FAILURES = 3;

const OVERFLOW_SHRINK_STEPS = [0.5, 0.35, 0.2] as const;

const COMPACT_INSTRUCTION = [
  "You compress a coding agent's conversation into dense notes for it to continue working.",
  "Condense the conversation ABOVE into a structured checkpoint so another model can",
  "resume the work with no loss of essential context.",
  "",
  "First think inside an <analysis> block: what mattered, what changed, what is unresolved.",
  "Then output ONLY the following sections, each starting with its exact heading:",
  "",
  "## Primary request and intent",
  "## Key technical concepts",
  "## Files and code sections",
  "## Errors and fixes",
  "## Problem solving",
  "## All user messages", 
  "## Pending tasks",
  "## Current work",
  "## Next step",
  "## Durable lessons",
  "## Hard constraints",
  "",
  "Rules: be terse bullet points, no prose flourishes. Quote file paths and key numbers exactly.",
  "All user messages are listed nearly verbatim — they carry intent that must survive every future compaction.",
  "Durable lessons lists reusable insights worth keeping forever (gotchas, preferences, what worked); omit the section if empty.",
  "Hard constraints lists EVERY rule the operator stated, one per line, each beginning with exactly `MUST`, `MUST NOT` or `SHOULD` — include rules that were already obeyed and rules from earlier in the conversation. Never drop one because it seems satisfied: a constraint that is not repeated is lost forever, and this section is the only place it survives.",
  "Output only the checkpoint text: do not call any tool, and do not mention this request or that the context was compacted.",
  "The <analysis> block is discarded before your notes are stored, so think freely there.",
].join("\n");

const UPDATE_INSTRUCTION = [
  "",
  "The notes you produced last time are above, framed as a checkpoint. This is an",
  "UPDATE: PRESERVE what is still true, ADD what the new messages establish, and",
  "REMOVE only what they resolve or supersede. Never drop a constraint or a user",
  "request just because the new messages do not repeat it: an unanswered request",
  "stays, an answered one goes. Return the FULL updated notes under the same headings.",
].join("\n");

const SUMMARY_OPEN = "<conversation_checkpoint>\n";
const SUMMARY_CLOSE = "\n</conversation_checkpoint>";

const AUDIT_READ_ONLY_TOOLS = new Set(["read_file", "list_dir", "grep", "bash"]);

const SYSTEM_TEMPLATE = `You are a coding agent working autonomously inside a workspace.

Most session state is not injected into prompts — fetch it with tools instead:
- get_goal() → current objective + status. Call at session start, after a
  compaction notice, or whenever you lose the thread.
- set_goal(text) → change the objective itself (not routine updates).
- finish(goalComplete=true, summary) → goal fully achieved.
- ask_user(question, options?) → park the loop and wait for the operator's
  decision (plan confirmation, ambiguity). One concrete question at a time.
- read_memory(query?) / add_memory(text) / forget_memory(query) / set_memory(content)
  → your durable notes (memory.md). add_memory appends and cannot lose earlier
  notes; forget_memory removes the lines matching a substring, so a stale note can
  be corrected instead of piling up; set_memory REPLACES the whole file. Pass a
  query to read_memory to search rather than dumping everything. Your prompt carries
  a DIGEST (headings and one line each) — the notes themselves are not in it, so
  read_memory(query) is how you actually get one.
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
  read_file numbers lines and can grep via its pattern option.
- **PREFER edit_file / apply_patch over text-replacement scripts** (python/sed
  one-liners). They find the target by content and are VALIDATED before writing:
  edit_file refuses a pattern that is not unique, so a match somewhere you did
  not intend cannot silently rewrite the wrong occurrence. A script has no such
  guard. MEASURED: a regex pass over a component rewrote 'grouped' to 'grouped()'
  inside CSS class STRINGS, which no typecheck can see (the string is still a
  valid string), and it took longer to repair than doing the edits one by one.
  A genuine bulk transform across many files (a rename, an import change) IS a
  job for a script — then keep the pattern specific and read the diff.
- **NEVER \`sleep\` to wait for anything.** Not alone, not as "a quick poll".
  A bash call with a sleep inside is one opaque command: the operator cannot
  interrupt it, cannot see whether anything is happening, and the whole turn is
  spent doing nothing. Two interruptible shapes instead:
    · long single-purpose work (CI, a release, a tarball appearing, a dev
      server, a watcher) → bash(background=true). It returns a job id at once
      and you are NOTIFIED when it exits, so keep working and let it report.
    · waiting on a condition you are actively watching → poll with a bounded
      deadline in ONE call, then stop.
  A fixed wait also cannot tell "finished 5 minutes ago" from "still running",
  which is how a turn gets wasted twice.
- When a loaded skill matches your task, follow its playbook.
- Turn proven procedures into skills: once something non-trivial worked well,
  save_skill(name, description, content, files=[{name, content}]) so future
  sessions can load_skill them — helper scripts go through files and are made
  executable automatically.
- LEAD with the answer or the action: no preamble ("Great question", "Let me…",
  "I'll now…") and no closing pleasantries ("Hope this helps", "let me know if…").
  The operator reads the first line and the last line — make those two carry what
  happened and what is next.
- For multi-step work, number the steps and keep ONE in progress at a time. When you
  are partway through, say which step finished and which is next; do not re-narrate
  the whole plan, and do not assume the operator remembers the previous turn.
- Report what now WORKS, concretely, rather than what you changed: "login works with
  magic links — try /login" beats "I made some changes to the auth flow".
- State errors as cause and fix ("test fails at a.spec.ts:42: expected 200, got 401 —
  missing auth header"), never as alarm ("uh oh", "there seems to be a problem").
- When you make meaningful progress, call report_progress. Its output is
  shown to the operator directly (rendered as markdown in the progress
  panel) — do NOT also repeat the same content as a chat message; end the
  turn right after the call (a short "reported." is fine).
- Be frugal: prefer small precise edits, avoid runaway loops.
- When the operator asks you to remember something, WRITE it with add_memory.
  Write the KIND of thing that stays true and saves work later: a decision and
  why, a gotcha that cost time, a command that works here, where you left off.
  Do not write a narrative of what you did — the log already has that.
- WHEN to consult your notes — a decision boundary, not "always search":
  skip it for a self-contained request (a one-line shell command, a simple
  rewrite, a question about the current file). Use it by DEFAULT when the task
  touches this workspace's history, conventions or prior choices; when the
  operator asks for consistency with earlier work; when the task is ambiguous in
  a way earlier context would settle; or when you are picking up something you
  started before. If unsure, do one quick pass.
- A quick pass is cheap and bounded: search the digest in your prompt with
  read_memory(query), open at most one or two of the notes that match, and stop.
  If nothing is relevant, carry on — do not keep searching, and do not read the
  whole file "just in case". An unread note is an unwritten note.`;

export const PLACEHOLDER_TEXT = /^\(.*\)$/;

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
  todo = "";
  private readyPromise: Promise<void> | null = null;
  stats = {
    turns: 0,
    toolCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    compactions: 0,
    startedAt: null as string | null,
    costUsd: 0 as number | undefined,
  };

  private opts: Required<Omit<AgentOptions, "chatFn" | "supportedParameters" | "supportedEfforts" | "llmRetryWaitsMs">> &
    Pick<AgentOptions, "supportedParameters" | "supportedEfforts" | "llmRetryWaitsMs"> & { chatFn?: ChatFn };
  private messages: ChatMessage[] = [];
  get conversation(): readonly ChatMessage[] {
    return this.messages;
  }

  get conversationForTest(): ChatMessage[] {
    return this.messages;
  }

  get llmConfig(): Readonly<LlmConfig> {
    return this.opts.llm;
  }

  get providerName(): string {
    return this.opts.provider;
  }
  private pendingPrompts: { source: string; text: string; images?: { url: string; name?: string }[]; id?: string }[] = [];
  private stopRequested = false;
  private windDownRequested = false;
  private wake: (() => void) | null = null;
  private parkedByTool = false;
  private preParkedStatus: { status: AgentStatus; reason: string } | null = null;
  private abort: AbortController | null = null;
  private toolAbort = new AbortController();
  private runChain: Promise<void> = Promise.resolve();
  private manualCompactBudget = false;
  private workspaceMissing = false;
  private lastProgressAt = Date.now();
  private lastUsage?: { input: number; output: number; cached?: number };
  modelPricing?: { prompt: number; completion: number };
  private compactedAtLen = 0;
  private pendingSubReport = "";
  private compactPhase = "";
  private awaitingUser = false;
  private activityChars = 0;
  private turnsSinceProgress = 0;
  private consecutiveToolErrors = 0;
  private consecutiveApiErrors = 0;
  private retrySleeping = false;
  private consecutiveIdleRounds = 0;
  private consecutiveAuditRejects = 0;
  private auditUnavailableStreak = 0;
  private auditAttempts = 0;
  private lastRejectedAudit: { feedback: string; attempt: number } | null = null;
  private preRejectionTurns: string[] = [];
  private lastAuditOutcome: {
    audited: boolean;
    verdict: string;
    attempt: number;
    previous?: { verdict: string; feedback: string };
  } | null = null;

  constructor(opts: AgentOptions) {
    this.opts = {
      progressIntervalMs: 10 * 60_000,
      progressMinChars: 4_000,
      progressMaxQuietTurns: 40,
      autoContinue: true,
      continueDelayMs: 15_000,
      autoCompact: true,
      reasoningEffort: "",
      supportedParameters: undefined as string[] | undefined,
      maxConsecutiveToolErrors: 5,
      maxTurnsPerRound: 200,
      maxAuditRejects: 3, 
      maxConsecutiveIdleRounds: 50,
      onError: "stop",
      retryDelayMs: 60_000,
      contextTokenBudget: 96_000,
      contextWindowTokens: 0,
      restoreSession: true,
      onFirstUserPrompt: () => {},
      globalSkillsDir: "",
      pluginSkillRoots: [],
      shortContext: false,
      bundledSkillsDir: "",
      spawnDepth: 0,
      readOnlyTools: false,
      parent: "",
      provider: "",
      ...opts,
    };
    this.manualCompactBudget = opts.contextTokenBudget !== undefined;
    if (this.opts.contextWindowTokens && !opts.contextTokenBudget) {
      this.opts.contextTokenBudget = Math.round(this.opts.contextWindowTokens * 0.75);
    }
    this.log = new EventLog(path.join(opts.sessionDir, "chat.jsonl"), opts.id);
    this.skillRoots = [
      { dir: path.join(opts.workspace, "skills"), source: "workspace" },
      ...(opts.globalSkillsDir ? [{ dir: opts.globalSkillsDir, source: "global" }] : []),
      ...(opts.pluginSkillRoots ?? []),
      ...foreignSkillRoots(opts.workspace),
      ...(opts.bundledSkillsDir ? [{ dir: opts.bundledSkillsDir, source: "bundled" }] : []),
    ];
    this.toolCtx = {
      cwd: opts.workspace,
      agentId: opts.id,
      stateDir: opts.sessionDir,
      defaultTimeoutMs: 120_000,
      maxOutputBytes: 60_000,
      skillRoots: this.skillRoots,
      signal: this.toolAbort.signal,
      readOnly: this.opts.readOnlyTools,
      onIdlePark: (reason) => this.parkForTool(reason),
      onIdleUnpark: () => this.unparkFromTool(),
      hasPendingPrompts: () => this.pendingPrompts.length > 0,
      onBackgroundExit: (info) => void this.onBackgroundJobExit(info),
      onFileRead: (p) => this.trackFileRead(p),
    };
    this.mainSession = path.basename(opts.sessionDir);
    this.currentSession = this.mainSession;
  }

  private skillRoots: { dir: string; source: string }[];
  private skillsCache: SkillDef[] = [];
  private skillsStamp = "";
  private lastCompactSummary?: string;
  private compactRules: Rule[] = [];
  setSessionTitle(title: string | undefined): void {
    this.sessionTitle = title?.trim() || undefined;
  }
  private sessionTitle?: string;
  private overflowRecoveries = 0;
  private consecutiveCompactFailures = 0;

  private memoryDigestText(): string {
    let text: string;
    try {
      text = readFileSync(this.memoryFile, "utf8");
    } catch {
      return ""; 
    }
    if (!text.trim()) return "";
    const MAX_CHARS = 1_400;
    const lines = text.split(/\r?\n/);
    const out: string[] = [];
    let used = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      if (/^<!--/.test(line) || /^_from:/.test(line)) continue;
      const isHeading = /^#{1,6}\s/.test(line);
      const isBullet = /^[-*]\s/.test(line);
      if (!isHeading && !isBullet) {
        if (!out.length) out.push(line.slice(0, 100));
        continue;
      }
      const rendered = isHeading ? line.slice(0, 90) : `  · ${line.slice(0, 80)}`;
      if (used + rendered.length > MAX_CHARS) {
        out.push(`(… ${lines.length} lines total — call read_memory(query) to search the rest)`);
        break;
      }
      out.push(rendered);
      used += rendered.length + 1;
    }
    return out.join("\n").trim();
  }

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
      if (stamp === this.skillsStamp) return; 
      this.skillsCache = await currentSkills(this.toolCtx);
      this.skillsStamp = stamp;
    } catch {
    }
  }

  private requestConfig(extra: Partial<LlmConfig> = {}): LlmConfig {
    return { ...this.opts.llm, sessionId: this.currentSession, ...extra };
  }

  private callLlm(
    messages: ChatMessage[],
    tools: ReturnType<typeof toolSpecs>,
    onDelta?: (snap: { text: string; reasoning: string }) => void,
  ) {
    const fn = this.opts.chatFn ?? chatStream;
    return fn(
      this.requestConfig({
        ...(this.opts.reasoningEffort ? { reasoningEffort: this.opts.reasoningEffort } : {}),
        ...(this.opts.supportedParameters
          ? { supportedParameters: this.opts.supportedParameters }
          : {}),
      }),
      messages,
      tools,
      this.abort?.signal,
      onDelta,
    );
  }

  opts_id(): string {
    return this.opts.id;
  }

  exportMessages(): ChatMessage[] {
    return [...this.messages];
  }

  importMessages(msgs: ChatMessage[]): void {
    this.messages = msgs;
    this.compactedAtLen = 0;
  }

  async setModelPricing(p?: { prompt: number; completion: number }): Promise<void> {
    const wasUndefined = !this.modelPricing;
    this.modelPricing = p;
    if (!p || !wasUndefined) return; 
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
    }
  }

  get workspace(): string {
    return this.opts.workspace;
  }

  get isGhost(): boolean {
    const exists = existsSync(this.workspace);
    if (exists) this.workspaceMissing = false;
    return this.workspaceMissing;
  }

  private async ensureWorkspace(): Promise<void> {
    if (!this.workspaceMissing) return;
    await fs.mkdir(this.opts.workspace, { recursive: true });
    this.workspaceMissing = false;
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
  }

  get compactBudgetIsManual(): boolean {
    return this.manualCompactBudget;
  }

  private contextSizeForBudgeting(): number {
    const estimated = this.estimateTokens();
    const reported = this.lastUsage?.input;
    if (reported === undefined) return estimated;
    if (!Number.isFinite(reported) || reported <= 0) return estimated;
    return Math.max(reported, Math.floor(estimated / 2));
  }

  isLive(): boolean {
    if (this.stopRequested) return false;
    return (
      this.status === "running" ||
      this.parkedByTool ||
      this.pendingPrompts.length > 0 ||
      this.compactPhase !== "" ||
      this.retrySleeping ||
      hasRunningBgShellsFor(this.toolCtx.cwd, this.opts.id) ||
      this.awaitingUser ||
      this.status === "needs_operator"
    );
  }

  pendingPromptTexts(): string[] {
    return this.pendingPrompts.map((p) => p.text);
  }

  isBusy(): boolean {
    if (this.stopRequested) return false;
    return (
      this.status === "running" ||
      this.status === "waiting" ||
      this.status === "needs_operator" ||
      this.parkedByTool ||
      this.compactPhase !== ""
    );
  }

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
    this.onBackgroundJobExitQueued(info);
  }

  private parkForTool(reason: string): boolean {
    if (this.parkedByTool) return true; 
    if (this.status !== "running") return false;
    if (this.pendingPrompts.length > 0) return false;
    this.parkedByTool = true;
    this.preParkedStatus = { status: this.status, reason: this.statusReason };
    this.status = "waiting";
    this.statusReason = `${reason} — send a message to take over; resumes by itself`;
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
    return true;
  }

  private unparkFromTool(): void {
    if (!this.parkedByTool) return;
    this.parkedByTool = false;
    const prev = this.preParkedStatus;
    this.preParkedStatus = null;
    if (!this.stopRequested) {
      this.status = prev?.status ?? "running";
      bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
    }
  }

  get llm(): LlmConfig {
    return this.opts.llm;
  }

  setLlmConfig(llm: LlmConfig): void {
    this.opts.llm = llm;
  }

  async init(): Promise<void> {
    await this.log.load();
    await this.migrateMemoryToAgentScope();
    this.workspaceMissing = !(await fs
      .stat(this.workspace)
      .then(() => true)
      .catch(() => false));
    await this.migrateGoalFromWorkspace();
    const stored = await this.readGoalStore();
    this.goal = stored ?? { text: "", status: "active", updatedAt: new Date().toISOString() };
    this.todo = await fs.readFile(this.todoFile, "utf8").catch(() => "");
    if (this.opts.restoreSession) {
      this.status = "stopped";
      this.statusReason = "session not loaded — select it or send a prompt";
      bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
    }
  }

  ensureReady(): Promise<void> {
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

  async load(): Promise<void> {
    await this.ensureReady();
  }

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

  private get goalFile(): string {
    return path.join(this.opts.sessionDir, "goal.md");
  }

  private get memoryFile(): string {
    const perSession = path.join(this.opts.sessionDir, "memory.md");
    const parent = path.dirname(this.opts.sessionDir);
    return path.basename(parent) === "sessions" ? path.join(parent, "memory.md") : perSession;
  }

  private get legacyMemoryFile(): string {
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

  private async migrateGoalFromWorkspace(): Promise<void> {
    const legacy = path.join(this.workspace, "GOAL.md");
    let wsText: string;
    try {
      wsText = await fs.readFile(legacy, "utf8");
    } catch {
      return; 
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

  private async migrateMemoryToAgentScope(): Promise<void> {
    const from = this.legacyMemoryFile;
    const to = this.memoryFile;
    if (from === to) return;
    let legacy: string;
    try {
      legacy = (await fs.readFile(from, "utf8")).trim();
    } catch {
      return; 
    }
    if (!legacy) {
      await fs.rm(from, { force: true }).catch(() => {});
      return;
    }
    try {
      const existing = (await fs.readFile(to, "utf8").catch(() => "")).trim();
      const merged =
        (existing ? `${existing}\n` : "") +
        `<!-- migrated from session ${path.basename(this.opts.sessionDir)} -->\n${legacy}\n`;
      await fs.writeFile(to, merged, "utf8");
      await fs.rm(from, { force: true });
      console.log(`[teapot] memory: migrated ${legacy.length} bytes to ${path.basename(to)} (agent scope)`);
    } catch {
    }
  }

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
    if (parentEvents.some((e) => e.type === "sub_fork")) {
      parentEvents = await this.spliceSubForkPrefix(parentEvents, parentDir);
    }
    if (parentEvents.length === 0) {
      console.warn(`[teapot] sub_fork: parent session ${d.parentSession} unreadable — starting without inherited context`);
      return own;
    }

    const byId = new Map(parentEvents.map((e) => [e.id, e]));
    const tip = byId.get(d.upToEvent);
    if (!tip) {
      console.warn(`[teapot] sub_fork: fork point ${d.upToEvent} not found in ${d.parentSession}`);
      return own;
    }
    const prefix: TeapotEvent[] = [];
    for (let cur: TeapotEvent | undefined = tip; cur; cur = cur.parent ? byId.get(cur.parent) : undefined) {
      if (prefix.some((p) => p.id === cur!.id)) break; 
      prefix.push(cur);
    }
    prefix.reverse();
    while (prefix.length && prefix[0].type === "fork") prefix.shift();
    return [...prefix, ...own.filter((e) => e !== header)];
  }

  private async restoreFromLog(): Promise<void> {
    const own = await readEvents(this.log.filePath);
    if (own.length === 0) return;
    const events = await this.spliceSubForkPrefix(own);
    const lineage = lineageOf(events);
    if (!lineage.length) return;
    const last = lineage[lineage.length - 1];
    const msgs = rebuildMessagesFrom(lineage);

    for (const e of own) {
      if (this.sessionTitle === undefined && e.type === "prompt" && (e.data as { source?: string })?.source === "user") {
        this.sessionTitle = sessionTitleFrom((e.data as { text?: string })?.text) ?? undefined;
      }
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
      } else if (e.type === "system_note") {
        const d = e.data as { event?: string; rules?: unknown };
        if (d.event === "context-compacted") this.stats.compactions++;
        if (d.event === "compaction-rules" && Array.isArray(d.rules)) {
          const seeded = d.rules
            .map((line) => extractRules(`${RULES_HEADING}\n- ${String(line)}`)[0])
            .filter((r): r is Rule => !!r);
          if (seeded.length) this.compactRules = seeded;
        }
      } else if (e.type === "compaction") {
        const d = e.data as { summary?: unknown };
        if (typeof d.summary === "string" && d.summary) this.lastCompactSummary = d.summary;
      }
    }
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
      await this.maybePrune(true);

      await this.answerUnansweredRestoredCalls();

      await this.log.append("system_note", this.currentSession, this.currentBranch, {
        event: "session-restored",
        branch: last.branch,
        messages: msgs.length,
      });
    }
  }

  async compactNow(): Promise<{ ran: boolean }> {
    const ran = await this.enqueue(async () => {
      await this.ensureReady();
      const before = this.stats.compactions;
      await this.maybeCompact(true);
      return this.stats.compactions > before;
    });
    return { ran };
  }

  async editPromptAt(
    eventId: string,
    text: string,
    tail: "discard" | "summarize",
  ): Promise<{ droppedEvents: number; branch: string }> {
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
    const dropped = lineage.slice(tIdx); 

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
      }
    }
    msgs.push({ role: "user", content: text });

    const newBranch = `br${this.branchCount()}${Date.now().toString(36).slice(-4)}`;
    await this.quiesceForHistoryEdit();
    await this.log.append("fork", this.currentSession, this.currentBranch, {
      fromSession: this.currentSession,
      fromBranch: this.currentBranch,
      fromEvent: kept.at(-1)?.id ?? null,
      newBranch,
      reason: "prompt-edited",
      droppedEvents: dropped.length,
      tailMode: tail,
    });
    const cutPoint = kept.at(-1)?.id ?? null;
    this.log.seedBranch(newBranch, cutPoint);
    this.currentBranch = newBranch;
    this.messages = msgs;
    await this.log.append("prompt", this.currentSession, this.currentBranch, { source: "user", text });
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
    return { droppedEvents: dropped.length, branch: newBranch };
  }

  private async quiesceForHistoryEdit(): Promise<void> {
    if (!this.stopRequested) {
      this.stopRequested = true;
      this.abort?.abort(); 
      this.toolAbort.abort(); 
      this.wake?.(); 
      try {
        await this.settled();
      } catch {
      }
      this.parkedByTool = false;
      this.pendingPrompts = []; 
      this.stopRequested = false;
      if (this.toolAbort.signal.aborted) {
        this.toolAbort = new AbortController();
        (this.toolCtx as { signal: AbortSignal }).signal = this.toolAbort.signal;
      }
      this.bgExits = []; 
    }
  }

  private parseGoalFile(text: string): GoalState {
    const all = [...text.matchAll(/status:\s*(\w+)/gi)];
    const last = all[all.length - 1]?.[1];
    const status = last === "done" ? "done" : last === "paused" ? "paused" : "active";
    let body = text.trim();
    for (let i = 0; i < 4; i++) {
      const stripped = body.replace(/\n+(?:status|updated):[^\n]*$/i, "").trimEnd();
      if (stripped === body) break;
      body = stripped;
    }
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
    this.consecutiveAuditRejects = 0;
    this.auditUnavailableStreak = 0;
    this.lastRejectedAudit = null;
    this.lastAuditOutcome = null;
    this.auditAttempts = 0;
    await this.writeGoalFile();
    await this.log.append("goal", this.currentSession, this.currentBranch, { event: "set", text });
  }

  async setTodo(text: string, by = "human"): Promise<void> {
    this.todo = text;
    await fs.writeFile(this.todoFile, text, "utf8");
    await this.log.append("todo", this.currentSession, this.currentBranch, { event: "set", by });
  }

  async updateTodoItems(
    updates: { item: string; done?: boolean; action?: "done" | "reopen" | "add" | "remove" }[],
    by = "agent",
  ): Promise<string> {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const lines = this.todo.split("\n");
    let matched = 0;
    let added = 0;
    let removed = 0;
    const unmatched: string[] = [];
    for (const u of updates) {
      const action = u.action ?? (u.done === false ? "reopen" : "done");
      const target = norm(u.item);
      let idx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i]!.match(/^(\s*[-*+] \[)([ xX])(\].*)$/);
        if (!m) continue;
        if (norm(m[3]!.slice(1)) === target) {
          idx = i;
          break;
        }
      }
      if (action === "add") {
        if (idx !== -1) {
          unmatched.push(`${u.item} (already present — not added twice)`);
          continue;
        }
        lines.push(`- [ ] ${u.item.trim()}`);
        added++;
        continue;
      }
      if (idx === -1) {
        unmatched.push(u.item);
        continue;
      }
      if (action === "remove") {
        lines.splice(idx, 1);
        removed++;
        continue;
      }
      const checked = action === "done";
      lines[idx] = lines[idx]!.replace(/^(.* \[)[ xX](\].*)$/, (_s, a, b) => `${a}${checked ? "x" : " "}${b}`);
      matched++;
    }
    if (matched > 0 || added > 0 || removed > 0) {
      while (lines.length > 1 && lines[lines.length - 1]!.trim() === "" && lines[lines.length - 2]!.trim() === "")
        lines.pop();
      this.todo = lines.join("\n");
      await fs.writeFile(this.todoFile, this.todo, "utf8");
      await this.log.append("todo", this.currentSession, this.currentBranch, {
        event: "items",
        by,
        matched,
        ...(added ? { added } : {}),
        ...(removed ? { removed } : {}),
        ...(unmatched.length ? { unknown: unmatched } : {}),
      });
    }
    const parts: string[] = [];
    if (matched) parts.push(`${matched} item(s) updated`);
    if (added) parts.push(`${added} item(s) added`);
    if (removed) parts.push(`${removed} item(s) removed`);
    if (!parts.length) parts.push("nothing changed");
    if (unmatched.length)
      parts.push(
        `NOT FOUND in todo.md: ${unmatched.map((s) => `"${s}"`).join(", ")} — check get_todo and retry with the exact wording, or use action:"add" to create it`,
      );
    return parts.join(". ");
  }

  async setGoalStatus(
    status: GoalState["status"],
    by: "operator" | "auditor" | "agent" = "operator",
  ): Promise<void> {
    this.goal = { ...this.goal, status, updatedAt: new Date().toISOString() };
    await this.writeGoalFile();
    await this.log.append("goal", this.currentSession, this.currentBranch, {
      event: "status",
      status,
      by,
    });
  }

  async setGoalVerify(verify: string): Promise<void> {
    this.goal = { ...this.goal, verify: verify.slice(0, 4000), updatedAt: new Date().toISOString() };
    await this.writeGoalFile();
    await this.log.append("goal", this.currentSession, this.currentBranch, {
      event: "verify-set",
      verify: verify.slice(0, 2000),
    });
  }

  async setGoalAudit(verdict: "approved" | "changes-required", feedback: string): Promise<void> {
    this.goal = {
      ...this.goal,
      updatedAt: new Date().toISOString(),
      audit: { verdict, feedback: feedback.slice(0, 4000), at: new Date().toISOString() },
    };
    if (verdict === "approved") this.goal.status = "done";
    const reopened = verdict !== "approved" && this.goal.status === "done";
    if (reopened) {
      this.goal.status = "active";
      await this.log.append("goal", this.currentSession, this.currentBranch, {
        event: "status",
        status: "active",
        by: "auditor",
      });
    }
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
      status: this.status === "idle" && this.isLive() ? "waiting" : this.status,
      statusReason: this.statusReason,
      live: this.isLive(),
      workspace: this.workspace,
      workspaceMissing: this.isGhost,
      session: this.currentSession,
      ...(this.sessionTitle ? { sessionTitle: this.sessionTitle } : {}),
      branch: this.currentBranch,
      goal: {
        status: this.goal.status,
        text: this.goal.text,
        ...(this.goal.verify ? { verify: this.goal.verify.slice(0, 1000) } : {}),
        ...(this.goal.audit ? { audit: this.goal.audit } : {}),
      },
      latestProgress: this.latestProgress,
      stats: { ...this.stats, costUsd: this.modelPricing ? this.stats.costUsd : undefined },
      model: this.opts.llm.model,
      provider: this.opts.provider,
      ...(this.opts.reasoningEffort ? { reasoningEffort: this.opts.reasoningEffort } : {}),
      /**
       * Offer the control unless the catalog SAYS the model cannot reason.
       *
       * `effortChoosable(undefined)` is `true` on purpose: a model missing from models.dev is
       * UNKNOWN, not unsupported, and the wire recovers from a rejected `reasoning_effort`
       * (`isEffortUnsupported`). The previous rule gated this on OpenRouter alone, which hid the
       * control for every other provider whose model did support it.
       */
      effortSupported: this.opts.supportedEfforts?.length ? true : effortChoosable(undefined),
      ...(this.opts.supportedEfforts?.length ? { effortOptions: this.opts.supportedEfforts } : {}),
      sessionDir: this.opts.sessionDir,
      ctx: {
        usedTokens: this.lastUsage?.input ?? this.estimateTokens(),
        compactAt: this.opts.contextTokenBudget,
        compactAtIsManual: this.compactBudgetIsManual,
        window: this.opts.contextWindowTokens || 0,
        ...(this.compactPhase ? { compacting: this.compactPhase } : {}),
      },
      pendingPrompts: this.pendingPrompts.length,
      pendingPromptIds: this.pendingPrompts.map((p) => p.id).filter((x): x is string => !!x).slice(0, 64),
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
      todo: this.todo.slice(0, 32_000), 
      parent: this.opts.parent,
      awaiting: this.awaitingUser,
      autoContinue: this.opts.autoContinue,
      autoCompact: this.opts.autoCompact,
    };
  }

  enqueuePrompt(
    text: string,
    source = "user",
    images?: { url: string; name?: string }[],
  ): string {
    if (this.parkedByTool) {
      this.toolAbort.abort();
      this.toolAbort = new AbortController();
      (this.toolCtx as { signal: AbortSignal }).signal = this.toolAbort.signal;
    }
    this.unparkFromTool();
    this.wake?.();
    if (source === "user") {
      this.lastProgressAt = Date.now();
      this.activityChars = 0;
      this.turnsSinceProgress = 0;
    }
    const promptId =
      source === "user" ? `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` : "";
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
      .then(() => {
        if (source === "user") this.opts.onFirstUserPrompt?.(this.currentSession);
      })
      .then(() =>
        bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent),
      )
      .catch(() => {});
    return promptId;
  }

  cancelPrompt(promptId: string): string | null {
    const i = this.pendingPrompts.findIndex((p) => p.id === promptId);
    if (i === -1) return null; 
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

  private drainPendingPrompts(): void {
    this.drainBackgroundExits();
    for (const p of this.pendingPrompts.splice(0)) {
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
        this.undeliveredPrompts.push({ id, preview: p.text.slice(0, 80) });
      }
    }
  }

  private deliveredPrompts: string[] = [];
  private undeliveredPrompts: { id: string; preview: string }[] = [];

  private async markDeliveredPrompts(): Promise<void> {
    if (this.undeliveredPrompts.length === 0) return;
    const pending = this.undeliveredPrompts;
    this.undeliveredPrompts = [];
    for (const { id, preview } of pending) {
      this.deliveredPrompts.push(id);
      if (this.deliveredPrompts.length > 64) this.deliveredPrompts.shift();
      await this.log.append("system_note", this.currentSession, this.currentBranch, {
        event: "prompt-delivered",
        promptId: id,
        preview,
      });
    }
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
  }

  private bgExits: { id: string; code: number | null; cmd: string; durationMs: number; outputTail: string }[] = [];

  private onBackgroundJobExitQueued(info: { id: string; code: number | null; cmd: string; durationMs: number; outputTail: string }): void {
    this.bgExits.push(info);
    if (this.bgExits.length > 32) this.bgExits.shift(); 
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
    const windingDown = this.status === "running";
    if (!this.stopRequested && (this.status === "idle" || windingDown)) {
      void this.enqueue(async () => {
        if (this.stopRequested) return; 
        if (this.status === "idle") this.start(`background job ${info.id} finished`);
      });
    }
  }

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

  start(reason = "start"): void {
    const pendingStop = this.stopRequested;
    if (this.status === "running" && !pendingStop) return;
    this.stopRequested = false;
    this.stopSeq++;
    this.awaitingUser = false; 
    void this.enqueue(async () => {
      await this.ensureReady(); 
      this.setStatus("running", reason);
      this.stats.startedAt ??= new Date().toISOString();
    });
    void this.enqueue(() => this.loop());
  }

  stop(reason = "stopped by user"): void {
    this.stopRequested = true;
    this.parkedByTool = false; 
    this.abort?.abort();
    this.toolAbort.abort();
    killBgShells(this.toolCtx.cwd);
    this.wake?.();
    const stopSeq = ++this.stopSeq;
    void this.enqueue(() => {
      if (this.stopSeq !== stopSeq) return Promise.resolve();
      this.setStatus("stopped", reason);
      return Promise.resolve();
    });
  }

  private stopSeq = 0;
  private progressRequestedThisRound = false;
  private nudgedAtTurn = -1;

  onControlStatusChange: ((agentId: string, status: AgentStatus) => void) | null = null;

  private setStatus(s: AgentStatus, reason = ""): void {
    const prev = this.status;
    this.status = s;
    this.statusReason = reason;
    if (prev !== s) {
      try {
        this.onControlStatusChange?.(this.opts.id, s);
      } catch {
      }
      void this.log.append("state", this.currentSession, this.currentBranch, {
        from: prev,
        to: s,
        reason,
      });
    }
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
  }

  private async loop(): Promise<void> {
    while (!this.stopRequested && !this.windDownRequested) {
      try {
        if (this.toolAbort.signal.aborted) {
          this.toolAbort = new AbortController();
          (this.toolCtx as { signal: AbortSignal }).signal = this.toolAbort.signal;
        }
        this.consecutiveToolErrors = 0;
        this.consecutiveApiErrors = 0;
        const turnsAtStart = this.stats.turns;
        let finished = await this.runTurnsUntilIdle();
        const cap = Math.max(0, this.opts.maxTurnsPerRound ?? 200);
        if (!finished && cap > 0 && this.stats.turns - turnsAtStart >= cap && !this.stopRequested) {
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "round-turn-cap",
            turns: cap,
          });
        }
        if (this.stopRequested) break;
        if (this.consecutiveAuditRejects >= (this.opts.maxAuditRejects ?? 3)) {
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "audit-retry-cap",
            rejects: this.consecutiveAuditRejects,
            detail: "the completion audit rejected the same goal repeatedly ? stopping to avoid an unbounded retry loop (#128)",
          });
          this.consecutiveAuditRejects = 0;
          break;
        }
        if (this.pendingPrompts.length) continue;
        if (hasRunningBgShells(this.toolCtx.cwd)) {
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "auto-continue-suppressed",
            reason: "background job still running — the agent resumes when it exits",
          });
          break;
        }
        if (this.pendingSubReport) {
          const report = this.pendingSubReport;
          this.pendingSubReport = "";
          if (!finished) {
            await this.handleFinish(
              JSON.stringify({ goalComplete: true, summary: report }),
            );
            finished = true; 
          }
        }
        if (finished) this.consecutiveIdleRounds = 0;
        if (
          finished ||
          !this.opts.autoContinue ||
          this.goal.status !== "active" ||
          !this.goal.text.trim()
        )
          break;
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
        if (this.progressRequestedThisRound) {
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "auto-continue-suppressed",
            detail: "a progress report was already requested this round (#95) — the round that carried it already continues the work, so no nudge is added and the loop goes on",
          });
          this.progressRequestedThisRound = false;
          continue;
        }
        const isSub = !!this.opts.parent;
        const nudge = isSub
          ? `[harness] Auto-nudge. Re-anchor on YOUR task — and only that:\n\n${this.goal.text.slice(0, 1500)}\n\nThe inherited conversation is reference only; other agents own any older tasks in it. If your task is complete, call finish() now instead of continuing. If blocked, explain why briefly and finish().`
          : autoContinueNudge(this.goal.text);
        await this.log.append("prompt", this.currentSession, this.currentBranch, {
          source: "harness",
          text: nudge,
        });
        this.messages.push({ role: "user", content: nudge });
        this.nudgedAtTurn = this.stats.turns + 1;
      } catch (err) {
        const name = (err as Error).name;
        if (this.stopRequested || name === "AbortError" || name === "StopRequested" || name === "WaitForUser") break;
        const msg = (err as Error).message ?? String(err);
        await this.log.append("error", this.currentSession, this.currentBranch, { message: msg });
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
          this.retrySleeping = true;
          try {
            await this.sleepInterruptible(wait);
          } finally {
            this.retrySleeping = false;
          }
          if (this.stopRequested) break;
          this.setStatus("running", "retrying");
          continue; 
        }
        this.setStatus("error", msg.slice(0, 300));
        return;
      }
    }
    if (!this.stopRequested && !this.awaitingUser) this.setStatus("idle", "round complete");
  }
  private async llmCall(
    messages: ChatMessage[],
    tools: ReturnType<typeof toolSpecs>,
    onDelta?: (snap: { text: string; reasoning: string }) => void,
  ) {
    const maxAttempts = 4;
    const waits = this.opts.llmRetryWaitsMs ?? [5_000, 5_000, 30_000];
    for (let attempt = 1; ; attempt++) {
      if (this.stopRequested) throw Object.assign(new Error("stopped"), { name: "StopRequested" });
      this.abort = new AbortController();
      if (onDelta)
        bus.emit("update", {
          kind: "llm-delta",
          agentId: this.opts.id,
          sessionId: this.currentSession,
          text: "",
          reasoning: "",
        } satisfies BusEvent);
      if (attempt === 1) await this.markDeliveredPrompts();
      try {
        return await this.callLlm(messages, tools, onDelta);
      } catch (err) {
        this.abort = null;
        const name = (err as Error).name;
        if (name === "StopRequested" || name === "AbortError" || this.stopRequested) throw err;
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

  private metaHandlers: Record<
    MetaToolName,
    (call: { id: string; function: { name: string; arguments: string } }, m: ChatMessage) => Promise<"next" | "end">
  > = {
    finish: async (call, m) => {
      this.pendingSubReport = ""; 
      await this.answerMeta(call, "(completion submitted for audit)");
      await this.handleFinish(call.function.arguments);
      try {
        const running = (this.toolCtx.subAgents?.list?.() ?? []).filter((k) => k.status === "running");
        if (running.length)
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "subs-still-running",
            detail: running.map((k) => `${k.id} (${k.status})`).join(", "),
          });
      } catch {  }
      await this.answerMeta(
        call,
        this.goal.status === "done" ? "(goal complete)" : "(round ended)",
      );
      await this.answerUnansweredToolCalls(m);
      return "end";
    },
    report_progress: async (call, m) => {
      await this.recordProgress(call.function.arguments);
      await this.answerMeta(call, "progress recorded");
      return "next";
    },
    set_goal: async (call, m) => {
      const a = safeParse(call.function.arguments);
      const text = String(a.text ?? "").trim();
      if (text) await this.setGoal(text);
      if (typeof a.verify === "string" && a.verify.trim())
        await this.setGoalVerify(a.verify.trim().slice(0, 4000));
      await this.answerMeta(
        call,
        text ? "goal updated" : "empty goal rejected",
      );
      return "next";
    },
    get_goal: async (call, m) => {
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
      return "next";
    },
    ask_user: async (call, m) => {
      const a = safeParse(call.function.arguments);
      const question = String(a.question ?? "").slice(0, 2000);
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
      this.setStatus("needs_operator", question.slice(0, 80));
      await this.answerUnansweredToolCalls(m);
      throw Object.assign(new Error("waiting for user"), { name: "WaitForUser" });
    },
    get_todo: async (call, m) => {
      await this.answerMeta(
        call,
        this.todo.trim() || "(todo.md is empty — no task list yet)",
      );
      return "next";
    },
    set_todo: async (call, m) => {
      const a = safeParse(call.function.arguments);
      const ACTIONS = new Set(["done", "reopen", "add", "remove"] as const);
      const updates = Array.isArray(a.updates)
        ? a.updates
            .map((u: unknown) => {
              const o = (u ?? {}) as { item?: unknown; done?: unknown; action?: unknown };
              const raw = String(o.action ?? "");
              const action = ACTIONS.has(raw as never)
                ? (raw as "done" | "reopen" | "add" | "remove")
                : undefined;
              return {
                item: String(o.item ?? ""),
                done: o.done !== false,
                ...(action ? { action } : {}),
              };
            })
            .filter((u: { item: string }) => u.item.trim())
        : [];
      if (updates.length > 0) {
        const note = await this.updateTodoItems(updates, "agent");
        await this.answerMeta(call, `${note} (visible to the operator)`);
        return "next";
      }
      const content = String(a.content ?? "").slice(0, 32_000);
      if (!content.trim()) {
        await this.answerMeta(
          call,
          "nothing to do: pass updates:[{item, action}] to change items " +
            "(action: done | reopen | add | remove), or content to replace the whole list",
        );
        return "next";
      }
      await this.setTodo(content, "agent");
      await this.answerMeta(call, "task list replaced (visible to the operator)");
      return "next";
    },
    get_feedback: async (call, m) => {
      const fb = await fs.readFile(this.feedbackFile, "utf8").catch(() => "");
      this.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: fb.trim() || "(no feedback rules recorded yet)",
      });
      return "next";
    },
    add_feedback: async (call, m) => {
      const a = safeParse(call.function.arguments);
      const rule = String(a.rule ?? "").trim().slice(0, 500);
      if (!rule) {
        this.messages.push({ role: "tool", tool_call_id: call.id, content: "rule required" });
        return "next";
      }
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
      return "next";
    },
    record_decision: async (call, m) => {
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
        return "next";
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
      return "next";
    },
    get_decisions: async (call, m) => {
      const dec = await fs.readFile(this.decisionsFile, "utf8").catch(() => "");
      this.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: dec.trim() || "(decisions.md is empty — no decisions recorded yet)",
      });
      return "next";
    },
    read_memory: async (call, m) => {
      const a = safeParse(call.function.arguments);
      const query = String(a.query ?? "").trim();
      const mem = await fs.readFile(this.memoryFile, "utf8").catch(() => "");
      if (!mem.trim()) {
        await this.answerMeta(call, "(memory.md is empty — nothing noted yet)");
        return "next";
      }
      if (!query) {
        await this.answerMeta(call, mem.trim());
        return "next";
      }
      const needle = query.toLowerCase();
      const lines = mem.split(/\r?\n/);
      const hits = lines.filter((line) => line.toLowerCase().includes(needle));
      const headingAt = (idx: number): string => {
        for (let i = idx; i >= 0; i--) {
          const l = lines[i]!.trim();
          if (/^#{1,6}\s/.test(l)) return l;
        }
        return "";
      };
      const provenanceAt = (idx: number): string => {
        for (let i = idx; i >= Math.max(0, idx - 6); i--) {
          const l = lines[i]!.trim();
          if (/^_from:/.test(l)) return l.replace(/^_|_$/g, "");
        }
        return "";
      };
      const rendered = hits.slice(0, 40).map((line) => {
        const idx = lines.indexOf(line);
        const head = headingAt(idx);
        const prov = provenanceAt(idx);
        const where = [head, prov].filter(Boolean).join(" · ");
        return where ? `${line}\n    ↳ ${where}` : line;
      });
      await this.answerMeta(
        call,
        hits.length
          ? `${hits.length} line(s) matching ${JSON.stringify(query)}` +
            `${hits.length > 40 ? ` (showing the first 40)` : ""}:\n${rendered.join("\n")}`
          : `(no line in memory.md matches ${JSON.stringify(query)} — ${mem.split(/\r?\n/).length} lines searched; call read_memory with no query to see all of it)`,
      );
      return "next";
    },
    list_skills: async (call, m) => {
      await this.refreshSkills();
      const list = this.skillsCache.length
        ? this.skillsCache.map((s) => `- ${s.name}: ${s.description || "(no description)"}`).join("\n")
        : "(no skills yet — create one with save_skill)";
      await this.answerMeta(call, list);
      return "next";
    },
    set_memory: async (call, m) => {
      const a = safeParse(call.function.arguments);
      const content = String(a.content ?? "").slice(0, 32_000);
      await fs.writeFile(this.memoryFile, content, "utf8");
      await this.answerMeta(
        call,
        `memory.md REPLACED (${content.length} bytes). It is not in your prompt — call read_memory when you need it.`,
      );
      return "next";
    },
    forget_memory: async (call, m) => {
      const a = safeParse(call.function.arguments);
      const query = String(a.query ?? "").trim();
      if (!query) {
        await this.answerMeta(call, "forget_memory needs a `query` — nothing removed");
        return "next";
      }
      const prev = await fs.readFile(this.memoryFile, "utf8").catch(() => "");
      if (!prev.trim()) {
        await this.answerMeta(call, "(memory.md is empty — nothing to forget)");
        return "next";
      }
      const needle = query.toLowerCase();
      const kept: string[] = [];
      const removed: string[] = [];
      for (const line of prev.split(/\r?\n/)) {
        if (line.toLowerCase().includes(needle)) removed.push(line);
        else kept.push(line);
      }
      if (removed.length === 0) {
        await this.answerMeta(
          call,
          `(no line in memory.md matches ${JSON.stringify(query)} — nothing removed)`,
        );
        return "next";
      }
      const next = kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
      await fs.writeFile(this.memoryFile, next, "utf8");
      await this.answerMeta(
        call,
        `removed ${removed.length} line(s) from memory.md:\n${removed.join("\n").slice(0, 1_500)}\n` +
          `(memory.md is now ${next.length} bytes — re-add with add_memory if that was wrong)`,
      );
      return "next";
    },
    add_memory: async (call, m) => {
      const a = safeParse(call.function.arguments);
      const text = String(a.text ?? "").trim().slice(0, 8_000);
      if (!text) {
        await this.answerMeta(call, "add_memory needs non-empty `text` — nothing appended");
        return "next";
      }
      const prev = await fs.readFile(this.memoryFile, "utf8").catch(() => "");
      const sep = prev && !prev.endsWith("\n") ? "\n" : "";
      const next = `${prev}${sep}${text}\n`;
      await fs.writeFile(this.memoryFile, next.slice(0, 32_000), "utf8");
      await this.answerMeta(
        call,
        `appended to memory.md (now ${next.length} bytes). Not in your prompt — call read_memory to see it.`,
      );
      return "next";
    },
  };

  private async runTurnsUntilIdle(): Promise<boolean> {
    let finished = false;
    const cap = Math.max(0, this.opts.maxTurnsPerRound ?? 200);
    for (let guard = 0; cap === 0 || guard < cap; guard++) {
      if (this.stopRequested) return finished;
      this.drainPendingPrompts();
      await this.refreshSkills();
      this.progressRequestedThisRound = false;
      await this.maybeRequestProgress();
      await this.maybeCompact();

      await this.log.append("state", this.currentSession, this.currentBranch, {
        from: this.status,
        to: this.status,
        detail: "llm turn start",
        turn: ++this.stats.turns,
      });
      let res;
      try {
        res = await this.llmCall(this.buildMessages(), allToolSpecs(), (s) => {
          bus.emit("update", {
            kind: "llm-delta",
            agentId: this.opts.id,
            sessionId: this.currentSession, 
            text: s.text,
            reasoning: s.reasoning,
          } satisfies BusEvent);
        });
      } catch (err) {
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
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "turn-interrupted",
            detail: "stopped before any output arrived",
          });
        }
        if (isContextOverflow(err) && !this.stopRequested) {
          const attempt = (this.overflowRecoveries += 1);
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "overflow-recovery",
            attempt,
            detail: String((err as Error).message).slice(0, 200),
          });
          const before = this.stats.compactions;
          const shrink = OVERFLOW_SHRINK_STEPS[Math.min(attempt - 1, OVERFLOW_SHRINK_STEPS.length - 1)]!;
          await this.maybeCompact(true, shrink);
          if (this.stats.compactions > before) {
            await this.log.append("system_note", this.currentSession, this.currentBranch, {
              event: "overflow-recovered",
              attempt,
            });
            guard--; 
            continue;
          }
        }
        const nodeCap = isRequestNodeLimit(err);
        if (nodeCap.hit && !this.stopRequested) {
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "request-node-limit",
            limit: nodeCap.limit,
            messages: this.messages.length,
            detail: String((err as Error).message).slice(0, 200),
          });
          throw new Error(
            `this request is too LARGE IN STRUCTURE for the provider, not in tokens: the gateway caps ` +
              `the body at ${nodeCap.limit ?? "a fixed number"} JSON nodes and this session sends ` +
              `${this.messages.length} messages on top of its tool calls and images. Compacting does ` +
              `not reliably get under that cap — start a new session, or reduce the message/tool/image ` +
              `count (a fork at a recent point keeps the context you need). The provider's own words: ` +
              `${String((err as Error).message).slice(0, 300)}`,
          );
        }
        throw err;
      }
      this.overflowRecoveries = 0;
      if (res.usage) {
        const inTok = res.usage.inputTokens ?? 0;
        const cached = res.usage.cachedInputTokens ?? 0;
        this.stats.inputTokens += inTok;
        this.stats.cachedInputTokens += cached;
        this.stats.outputTokens += res.usage.outputTokens ?? 0;
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

      if (!m.tool_calls?.length) {
        if (this.opts.parent) {
          if (this.pendingSubReport) {
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
          continue; 
        }
        return finished;
      }

      for (const call of m.tool_calls) {
        if (this.stopRequested) {
          await this.answerUnansweredToolCalls(m);
          return finished;
        }
        const meta = this.metaHandlers[call.function.name as MetaToolName];
        if (meta) {
          if ((await meta(call, m)) === "end") {
            finished = true;
            return true;
          }
          continue;
        }

        await this.log.append("tool_call", this.currentSession, this.currentBranch, {
          callId: call.id,
          name: call.function.name,
          args: safeParse(call.function.arguments),
          argsRaw: call.function.arguments, 
        });
        const t0 = Date.now();
        let result: Awaited<ReturnType<typeof executeTool>>;
        try {
          await this.ensureWorkspace();
          result = await executeTool(call.function.name, call.function.arguments, this.toolCtx);
        } catch (err) {
          result = { ok: false, result: `tool could not run: ${(err as Error).message}` };
        }
        this.stats.toolCalls++;
        this.consecutiveIdleRounds = 0;
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
      await this.answerUnansweredToolCalls(m);
      if (finished) return true;
    }
    return finished;
  }

  async answerUnansweredToolCalls(m: ChatMessage): Promise<void> {
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
    const sys = this.systemPrompt();
    const hasSystem = this.messages[0]?.role === "system";
    const head: ChatMessage[] = [{ role: "system", content: sys }];
    return hasSystem ? [...head, ...this.messages.slice(1)] : [...head, ...this.messages];
  }

  private reloadAgentsMd(): string | null {
    if (!this.agentsMdLoaded) return null; 
    let fresh: string;
    try {
      const p = path.join(this.opts.workspace, "AGENTS.md");
      if (!existsSync(p)) return null; 
      fresh = readFileSync(p, "utf8").slice(0, 12_000);
    } catch {
      return null; 
    }
    if (fresh === this.agentsMd) return null;
    this.agentsMd = fresh;
    return fresh;
  }

  private agentsMd = "";
  private agentsMdLoaded = false;
  private wsSnapshot = "";
  private skillCatalogue = "";
  private memoryDigest = "";

  private systemPrompt(): string {
    if (!this.agentsMdLoaded) {
      this.agentsMdLoaded = true;
      const snapPath = path.join(this.opts.sessionDir, "workspace-snapshot.txt");
      try {
        this.wsSnapshot = readFileSync(snapPath, "utf8");
      } catch {
        this.wsSnapshot = "";
      }
      if (this.wsSnapshot === "" && existsSync(snapPath)) {
        this.wsSnapshot = "(empty workspace)"; 
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
              }
            }
            lines.push(e.isDirectory() ? `${e.name}/` : `${e.name} (${size})`);
          }
          this.wsSnapshot = lines.join("\n");
          if (!this.wsSnapshot) this.wsSnapshot = "(empty workspace)";
          try {
            void fs.writeFile(snapPath, this.wsSnapshot, "utf8");
          } catch {
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
      this.skillCatalogue = this.skillCatalogueText();
      this.memoryDigest = this.memoryDigestText();
    }
    let sys = SYSTEM_TEMPLATE;
    if (this.agentsMd.trim()) {
      sys += `\n\n## Project instructions (AGENTS.md)\n\n${this.agentsMd}`;
    }
    if (this.wsSnapshot) {
      sys += `\n\n## Workspace snapshot (top level)\n${this.wsSnapshot}\nUse list_dir/read_file for anything deeper — do NOT list again what is already here.`;
    }
    if (this.skillCatalogue) {
      sys +=
        `\n\n## Skills available in this workspace\n${this.skillCatalogue}\n` +
        `Load one with load_skill(name, instructions) when its description matches your task — ` +
        `pass what you want done so the instructions arrive with the playbook. ` +
        `list_skills() shows the full detail.`;
    }
    if (this.memoryDigest) {
      sys +=
        `\n\n## Your durable notes (memory.md — a DIGEST, not the whole file)\n${this.memoryDigest}\n` +
        `The full notes are NOT in this prompt. When any of the above may bear on the task — ` +
        `prior decisions, gotchas, where you left off — search them: ` +
        `read_memory(query) returns the matching lines, read_memory() with no query returns everything. ` +
        `Write with add_memory(text) (appends; never loses an earlier note).`;
    }
    return sys;
  }

  private auditEvidence(summary: unknown): string {
    const lines: string[] = [];
    for (let i = this.messages.length - 1; i >= 0 && lines.length < 24; i--) {
      const m = this.messages[i]!;
      const text = String(m.content ?? "").trim();
      if (!text) continue;
      if (m.role === "user") break; 
      const who = m.role === "assistant" ? "worker" : m.role;
      lines.push(`${who}: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
    }
    const tail = String(summary ?? "").trim();
    if (tail && !lines.some((l) => l.includes(tail.slice(0, 60)))) lines.unshift(`finish summary: ${tail}`);
    return lines.reverse().join("\n").slice(0, 6000);
  }

  private async captureRecentTurns(): Promise<string[]> {
    const recent: string[] = [];
    for (let i = this.messages.length - 1; i >= 0 && recent.length < 6; i--) {
      const m = this.messages[i]!;
      if (m.role === "user") continue; 
      const text = String(m.content ?? "").trim();
      if (!text || PLACEHOLDER_TEXT.test(text)) continue;
      if (HARNESS_ACK.test(text)) continue;
      const who = m.role === "tool" ? "tool" : m.role;
      let line = `[${who}] ${text}`;
      if (m.role === "tool") {
        line = `[${who}] ${(m.content ?? "").trim().slice(0, 1200)}`;
      }
      recent.unshift(line.slice(0, 20_000));
    }
    return recent;
  }

  private async runAuditor(first: ChatMessage[]): Promise<string> {
    const AUDIT_MAX_STEPS = 12;
    const step = (data: Record<string, unknown>) =>
      this.log.append("audit_step", this.currentSession, this.currentBranch, data).catch(() => {});
    const auditTools = toolSpecs().filter((t) => AUDIT_READ_ONLY_TOOLS.has(t.function.name));
    const messages: ChatMessage[] = [...first];
    await step({ step: "started", tools: auditTools.map((t) => t.function.name) });
    for (let i = 0; i < AUDIT_MAX_STEPS; i++) {
      const res = await this.callLlm(messages, auditTools);
      const text = String(res.message.content ?? "");
      const calls = res.message.tool_calls ?? [];
      if (!calls.length) {
        if (text.trim()) await step({ step: "reply", text: text.slice(0, 400) });
        return text;
      }
      messages.push({ role: "assistant", content: text, tool_calls: calls });
      for (const call of calls) {
        await step({ step: "tool", name: call.function?.name, args: String(call.function?.arguments ?? "").slice(0, 200) });
        let out: { ok: boolean; result: string };
        try {
          out = await executeTool(String(call.function?.name ?? ""), String(call.function?.arguments ?? "{}"), {
            ...this.toolCtx,
            readOnly: true,
            allowMutatingForReview: ["bash"],
          });
        } catch (err) {
          out = { ok: false, result: `tool failed: ${String((err as Error).message).slice(0, 200)}` };
        }
        await step({
          step: "tool_done",
          name: call.function?.name,
          ok: out.ok,
          chars: out.result.length,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: out.result.slice(0, 20_000),
        });
      }
    }
    const final = await this.callLlm(
      [...messages, { role: "user", content: "Stop investigating. Reply with the verdict line only." }],
      [],
    );
    return String(final.message.content ?? "");
  }

  private async handleFinish(argsJson: string): Promise<void> {
    const args = safeParse(argsJson);
    if (args.goalComplete === true && this.goal.status !== "done") {
      if (this.goal.verify?.trim()) {
        await this.log.append("goal", this.currentSession, this.currentBranch, {
          event: "audit-started",
          verify: this.goal.verify.slice(0, 2000),
        });
        this.auditAttempts++;
        try {
          const evidence = this.auditEvidence(args.summary);
          const auditMessages: ChatMessage[] = [
            { role: "user", content: auditPrompt({ goal: this.goal.text, verify: this.goal.verify, summary: String(args.summary ?? ""), evidence }) },
          ];
          const text = await this.runAuditor(auditMessages);
          const verdict = parseAuditVerdict(text);
          if (verdict.kind === "none") {
            this.auditUnavailableStreak++;
            await this.log.append("system_note", this.currentSession, this.currentBranch, {
              event: "audit-failed",
              detail: verdict.detail,
              attempt: this.auditUnavailableStreak,
            });
            if (this.auditUnavailableStreak < 3) {
              this.queueAuditUnavailableRetry();
              await this.captureRecentTurns();
              return;
            }
            await this.log.append("system_note", this.currentSession, this.currentBranch, {
              event: "audit-unavailable-cap",
              attempts: this.auditUnavailableStreak,
              detail: "the completion audit could not produce a verdict repeatedly — stopping so the operator decides (#128)",
            });
            await this.captureRecentTurns();
            return;
          }
          const approved = verdict.kind === "approved";
          const feedback = verdict.reason;
          await this.setGoalAudit(approved ? "approved" : "changes-required", feedback);
          this.auditUnavailableStreak = 0;
          if (approved) {
            this.consecutiveAuditRejects = 0;
            this.lastAuditOutcome = {
              audited: true,
              verdict: "approved",
              attempt: this.auditAttempts,
              ...(this.lastRejectedAudit
                ? { previous: { verdict: "changes-required", feedback: this.lastRejectedAudit.feedback } }
                : {}),
            };
          } else {
            this.lastRejectedAudit = { feedback, attempt: this.auditAttempts };
            if (!this.preRejectionTurns.length) {
              this.preRejectionTurns = await this.captureRecentTurns();
            }
          }
          await this.log.append("message", this.currentSession, this.currentBranch, {
            role: "assistant",
            operatorFacing: true,
            content: approved
              ? `✅ completion audit: APPROVED — ${feedback}`
              : `🔍️ completion audit: CHANGES REQUIRED — ${feedback}`,
          });
          if (!approved) {
            this.consecutiveAuditRejects++;
            this.lastRejectedAudit = { feedback, attempt: this.auditAttempts };
            const gaps = feedback.trim()
              ? feedback.slice(0, 2000)
              : `The auditor returned no specific gaps. Re-read the verification contract above and re-run it yourself, item by item, before finishing again:\n\n${this.goal.verify?.slice(0, 2000) || this.goal.text.slice(0, 2000)}`;
            const retryText = `[harness] The completion audit REJECTED this finish. Address these gaps, then finish again with goalComplete=true:\n\n${gaps}`;
            if (this.consecutiveAuditRejects < (this.opts.maxAuditRejects ?? 3)) {
              this.pendingPrompts.push({ source: "harness", text: retryText });
              await this.log.append("prompt", this.currentSession, this.currentBranch, {
                source: "harness",
                text: retryText,
              });
            }
            await this.captureRecentTurns();
            return;
          }
        } catch (err) {
          this.auditUnavailableStreak++;
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "audit-failed",
            detail: String((err as Error).message).slice(0, 300),
            attempt: this.auditUnavailableStreak,
          });
          if (this.auditUnavailableStreak < 3) {
            this.queueAuditUnavailableRetry();
            await this.captureRecentTurns();
            return;
          }
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "audit-unavailable-cap",
            attempts: this.auditUnavailableStreak,
            detail: "the completion audit could not produce a verdict repeatedly — stopping so the operator decides (#128)",
          });
          await this.captureRecentTurns();
          return;
        }
      } else {
        await this.setGoalStatus("done");
      }
    }
    await this.appendFinalMessage(args);
  }

  private queueAuditUnavailableRetry(): void {
    const text =
      `[harness] The completion audit could not produce a verdict — that is a problem with the ` +
      `AUDIT, not a finding about your work. Before finishing again, state plainly and briefly what ` +
      `you verified for each item of the contract, so the auditor has something to judge.\n\n` +
      `${this.goal.verify?.slice(0, 2000) || this.goal.text.slice(0, 2000)}`;
    this.pendingPrompts.push({ source: "harness", text });
    void this.log
      .append("prompt", this.currentSession, this.currentBranch, { source: "harness", text })
      .catch(() => {});
  }

  private async appendFinalMessage(args: { summary?: unknown }): Promise<void> {
    const recent = await this.captureRecentTurns();
    const before = this.preRejectionTurns;
    this.preRejectionTurns = [];
    const combined = before.length
      ? [
          `[before the audit rejected the first finish — ${before.length} entries]`,
          ...before,
          `[after the rejection — the retry — ${recent.length} entries]`,
          ...recent,
        ]
      : recent;
    const outcome = this.lastAuditOutcome;
    this.lastAuditOutcome = null;
    await this.log.append("message", this.currentSession, this.currentBranch, {
      role: "assistant",
      final: true,
      content: String(args.summary ?? ""),
      ...(combined.length ? { recentContext: combined } : {}),
      ...(outcome
        ? {
            audited: outcome.audited,
            auditVerdict: outcome.verdict,
            auditAttempt: outcome.attempt,
            ...(outcome.previous
              ? {
                  previousAuditVerdict: outcome.previous.verdict,
                  previousAuditFeedback: outcome.previous.feedback.slice(0, 2000),
                }
              : {}),
          }
        : {}),
    });
  }

  private async maybeRequestProgress(): Promise<void> {
    const elapsedOk = Date.now() - this.lastProgressAt >= this.opts.progressIntervalMs;
    const activityOk =
      this.activityChars >= this.opts.progressMinChars ||
      this.turnsSinceProgress >= this.opts.progressMaxQuietTurns;
    if (!elapsedOk || !activityOk) return; 
    if (this.nudgedAtTurn === this.stats.turns) return;
    this.progressRequestedThisRound = true;
    this.lastProgressAt = Date.now();
    this.activityChars = 0;
    this.turnsSinceProgress = 0;
    const request = PROGRESS_REQUEST;
    await this.log.append("prompt", this.currentSession, this.currentBranch, {
      source: "harness",
      text: request,
    });
    this.messages.push({ role: "user", content: request });
    const res = await this.llmCall(this.buildMessages(), allToolSpecs());
    const calls = res.message.tool_calls ?? [];
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
      const isReport = call.function.name === "report_progress";
      const answer = isReport ? "progress recorded" : "not run — this turn was a progress request";
      this.messages.push({ role: "tool", tool_call_id: call.id, content: answer });
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
        result: answer,
      });
     }
    if (!reported && !(res.message.content ?? "").trim()) {
      await this.recordProgress(JSON.stringify({ freeform: "(no report produced)" }));
    }
  }

  private estimateTokens(msgs: ChatMessage[] = this.messages): number {
    let ascii = 0;
    let wide = 0;
    const count = (s: string) => {
      for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) > 0x2e7f) wide++;
        else ascii++;
      }
    };
    for (const m of msgs) {
      count(m.content ?? "");
      for (const t of m.tool_calls ?? []) {
        count(t.function.name);
        count(t.function.arguments);
      }
    }
    return Math.ceil(ascii / 4 + wide * 1.2 + msgs.length * 8);
  }

  private safeCut(maxCut: number): number {
    for (let i = Math.min(maxCut, this.messages.length - 1); i >= 1; i--) {
      if (this.messages[i]!.role !== "tool") return i;
    }
    return -1;
  }

  private async answerMeta(
    call: { id: string; function: { name: string; arguments?: string } },
    content: string,
  ): Promise<void> {
    if (this.messages.some((m) => m.role === "tool" && m.tool_call_id === call.id)) return;
    const raw = call.function.arguments ?? "{}";
    this.messages.push({ role: "tool", tool_call_id: call.id, content });
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

  private async maybePrune(force = false): Promise<number> {
    const est = this.contextSizeForBudgeting(); 
    const budget = this.opts.contextTokenBudget;
    if (!budget) return 0;
    const pruneShare = this.opts.shortContext ? SHORT_PRUNE_AT_SHARE : PRUNE_AT_SHARE;
    if (!force && est < budget * pruneShare) return 0;
    const protectChars = this.opts.shortContext ? Math.floor(budget * 1.2) : budget * 2;
    let seen = 0;
    let boundary = this.messages.length;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      seen += this.messages[i]!.content?.length ?? 0;
      boundary = i;
      if (seen >= protectChars) break;
    }
    const PRUNE_MIN = 3_000;
    const PRUNABLE_TOOLS = new Set([
      "bash", "read_file", "list_dir", "grep", "glob", "write_file", "edit_file", "apply_patch",
      "bash_output",
    ]);
    let saved = 0;
    let count = 0;
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
        const keep = this.opts.shortContext ? SHORT_PRUNE_KEEP_CHARS : 400;
        saved += len - keep;
        m.content =
          m.content!.slice(0, keep) + `\n…[pruned ${len} bytes of ${toolName || "tool"} output]`;
        count++;
      }
    }
    if (count > 0)
      await this.log.append("system_note", this.currentSession, this.currentBranch, {
        event: "context-pruned",
        outputs: count,
        savedBytes: saved,
      });
    return count;
  }

  private async maybeCompact(force = false, keepFraction?: number): Promise<void> {
    const before = this.contextSizeForBudgeting(); 
    if (this.opts.shortContext) await this.maybePrune();
    if (!force && before < this.opts.contextTokenBudget) return;
    if (!force && this.opts.autoCompact === false) return;
    const pruned = await this.maybePrune(true);
    if (pruned > 0 && !force && this.contextSizeForBudgeting() < this.opts.contextTokenBudget) {
      await this.log.append("system_note", this.currentSession, this.currentBranch, {
        event: "context-pruned-enough",
        outputs: pruned,
        tokensAfter: this.contextSizeForBudgeting(),
        budget: this.opts.contextTokenBudget,
      });
      this.compactedAtLen = this.messages.length;
      return;
    }
    if (!force && this.consecutiveCompactFailures >= MAX_AUTO_COMPACT_FAILURES) return;
    if (force && this.messages.length <= this.compactedAtLen) return;
    this.lastUsage = undefined; 

    const keepTokens = keepFraction !== undefined
      ? Math.max(1, Math.floor(this.opts.contextTokenBudget * keepFraction))
      : Math.min(KEEP_RECENT_TOKENS, Math.max(1, Math.floor(this.opts.contextTokenBudget / 4)));
    let cut = -1;
    for (let i = this.messages.length - 1; i >= 1; i--) {
      if (this.estimateTokens(this.messages.slice(i)) > keepTokens) break;
      cut = i;
    }
    cut = this.safeCut(cut);
    if (cut <= 0) return; 

    let old = this.messages.slice(0, cut);
    const oldCount = old.length;
    const totalChars = this.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    const oldChars = old.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    const oldShareOfBefore = totalChars > 0 ? Math.round((before * oldChars) / totalChars) : 0;
    let summary = "";
    let mode: "summarize" | "truncate" = "summarize";
    let summarizedCount = oldCount;
    let droppedCount = 0;
    const oldTokens = Math.max(this.estimateTokens(old), oldShareOfBefore);
    const summarizeBar = Math.max(SUMMARIZE_MIN_TOKENS, this.opts.contextTokenBudget * SUMMARIZE_MIN_SHARE);
    const worthSummarizing = force || oldTokens >= summarizeBar;
    const previousSummary = this.lastCompactSummary;
    this.compactPhase = "summarizing";
    bus.emit("update", {
      kind: "compaction-progress",
      agentId: this.opts.id,
      phase: "summarizing",
      summarized: oldCount,
    } satisfies BusEvent);
    try {
      await this.log.append("system_note", this.currentSession, this.currentBranch, {
        event: "context-compaction-started",
        tokensBefore: before,
        messages: oldCount,
        reason: force ? "manual" : "auto",
        worthSummarizing, 
        updating: Boolean(previousSummary),
      });
      try {
        if (worthSummarizing) {
          for (let attempt = 0; attempt <= SUMMARIZE_OVERFLOW_RETRIES; attempt++) {
            try {
              summary = await this.summarize(
                old,
                (text) => {
                  bus.emit("update", {
                    kind: "llm-delta",
                    agentId: this.opts.id,
                    sessionId: this.currentSession,
                    text: `[compact] ${text}`,
                    reasoning: "",
                  } satisfies BusEvent);
                },
                previousSummary,
              );
              {
                if (!this.compactRules.length && previousSummary) {
                  this.compactRules = extractRules(previousSummary);
                }
                const enforced = enforceRules(summary, this.compactRules);
                summary = enforced.summary;
                this.compactRules = extractRules(summary);
                if (enforced.restored.length) {
                  await this.log.append("system_note", this.currentSession, this.currentBranch, {
                    event: "compaction-rules-restored",
                    count: enforced.restored.length,
                    rules: enforced.restored.map((r) => `${r.level} ${r.text}`),
                  });
                }
                await this.log.append("system_note", this.currentSession, this.currentBranch, {
                  event: "compaction-rules",
                  count: this.compactRules.length,
                  rules: this.compactRules.map((r) => `${r.level} ${r.text}`),
                });
              }
              break;
            } catch (e) {
              const shrinkable = isContextOverflow(e) && attempt < SUMMARIZE_OVERFLOW_RETRIES;
              if (!shrinkable) throw e;
              const smaller = this.safeCut(Math.max(1, Math.floor(old.length * SUMMARIZE_SHRINK)));
              if (smaller <= 0 || smaller >= old.length) throw e; 
              await this.log.append("system_note", this.currentSession, this.currentBranch, {
                event: "compaction-summarize-overflow",
                attempt: attempt + 1,
                from: old.length,
                to: smaller,
              });
              old = this.messages.slice(0, smaller);
              cut = smaller;
            }
          }
        } else {
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "context-compaction-skipped-summarize",
            reason: "shallow: truncation reclaims the budget without a full-history LLM call",
            tokensBefore: before,
            budget: this.opts.contextTokenBudget,
          });
        }
        this.compactPhase = "harvesting";
        bus.emit("update", { kind: "compaction-progress", agentId: this.opts.id, phase: "harvesting" } satisfies BusEvent);
        if (summary) await this.harvestLessons(summary); 
      } catch (err) {
        await this.log.append("error", this.currentSession, this.currentBranch, {
          message: `compaction summarize failed, falling back to truncation: ${(err as Error).message}`,
        });
        this.consecutiveCompactFailures += 1;
      }
      if (!summary) {
        mode = "truncate";
        summarizedCount = 0;
        const halfCut = this.safeCut(Math.max(1, Math.floor(oldCount / 2)));
        if (halfCut <= 0) {
          await this.log.append("system_note", this.currentSession, this.currentBranch, {
            event: "context-compaction-skipped",
            reason: "summarize failed and no safe prefix to truncate",
          });
          return; 
        }
        droppedCount = halfCut;
        this.messages = [
          {
            role: "user",
            content:
              `[harness] ${droppedCount} earlier messages were DROPPED, not summarized (no room to ` +
              "summarize, or the saving would not have justified the call). Your earlier work is " +
              "in the session log but is NOT in your context any more: re-read files or the goal " +
              "before assuming what happened, and do not rely on memory of the dropped part.",
          },
          ...this.messages.slice(halfCut),
        ];
      } else {
        this.messages = [
          {
            role: "user",
            content:
              `[harness] Context was compacted: ${oldCount} earlier messages were summarized. ` +
              "AGENTS.md is embedded in your system prompt; memory.md, todo.md and decisions.md are NOT — "
              + "call read_memory / get_todo / get_decisions if you need them.\n\n" +
              `## Summary of earlier conversation\n${summary}`,
          },
          ...this.messages.slice(cut),
        ];
      }
      const after = this.estimateTokens();
      this.stats.compactions++;
      if (mode === "summarize") this.consecutiveCompactFailures = 0;
      this.compactedAtLen = this.messages.length;
      if (mode === "summarize") {
        try {
          const notes = (await fs.readFile(this.memoryFile, "utf8")).trim();
          if (notes) {
            this.messages.splice(1, 0, {
              role: "user",
              content:
                `[harness] Your durable notes (memory.md), re-attached after compaction — ` +
                `this is what earlier you chose to remember:\n\n${notes.slice(0, 8_000)}`,
            });
          }
        } catch {
        }
      }
      if (this.recentReads.length && mode === "summarize") {
        const restored: string[] = [];
        const restoredPaths = new Set<string>();
        for (const rel of this.recentReads.slice(0, 3)) {
          try {
            const abs = safeJoin(this.opts.workspace, rel);
            const text = await fs.readFile(abs, "utf8");
            const head = text.split("\n").slice(0, 400).join("\n");
            restored.push(`--- ${rel}${text.length > head.length ? " (first 400 lines)" : ""} ---\n${head}`);
            restoredPaths.add(rel);
          } catch {
          }
        }
        if (restored.length) {
          this.messages.splice(1, 0, {
            role: "user",
            content:
              `[harness] These files were recently read and are re-attached for continuity ` +
              `(they may have changed — re-read if precision matters):\n\n${restored.join("\n\n")}`,
          });
          this.recentReads = this.recentReads.filter((rel) => restoredPaths.has(rel));
        }
      }
      const refreshed = this.reloadAgentsMd();
      if (refreshed) {
        await this.log.append("system_note", this.currentSession, this.currentBranch, {
          event: "agents-md-reloaded",
          bytes: refreshed.length,
        });
      }

      await this.log.append("compaction", this.currentSession, this.currentBranch, {
        tokensBefore: before,
        tokensAfter: after,
        summarized: summarizedCount,
        dropped: droppedCount,
        mode,
        ...(summary ? { summary: String(summary).slice(0, 20_000) } : {}),
      });
      if (summary) this.lastCompactSummary = summary;
      await this.log.append("system_note", this.currentSession, this.currentBranch, {
        event: "context-compacted",
        tokensBefore: before,
        tokensAfter: after,
        summarized: summarizedCount,
        dropped: droppedCount,
        mode,
      });
    } finally {
      this.compactPhase = "";
      bus.emit("update", { kind: "compaction-progress", agentId: this.opts.id, phase: "done" } satisfies BusEvent);
    }
  }

  private async summarize(
    old: ChatMessage[],
    onDelta?: (text: string) => void,
    previousSummary?: string,
  ): Promise<string> {
    const fn = this.opts.chatFn ?? chat;
    const prefix = this.buildMessages().slice(0, 1 + old.length);
    const instruction = COMPACT_INSTRUCTION + (previousSummary ? UPDATE_INSTRUCTION : "");
    const res = await fn(
      this.requestConfig({ oneOff: true }),
      [
        ...prefix,
        {
          role: "user" as const,
          content: (previousSummary ? `${SUMMARY_OPEN}${previousSummary}${SUMMARY_CLOSE}\n\n` : "") + instruction,
        },
      ],
      allToolSpecs(),
      undefined, 
      onDelta
        ? (s: { text: string; reasoning: string }) => onDelta(s.text)
        : undefined,
    );
    if (res.usage) {
      const u = res.usage;
      this.stats.inputTokens += u.inputTokens ?? 0;
      this.stats.outputTokens += u.outputTokens ?? 0;
      this.stats.cachedInputTokens += u.cachedInputTokens ?? 0;
      await this.log.append("usage", this.currentSession, this.currentBranch, {
        ...u,
        kind: "summarize",
      });
    }
    return this.formatCompactSummary(res.message.content ?? "");
  }

  private formatCompactSummary(raw: string): string {
    const m = raw.match(/<analysis>[\s\S]*?<\/analysis>\s*/);
    return m ? raw.slice(m[0].length).trim() : raw.trim();
  }

  private async harvestLessons(summary: string): Promise<void> {
    const m = summary.match(/##\s*Durable lessons?\s*\n([\s\S]*?)(?=\n##\s|$)/i);
    const lessons = m?.[1]?.trim();
    if (!lessons) return;
    const session = path.basename(this.opts.sessionDir);
    const stamped =
      `\n## lessons from compaction ${new Date().toISOString().slice(0, 16).replace("T", " ")}\n` +
      `_from: session ${session}, branch ${this.currentBranch}_\n${lessons}\n`;
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
    this.lastProgressAt = Date.now();
    this.activityChars = 0;
    this.turnsSinceProgress = 0;
    await this.log.append("progress", this.currentSession, this.currentBranch, this.latestProgress);
    bus.emit("update", { kind: "agent-update", agentId: this.opts.id } satisfies BusEvent);
  }

  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopRequested) return resolve();
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
    this.toolAbort.abort();
    await this.runChain.catch(() => {});
    await this.log.close();
  }

  async windDownForUpdate(timeoutMs: number): Promise<void> {
    this.windDownRequested = true;
    this.wake?.();
    if (this.status === "idle") {
      this.status = "idle";
      this.statusReason = "paused for a live update";
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = async () => {
      await this.settled();
      while (hasRunningBgShellsFor(this.toolCtx.cwd, this.opts.id)) {
        if (this.stopRequested) break;
        await this.sleepInterruptible(500);
      }
    };
    try {
      await Promise.race([
        done(),
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`did not reach a turn boundary within ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
      this.status = "idle";
      this.statusReason = "paused for a live update";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  get windingDownForUpdate(): boolean {
    return this.windDownRequested;
  }

  async fork(fromEventId?: string | null): Promise<{ session: string; branch: string }> {
    const newBranch = `br${this.branchCount()}${Date.now().toString(36).slice(-4)}`;
    const parentBranch = this.currentBranch;
    const fromEvent = fromEventId ?? this.log.lastEventId(parentBranch);
    await this.log.append("fork", this.currentSession, parentBranch, {
      fromSession: this.currentSession,
      fromBranch: parentBranch,
      fromEvent,
      newBranch,
    });
    this.log.seedBranch(newBranch, fromEvent);
    this.currentBranch = newBranch;
    this.messages = [...this.messages]; 
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

function allToolSpecs(): ReturnType<typeof toolSpecs> {
  return [...toolSpecs(), ...metaToolSpecs(), ...mcpSpecs()];
}

function mcpSpecs(): ReturnType<typeof toolSpecs> {
  return mcp.allTools().map((t) => ({
    type: "function" as const,
    function: {
      name: flattenToolName(t.server, t.name),
      description: `[MCP: ${t.server}] ${t.description || `${t.name} (no description provided)`}`,
      parameters: t.inputSchema,
    },
  }));
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
  while (lineage.length && lineage[0].type === "fork") lineage.shift();
  return lineage;
}

function rebuildMessagesFrom(list: TeapotEvent[]): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  const META_TOOLS = new Set([
    "finish", "report_progress", "set_goal", "get_goal",
    "read_memory", "set_memory", "add_memory", "forget_memory", "list_skills", "get_todo", "set_todo",
    "get_feedback", "add_feedback", "record_decision", "get_decisions",
  ]);
  const openCalls = new Map<string, string>(); 
  const assistantCalls = new Map<string, { function: { name: string; arguments: string } }>();
  const rememberAssistantCalls = (m: ChatMessage) => {
    if (Array.isArray(m.tool_calls))
      for (const t of m.tool_calls) assistantCalls.set(t.id, t as never);
  };
  const loggedResults = new Set(
    list.filter((e) => e.type === "tool_result").map((e) => String((e.data as Record<string, unknown>).callId ?? "")),
  );
  const bufferedUsers: string[] = [];
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
      if (d.final === true || d.operatorFacing === true) continue;
      const role = d.role === "assistant" ? "assistant" : "user";
      const content = typeof d.content === "string" ? d.content : "";
      const hasCalls = Array.isArray(d.toolCalls) && d.toolCalls.length > 0;
      if (role === "assistant" && !content && !hasCalls) continue;
      const m: ChatMessage = { role, content };
      if (hasCalls) {
        m.tool_calls = (d.toolCalls as { id: string; name: string }[]).map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: "{}" },
        }));
        for (const t of m.tool_calls)
          if (!META_TOOLS.has(t.function.name)) openCalls.set(t.id, t.function.name);
      }
      rememberAssistantCalls(m);
      msgs.push(m);
      } else if (e.type === "tool_call") {
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
      if (d.mode === "truncate") {
        msgs.splice(0, Math.min(msgs.length, Number(d.dropped ?? 0)));
      } else {
        const sum = typeof d.summary === "string" ? d.summary.trim() : "";
        const summarized = Math.min(msgs.length, Number(d.summarized ?? 0) || msgs.length);
        if (!sum) {
          console.warn(
            `[teapot] compaction at seq ${e.seq} has no summary text — keeping the full history rather than discarding it`,
          );
        } else {
          msgs.splice(
            0,
            summarized,
            {
              role: "user",
              content:
                `[harness] Context was compacted: ${summarized} earlier messages were summarized. ` +
                "AGENTS.md is embedded in your system prompt; memory.md, todo.md and decisions.md are NOT — "
              + "call read_memory / get_todo / get_decisions if you need them.\n\n" +
                `## Summary of earlier conversation\n${sum}`,
            },
          );
        }
      }
    } else if (e.type === "progress") {
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
