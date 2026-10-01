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
export class AcpAdapter {
  private readonly master: Master;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly defaultCwd: string;
  private readonly sessions = new Map<string, Session>();
  /** id -> notification params, so a prompt turn can stream updates */
  private readonly turnUpdates = new Map<JsonRpcId, { sessionId: string }>();
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
    s?.agent.stop("cancelled via ACP");
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
    try {
      s.agent.enqueuePrompt(text, "user");
      if (s.agent.status !== "running") s.agent.start("acp prompt");
      await s.agent.settled();
      const stopReason = s.agent.goal.status === "done" ? "end_turn" : "end_turn";
      return this.ok(id, { stopReason });
    } finally {
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
      this.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: e.type === "message" ? "agent_message_chunk" : "tool_call",
          content: { type: "text", text: String((e.data as { content?: unknown })?.content ?? "") },
        },
      });
    }
    const max = events.reduce((m, e) => Math.max(m, e.seq), afterSeq);
    return max;
  }

  get initialized_(): boolean {
    return this.initialized;
  }
}