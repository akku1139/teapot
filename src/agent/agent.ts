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
import { EventLog, readEvents } from "../log/events.js";
import { chat, type ChatFn, type ChatMessage, type LlmConfig } from "./llm.js";
import { executeTool, toolSpecs, currentSkills, type ToolContext } from "./tools.js";
import type { SkillDef } from "./skills.js";
import { bus, type BusEvent } from "../bus.js";

export type AgentStatus = "idle" | "running" | "stopped" | "error";

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
  logFile: string;
  /** ms of activity after which the harness asks for a progress report */
  progressIntervalMs?: number;
  /** continue automatically toward the goal without human input */
  autoContinue?: boolean;
  /** pause between auto-continue rounds */
  continueDelayMs?: number;
  maxConsecutiveToolErrors?: number;
  /** estimated-token budget; older history is compacted when exceeded */
  contextTokenBudget?: number;
  /** rebuild conversation from the JSONL log on init (default true) */
  restoreSession?: boolean;
  /** shared skill dir (defaults to none; workspace skills always enabled) */
  globalSkillsDir?: string;
  /** injectable LLM call for tests (defaults to the real one) */
  chatFn?: ChatFn;
}

const SYSTEM_TEMPLATE = `You are a coding agent working autonomously inside a workspace.

## Persistent context files (human-readable, git-tracked)
- AGENTS.md    : project knowledge/conventions written for agents (read it first)
- GOAL.md      : your current long-term goal and its status
- MEMORY.md    : durable notes you write for yourself

Keep these files updated with edit_file/write_file. They survive restarts.

## Rules
- Work step by step with tools. Verify results (run tests/builds) before claiming progress.
- When a task matches an available skill's description, load_skill it first and follow the playbook.
- When you develop a reusable procedure, save_skill it — skills persist and are offered to future sessions.
- When you make meaningful progress, call report_progress.
- When the goal is fully achieved, call finish(goalComplete=true) with a short summary.
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
  stats = {
    turns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    compactions: 0,
    startedAt: null as string | null,
  };

  private opts: Required<Omit<AgentOptions, "chatFn">> & { chatFn?: ChatFn };
  private messages: ChatMessage[] = [];
  private stopRequested = false;
  private wake: (() => void) | null = null;
  private abort: AbortController | null = null;
  private runChain: Promise<void> = Promise.resolve();
  private lastProgressAt = Date.now();
  private consecutiveToolErrors = 0;

  constructor(opts: AgentOptions) {
    this.opts = {
      progressIntervalMs: 10 * 60_000,
      autoContinue: true,
      continueDelayMs: 15_000,
      maxConsecutiveToolErrors: 5,
      contextTokenBudget: 96_000,
      restoreSession: true,
      globalSkillsDir: "",
      ...opts,
    };
    this.log = new EventLog(opts.logFile, opts.id);
    this.skillRoots = [
      { dir: path.join(opts.workspace, "skills"), source: "workspace" },
      ...(opts.globalSkillsDir ? [{ dir: opts.globalSkillsDir, source: "global" }] : []),
    ];
    this.toolCtx = {
      cwd: opts.workspace,
      defaultTimeoutMs: 120_000,
      maxOutputBytes: 60_000,
      skillRoots: this.skillRoots,
    };
    this.mainSession = `sess-${opts.id}-main`;
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

  private skillsListing(): string {
    if (this.skillsCache.length === 0) {
      return (
        "## Skills\n" +
        "No skills exist yet. When you develop a reusable procedure worth keeping " +
        "(build steps, checklists, project conventions), distill it into a durable playbook " +
        "with save_skill so future sessions can load it via load_skill."
      );
    }
    return (
      "## Skills (reusable playbooks)\n" +
      "When the current task matches a description below, call load_skill(name) first and follow it.\n" +
      this.skillsCache.map((s) => `- ${s.name}: ${s.description || "(no description)"}`).join("\n")
    );
  }

  private callLlm(messages: ChatMessage[], tools: ReturnType<typeof toolSpecs>) {
    const fn = this.opts.chatFn ?? chat;
    return fn(this.opts.llm, messages, tools, this.abort?.signal);
  }

  /** expose id for metrics */
  opts_id(): string {
    return this.opts.id;
  }

  get workspace(): string {
    return this.opts.workspace;
  }

  async init(): Promise<void> {
    await this.log.load();
    await fs.mkdir(this.workspace, { recursive: true });
    // seed persistent context files if missing
    await this.seed("AGENTS.md", "# Project knowledge\n\n(Describe conventions, build commands, and gotchas here.)\n");
    await this.seed("MEMORY.md", "# Memory\n");
    const goalText = await this.readGoalFile();
    if (goalText !== null) this.goal = this.parseGoalFile(goalText);
    else await this.writeGoalFile();
    if (this.opts.restoreSession) await this.restoreFromLog();
    await this.refreshSkills();
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
  private async restoreFromLog(): Promise<void> {
    const events = await readEvents(this.log.filePath);
    if (events.length === 0) return;
    const byId = new Map(events.map((e) => [e.id, e]));
    let last = events[events.length - 1]!;
    // walk backwards to the root via parent links (fork-safe)
    const lineage: typeof events = [];
    const seen = new Set<string>();
    for (let cur: typeof last | undefined = last; cur; cur = cur.parent ? byId.get(cur.parent) : undefined) {
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      lineage.push(cur);
    }
    lineage.reverse();
    // skip the trailing fork event itself (it is bookkeeping, not conversation)
    while (lineage.length && lineage[0].type === "fork") lineage.shift();

    const msgs: ChatMessage[] = [];
    for (const e of lineage) {
      const d = e.data as Record<string, unknown>;
      if (e.type === "prompt" && typeof d.text === "string") {
        msgs.push({ role: "user", content: d.text });
      } else if (e.type === "message") {
        const role = d.role === "assistant" ? "assistant" : "user";
        const m: ChatMessage = { role, content: typeof d.content === "string" ? d.content : "" };
        if (Array.isArray(d.toolCalls) && d.toolCalls.length > 0) {
          m.tool_calls = (d.toolCalls as { id: string; name: string }[]).map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: "{}" },
          }));
        }
        msgs.push(m);
      } else if (e.type === "tool_call") {
        // enrich the preceding assistant tool_calls with real arguments
        const prev = [...msgs].reverse().find((x) => x.role === "assistant" && x.tool_calls?.some((t) => t.id === d.callId));
        const tc = prev?.tool_calls?.find((t) => t.id === d.callId);
        if (tc) tc.function.arguments = JSON.stringify(d.args ?? {});
      } else if (e.type === "tool_result") {
        msgs.push({
          role: "tool",
          tool_call_id: String(d.callId ?? ""),
          content: `${d.ok === false ? "(failed) " : ""}${typeof d.result === "string" ? d.result : ""}`,
        });
      } else if (e.type === "progress") {
        // progress events may follow an assistant report_progress call that
        // has no logged tool result — patch it in when present
        const lastAssistant = [...msgs].reverse().find((x) => x.role === "assistant" && x.tool_calls?.length);
        if (lastAssistant?.tool_calls?.some((t) => t.function.name === "report_progress")) {
          for (const t of lastAssistant.tool_calls!) {
            if (!msgs.some((x) => x.role === "tool" && x.tool_call_id === t.id)) {
              msgs.push({ role: "tool", tool_call_id: t.id, content: "progress recorded" });
            }
          }
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

  private async seed(file: string, content: string): Promise<void> {
    const p = path.join(this.workspace, file);
    try {
      await fs.access(p);
    } catch {
      await fs.writeFile(p, content, "utf8");
    }
  }

  private readGoalFile(): Promise<string | null> {
    return fs.readFile(path.join(this.workspace, "GOAL.md"), "utf8").catch(() => null);
  }

  private parseGoalFile(text: string): GoalState {
    const m = text.match(/status:\s*(\w+)/i);
    const status = m?.[1] === "done" ? "done" : m?.[1] === "paused" ? "paused" : "active";
    return { text: text.trim(), status, updatedAt: new Date().toISOString() };
  }

  private async writeGoalFile(): Promise<void> {
    const body =
      `${this.goal.text}\n\nstatus: ${this.goal.status}\nupdated: ${this.goal.updatedAt}\n`;
    await fs.writeFile(path.join(this.workspace, "GOAL.md"), body, "utf8");
  }

  async setGoal(text: string): Promise<void> {
    this.goal = { text, status: "active", updatedAt: new Date().toISOString() };
    await this.writeGoalFile();
    await this.log.append("goal", this.currentSession, this.currentBranch, { event: "set", text });
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
    };
  }

  /** Queue a user prompt; wakes the loop if needed. Returns immediately. */
  enqueuePrompt(text: string, source = "user"): Promise<void> {
    return this.enqueue(async () => {
      await this.log.append("prompt", this.currentSession, this.currentBranch, { source, text });
      this.messages.push({ role: "user", content: text });
    });
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
    void this.enqueue(async () => {
      this.setStatus("running", reason);
      this.stats.startedAt ??= new Date().toISOString();
    });
    void this.enqueue(() => this.loop());
  }

  stop(reason = "stopped by user"): void {
    this.stopRequested = true;
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
        if (finished || this.stopRequested) break;
        if (!this.opts.autoContinue || this.goal.status !== "active") break;
        // auto-continue: wait quietly, then nudge with a fresh round
        await this.sleepInterruptible(this.opts.continueDelayMs);
        if (this.stopRequested) break;
        const nudge =
          "Continue working toward the goal in GOAL.md. If you are blocked, explain why briefly.";
        await this.log.append("prompt", this.currentSession, this.currentBranch, {
          source: "harness",
          text: nudge,
        });
        this.messages.push({ role: "user", content: nudge });
      } catch (err) {
        const name = (err as Error).name;
        // a stop (user abort or pre-call guard) is control flow, not a failure
        if (this.stopRequested || name === "AbortError" || name === "StopRequested") break;
        const msg = (err as Error).message ?? String(err);
        await this.log.append("error", this.currentSession, this.currentBranch, { message: msg });
        this.setStatus("error", msg.slice(0, 300));
        return;
      }
    }
    if (!this.stopRequested) this.setStatus("idle", "round complete");
  }

  /**
   * One LLM call with a fresh abort controller so stop() can interrupt it
   * immediately, plus loop-level retries for provider flakiness (the SDK
   * already backsoff 429/5xx; this covers exhausted rate limits and 400s).
   */
  private async llmCall(messages: ChatMessage[], tools: ReturnType<typeof toolSpecs>) {
    const maxAttempts = 4;
    const waits = [30_000, 60_000, 120_000];
    for (let attempt = 1; ; attempt++) {
      if (this.stopRequested) throw Object.assign(new Error("stopped"), { name: "StopRequested" });
      this.abort = new AbortController();
      try {
        return await this.callLlm(messages, tools);
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
      const res = await this.llmCall(this.buildMessages(), allToolSpecs());
      if (res.usage) {
        this.stats.inputTokens += res.usage.inputTokens ?? 0;
        this.stats.outputTokens += res.usage.outputTokens ?? 0;
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

      if (!m.tool_calls?.length) return finished;

      for (const call of m.tool_calls) {
        if (this.stopRequested) return finished;
        if (call.function.name === "finish") {
          await this.handleFinish(call.function.arguments);
          // answer the tool_call so a follow-up round stays API-valid
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: this.goal.status === "done" ? "(goal complete)" : "(round ended)",
          });
          finished = true;
          continue;
        }
        if (call.function.name === "report_progress") {
          await this.recordProgress(call.function.arguments);
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "progress recorded",
          });
          continue;
        }
        await this.log.append("tool_call", this.currentSession, this.currentBranch, {
          callId: call.id,
          name: call.function.name,
          args: safeParse(call.function.arguments),
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
    const sys: string[] = [SYSTEM_TEMPLATE];
    if (this.goal.text) {
      sys.push(`## Current goal (${this.goal.status})\n${this.goal.text}`);
    }
    sys.push(this.skillsListing());
    const hasSystem = this.messages[0]?.role === "system";
    const head: ChatMessage[] = [{ role: "system", content: sys.join("\n\n") }];
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
    if (Date.now() - this.lastProgressAt < this.opts.progressIntervalMs) return;
    this.lastProgressAt = Date.now();
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

  /** rough token estimate (~4 chars/token); good enough to trigger before overflow */
  private estimateTokens(): number {
    let chars = 0;
    for (const m of this.messages) {
      chars += (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? "").length;
    }
    return Math.ceil(chars / 4);
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

  /** Compact history when the estimated token count exceeds the budget. */
  private async maybeCompact(): Promise<void> {
    const before = this.estimateTokens();
    if (before < this.opts.contextTokenBudget) return;

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
            "Persistent files (GOAL.md / AGENTS.md / MEMORY.md) are still on disk — re-read them when needed.\n\n" +
            `## Summary of earlier conversation\n${summary}`,
        },
        ...this.messages.slice(cut),
      ];
    }
    const after = this.estimateTokens();
    this.stats.compactions++;
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
            "Preserve: current goal state, key decisions, files created/changed, important command results, " +
            "open problems, and the next step. Be terse bullet points, no prose flourishes.",
        },
        { role: "user", content: `Conversation:\n\n${transcript}\n\nWrite the continuation notes now.` },
      ],
      [],
      undefined, // never abortable by stop(): losing the summary would lose history
    );
    return res.message.content ?? "";
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

/** workspace tools + agent-meta tools (finish / report_progress) */
function allToolSpecs(): ReturnType<typeof toolSpecs> {
  return [
    ...toolSpecs(),
    {
      type: "function" as const,
      function: {
        name: "finish",
        description:
          "End the current round. Call with goalComplete=true only when the goal in GOAL.md is fully achieved.",
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
