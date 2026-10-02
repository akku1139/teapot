/**
 * ACP (Agent Client Protocol) adapter (#15).
 *
 * Speaks JSON-RPC 2.0 over stdio so an editor (Zed's custom agents, and others)
 * can drive a teapot agent as a subprocess. The whole point is that this is a
 * THIN adapter: the existing Master/Agent already expose what ACP needs
 * (enqueuePrompt, start, stop, settled, and a JSONL event log), so the agent
 * loop itself is untouched.
 *
 * Scope — the BASELINE methods only:
 *   initialize, authenticate, session/new, session/load, session/prompt,
 *   session/cancel, and session/update notifications.
 *
 * Terminal and filesystem methods are NOT implemented and NOT advertised as
 * capabilities. A client only calls what initialize advertises, so claiming a
 * half-correct terminal would be worse than omitting it.
 *
 * Protocol notes taken from agentclientprotocol.com rather than from memory:
 *   - JSON-RPC 2.0; notifications get no response (success OR error).
 *   - all file paths MUST be absolute; line numbers are 1-based.
 *   - prompt is a multi-turn request whose result carries a stopReason.
 */
import type { Master } from "../master.ts";
import type { Agent } from "../agent/agent.ts";
import { readEvents } from "../log/events.ts";
import path from "node:path";

export const ACP_PROTOCOL_VERSION = 1;

/**
 * How often a running turn is drained for new events.
 *
 * The web UI gets a WebSocket push; ACP has no such channel here, so the turn
 * is streamed by polling the agent's own log. 150ms is well under the ~60ms
 * render tick a human notices, and the read is a tail of a file this process
 * is already appending to — cheap enough to be invisible next to an LLM call.
 */
const STREAM_POLL_MS = 150;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC error codes we use (the standard set plus JSON-RPC's own). */
const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface AcpAdapterOptions {
  master: Master;
  /** defaults to process.stdin/stdout */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** workspace for sessions created without an explicit cwd */
  defaultCwd?: string;
}

interface Session {
  id: string;
  cwd: string;
  agent: Agent;
}

/**
 * Run the ACP adapter until stdin closes.
 *
 * Kept as a class rather than free functions so the session map and the pending
 * request bookkeeping have somewhere to live, and so it is directly testable
 * with an in-memory stream pair.
 */
/* ---------- streaming: log events → session/update notifications ---------- */

/**
 * ACP `ToolCall.kind` for a teapot tool name.
 *
 * The schema's own enum (verified against schema/v1/schema.json, not memory):
 * read, edit, delete, move, search, execute, fetch, think, switch_mode, other,
 * description. Editors use this to pick an icon and to decide whether the call
 * mutates anything, so mapping our tools onto it is worth doing properly.
 */
const TOOL_KINDS: Record<string, string> = {
  read_file: "read",
  list_dir: "read",
  glob: "search",
  grep: "search",
  bash: "execute",
  bash_output: "execute",
  read_url: "fetch",
  web_fetch: "fetch",
  edit_file: "edit",
  write_file: "edit",
  apply_patch: "edit",
  file_edit: "edit",
  memory: "edit",
  get_memory: "read",
};

/** Filesystem tools whose `path` argument is worth surfacing as a location. */
const LOCATED_TOOLS = new Set([
  "read_file",
  "edit_file",
  "write_file",
  "apply_patch",
  "file_edit",
  "list_dir",
]);

/** a one-line title for a tool call, the way an editor shows it in a list */
function toolTitle(name: string, args: Record<string, unknown>): string {
  const first = (k: string) => {
    const v = args[k];
    return typeof v === "string" && v ? v : undefined;
  };
  if (name === "bash") return first("command") ?? "bash";
  if (name === "grep") return first("pattern") ? `grep /${first("pattern")}/` : "grep";
  return first("path") ?? name;
}

/** Absolute path for a tool's location, so an editor can open the file. */
function toolLocation(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
): { path: string; line?: number }[] {
  if (!LOCATED_TOOLS.has(name)) return [];
  const p = args.path;
  if (typeof p !== "string" || !p) return [];
  const abs = path.isAbsolute(p) ? p : path.resolve(workspace, p);
  const line = Number(args.line ?? args.line_number ?? NaN);
  return [{ path: abs, ...(Number.isFinite(line) && line > 0 ? { line } : {}) }];
}

/**
 * Turn one logged event into the session/update payload for it, or null when
 * the event has no ACP equivalent (and must therefore NOT be invented into
 * one).
 *
 * Pure and exported so the mapping is testable without a transport, which is
 * how the previous scaffold went unverified: `drainOnce` existed, was never
 * called, and nothing noticed.
 */
export function updateForEvent(
  e: { type: string; data: unknown },
  opts: { workspace: string },
): { sessionUpdate: string; [k: string]: unknown } | null {
  const d = (e.data ?? {}) as Record<string, any>;
  switch (e.type) {
    case "message": {
      // The completion AUDIT's verdict and the operator-facing summary are
      // timeline content, not something the agent said to the model. They are
      // marked precisely so the web feed can skip them; an editor must not be
      // shown an agent speaking a harness message.
      if (d.final === true || d.operatorFacing === true) return null;
      const text = String(d.content ?? "");
      if (!text.trim()) return null;
      return {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      };
    }
    case "tool_call": {
      const name = String(d.name ?? "tool");
      const args = (d.args ?? {}) as Record<string, unknown>;
      return {
        sessionUpdate: "tool_call",
        toolCallId: String(d.callId ?? e.type),
        title: toolTitle(name, args),
        name,
        kind: TOOL_KINDS[name] ?? "other",
        status: "in_progress",
        rawInput: args,
        locations: toolLocation(name, args, opts.workspace),
      };
    }
    case "tool_result": {
      const name = String(d.name ?? "tool");
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: String(d.callId ?? e.type),
        status: d.ok === false ? "failed" : "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: String(d.result ?? "").slice(0, 20_000) },
          },
        ],
      };
    }
    default:
      // state transitions, goals, todos, compactions, notes: all internal. The
      // schema HAS update kinds for some of this (plan, usage_update), but
      // emitting them with guessed payloads would be worse than silence.
      return null;
  }
}

export class AcpAdapter {
  private readonly master: Master;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly defaultCwd: string;
  private readonly sessions = new Map<string, Session>();
  /** id -> notification params, so a prompt turn can stream updates */
  private readonly turnUpdates = new Map<JsonRpcId, { sessionId: string }>();
  /** sessions cancelled during the CURRENT turn, cleared when it starts (#15) */
  private readonly cancelled = new Set<string>();
  private buffer = "";
  private nextSession = 1;
  private initialized = false;

  constructor(opts: AcpAdapterOptions) {
    this.master = opts.master;
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
    this.defaultCwd = opts.defaultCwd ?? process.cwd();
  }

  /** Attach to the stream. Resolves when stdin ends. */
  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.input.on("data", (chunk: Buffer | string) => this.onData(String(chunk)));
      this.input.on("end", () => resolve());
      this.input.on("error", () => resolve());
      if (typeof (this.input as { resume?: () => void }).resume === "function")
        (this.input as { resume: () => void }).resume();
    });
  }

  /* ---------- transport ---------- */

  private onData(chunk: string): void {
    this.buffer += chunk;
    // NDJSON: one JSON object per line
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      // a parse error has no id to answer
      this.send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "invalid JSON" } });
      return;
    }
    void this.dispatch(msg);
  }

  private send(res: JsonRpcResponse | { jsonrpc: "2.0"; method: string; params: unknown }): void {
    this.output.write(JSON.stringify(res) + "\n");
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private ok(id: JsonRpcId, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private fail(id: JsonRpcId, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /* ---------- dispatch ---------- */

  private async dispatch(msg: JsonRpcRequest): Promise<void> {
    const { method, id, params } = msg;
    const isNotification = id === undefined || id === null;
    try {
      switch (method) {
        case "initialize":
          return this.ok(id ?? null, this.initialize());
        case "authenticate":
          return this.ok(id ?? null, {});
        case "session/new":
          return this.ok(id ?? null, await this.newSession(params));
        case "session/load":
          return this.ok(id ?? null, await this.loadSession(params));
        case "session/prompt":
          return await this.prompt(id ?? null, params);
        case "session/cancel":
          this.cancel(params);
          if (!isNotification) return this.ok(id ?? null, {});
          return;
        default:
          // notifications for unknown methods get NO response at all
          if (isNotification) return;
          return this.fail(id ?? null, METHOD_NOT_FOUND, `unknown method: ${method}`);
      }
    } catch (err) {
      if (isNotification) return; // never answer a notification
      return this.fail(id ?? null, INTERNAL_ERROR, (err as Error).message);
    }
  }

  private initialize(): unknown {
    this.initialized = true;
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // Only capabilities we actually implement. Terminal/fs are deliberately
      // absent: a client calls what we advertise, and a partial implementation
      // would be worse than an honest omission.
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false } },
      authMethods: [],
    };
  }

  /* ---------- sessions ---------- */

  private async newSession(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { cwd?: string; mcpServers?: unknown };
    const cwd = p.cwd ? path.resolve(String(p.cwd)) : this.defaultCwd;
    const id = `acp-${this.nextSession++}`;
    const agent = await this.master.addAgent(
      { id, workspace: cwd } as never,
      { persist: false, fresh: true },
    );
    this.sessions.set(id, { id, cwd, agent });
    return { sessionId: id };
  }

  private async loadSession(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { sessionId?: string; cwd?: string; mcpServers?: unknown };
    const id = String(p.sessionId ?? "");
    const existing = this.sessions.get(id);
    if (existing) return null; // already live
    const cwd = p.cwd ? path.resolve(String(p.cwd)) : this.defaultCwd;
    // resuming means the agent's own log is restored, not a fresh session
    const agent = await this.master.addAgent(
      { id, workspace: cwd } as never,
      { persist: false, fresh: false },
    );
    this.sessions.set(id, { id, cwd, agent });
    return null;
  }

  private cancel(params: unknown): void {
    const p = (params ?? {}) as { sessionId?: string };
    const s = p.sessionId ? this.sessions.get(String(p.sessionId)) : undefined;
    if (!s) return;
    // Remember it HERE rather than asking the Agent whether it was stopped:
    // the flag that says so is private, and the adapter already knows — it is
    // the component that answered the cancel notification.
    this.cancelled.add(s.id);
    s.agent.stop("cancelled via ACP");
  }

  /* ---------- prompt turn ---------- */

  private async prompt(id: JsonRpcId, params: unknown): Promise<void> {
    const p = (params ?? {}) as { sessionId?: string; prompt?: { text?: string }[] };
    const s = p.sessionId ? this.sessions.get(String(p.sessionId)) : undefined;
    if (!s) return this.fail(id, INVALID_PARAMS, `unknown session: ${String(p.sessionId)}`);
    const text = (p.prompt ?? [])
      .map((c) => String(c?.text ?? ""))
      .join("\n")
      .trim();
    if (!text) return this.fail(id, INVALID_PARAMS, "prompt must contain text");

    this.turnUpdates.set(id, { sessionId: s.id });
    this.cancelled.delete(s.id); // a cancel is per-turn, not per-session
    // Stream the turn as it happens. The editor shows the reply and each tool
    // call appear as they happen; without this the client sees NOTHING until
    // the whole turn finishes, which is the difference between a usable agent
    // and a black box that eventually prints an answer.
    const abort = new AbortController();
    const stream = this.streamTurn(s.id, abort.signal).catch(() => {});
    try {
      s.agent.enqueuePrompt(text, "user");
      if (s.agent.status !== "running") s.agent.start("acp prompt");
      await s.agent.settled();
      // One last drain, or the final tool result and closing message can be
      // missed: `settled()` resolves the moment the agent stops, and the last
      // append may not have landed yet.
      abort.abort();
      await stream; // resolves after its own final drain
      return this.ok(id, { stopReason: this.cancelled.has(s.id) ? "cancelled" : "end_turn" });
    } catch (err) {
      return this.fail(id, INTERNAL_ERROR, (err as Error).message);
    } finally {
      abort.abort();
      this.turnUpdates.delete(id);
    }
  }

/** Stream a session's events to the client as session/update notifications. */
  async drainOnce(sessionId: string, afterSeq = 0): Promise<number> {
    const s = this.sessions.get(sessionId);
    if (!s) return afterSeq;
    const events = await readEvents(s.agent.log.filePath).catch(() => []);
    for (const e of events) {
      if (e.seq <= afterSeq) continue;
      const update = updateForEvent(e, { workspace: s.cwd });
      // null means "no ACP equivalent" — state flips, goals, notes. Staying
      // silent is correct; the old code invented a tool_call for every one.
      if (update) this.notify("session/update", { sessionId, update });
    }
    // Advance past EVERY event we read, including the ones we did not emit, so
    // an un-emitted event is not reconsidered on the next poll.
    return events.reduce((m, e) => Math.max(m, e.seq), afterSeq);
  }

  /**
   * Poll one session until it settles, streaming each batch as it appears.
   *
   * Polling the JSONL rather than subscribing to the bus is deliberate: the log
   * is the agent's own record, so a listener attached at the wrong moment can
   * miss the start of a reply, and a crash mid-turn leaves the file as the one
   * complete account of what happened. It also means a resumed session replays
   * exactly the same updates.
   */
  private async streamTurn(sessionId: string, signal: AbortSignal): Promise<void> {
    // Start from the CURRENT tail: everything before this prompt belongs to
    // earlier turns, and a resumed session has already been replayed.
    let cursor = await this.logTail(sessionId);
    // NOTE the drain happens BEFORE the abort check, not after it. A short
    // turn — a cached model, a tiny task, a failing endpoint that gives up
    // quickly — can finish inside one poll interval, so a loop that slept and
    // then bailed on `signal.aborted` would exit having drained NOTHING. That
    // is exactly what happened: every turn raced the first tick and the
    // editor received silence.
    for (;;) {
      cursor = await this.drainOnce(sessionId, cursor);
      if (signal.aborted) return;
      await sleep(STREAM_POLL_MS);
    }
  }

  /** highest seq currently in a session's log, or 0 */
  private async logTail(sessionId: string): Promise<number> {
    const s = this.sessions.get(sessionId);
    if (!s) return 0;
    const events = await readEvents(s.agent.log.filePath).catch(() => []);
    return events.reduce((m, e) => Math.max(m, e.seq), 0);
  }

  get initialized_(): boolean {
    return this.initialized;
  }
}