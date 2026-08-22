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
import { EventLog } from "../log/events.js";
import { chat, type ChatMessage, type LlmConfig } from "./llm.js";
import { executeTool, toolSpecs, type ToolContext } from "./tools.js";
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
}

const SYSTEM_TEMPLATE = `You are a coding agent working autonomously inside a workspace.

## Persistent context files (human-readable, git-tracked)
- AGENTS.md    : project knowledge/conventions written for agents (read it first)
- GOAL.md      : your current long-term goal and its status
- MEMORY.md    : durable notes you write for yourself

Keep these files updated with edit_file/write_file. They survive restarts.

## Rules
- Work step by step with tools. Verify results (run tests/builds) before claiming progress.
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
    startedAt: null as string | null,
  };

  private opts: Required<AgentOptions>;
  private messages: ChatMessage[] = [];
  private stopRequested = false;
  private wake: (() => void) | null = null;
  private runChain: Promise<void> = Promise.resolve();
  private lastProgressAt = Date.now();
  private consecutiveToolErrors = 0;

  constructor(opts: AgentOptions) {
    this.opts = {
      progressIntervalMs: 10 * 60_000,
      autoContinue: true,
      continueDelayMs: 15_000,
      maxConsecutiveToolErrors: 5,
      ...opts,
    };
    this.log = new EventLog(opts.logFile, opts.id);
    this.toolCtx = {
      cwd: opts.workspace,
      defaultTimeoutMs: 120_000,
      maxOutputBytes: 60_000,
    };
    this.mainSession = `sess-${opts.id}-main`;
    this.currentSession = this.mainSession;
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
        this.messages.push({
          role: "user",
          content:
            "Continue working toward the goal in GOAL.md. If you are blocked, explain why briefly.",
        });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        await this.log.append("error", this.currentSession, this.currentBranch, { message: msg });
        if ((err as Error).name === "AbortError" || this.stopRequested) break;
        this.setStatus("error", msg.slice(0, 300));
        return;
      }
    }
    if (!this.stopRequested) this.setStatus("idle", "round complete");
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
      // periodic progress report at turn boundary (no mid-turn interruption)
      await this.maybeRequestProgress();

      await this.log.append("state", this.currentSession, this.currentBranch, {
        from: this.status,
        to: this.status,
        detail: "llm turn start",
        turn: ++this.stats.turns,
      });
      const res = await chat(this.opts.llm, this.buildMessages(), allToolSpecs());
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
      });
      this.messages.push(m);

      if (!m.tool_calls?.length) return finished;

      for (const call of m.tool_calls) {
        if (this.stopRequested) return finished;
        if (call.function.name === "finish") {
          await this.handleFinish(call.function.arguments);
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
    this.messages.push({
      role: "user",
      content:
        "[harness] Please give a brief progress report now: what you are doing, goal progress, " +
        "what you recently tried, any problems, and your next step. Keep it under 10 lines.",
    });
    const res = await chat(this.opts.llm, this.buildMessages(), []); // no tools: pure report
    await this.recordProgress(JSON.stringify({ freeform: res.message.content }));
    this.messages.push(res.message);
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
