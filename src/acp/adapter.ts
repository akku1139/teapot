import type { Master } from "../master.ts";
import type { Agent } from "../agent/agent.ts";
import { readEvents } from "../log/events.ts";
import path from "node:path";

export const ACP_PROTOCOL_VERSION = 1;

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

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface AcpAdapterOptions {
  master: Master;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  defaultCwd?: string;
}

interface Session {
  id: string;
  cwd: string;
  agent: Agent;
}

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

const LOCATED_TOOLS = new Set([
  "read_file",
  "edit_file",
  "write_file",
  "apply_patch",
  "file_edit",
  "list_dir",
]);

function toolTitle(name: string, args: Record<string, unknown>): string {
  const first = (k: string) => {
    const v = args[k];
    return typeof v === "string" && v ? v : undefined;
  };
  if (name === "bash") return first("command") ?? "bash";
  if (name === "grep") return first("pattern") ? `grep /${first("pattern")}/` : "grep";
  return first("path") ?? name;
}

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

export function updateForEvent(
  e: { type: string; data: unknown },
  opts: { workspace: string },
): { sessionUpdate: string; [k: string]: unknown } | null {
  const d = (e.data ?? {}) as Record<string, any>;
  switch (e.type) {
    case "message": {
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
      const _name = String(d.name ?? "tool");
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
      return null;
  }
}

export class AcpAdapter {
  private readonly master: Master;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly defaultCwd: string;
  private readonly sessions = new Map<string, Session>();
  private readonly turnUpdates = new Map<JsonRpcId, { sessionId: string }>();
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

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.input.on("data", (chunk: Buffer | string) => this.onData(String(chunk)));
      this.input.on("end", () => resolve());
      this.input.on("error", () => resolve());
      if (typeof (this.input as { resume?: () => void }).resume === "function")
        (this.input as { resume: () => void }).resume();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
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
          if (isNotification) return;
          return this.fail(id ?? null, METHOD_NOT_FOUND, `unknown method: ${method}`);
      }
    } catch (err) {
      if (isNotification) return; 
      return this.fail(id ?? null, INTERNAL_ERROR, (err as Error).message);
    }
  }

  private initialize(): unknown {
    this.initialized = true;
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false } },
      authMethods: [],
    };
  }

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
    if (existing) return null; 
    const cwd = p.cwd ? path.resolve(String(p.cwd)) : this.defaultCwd;
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
    this.cancelled.add(s.id);
    s.agent.stop("cancelled via ACP");
  }

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
    this.cancelled.delete(s.id); 
    const abort = new AbortController();
    const stream = this.streamTurn(s.id, abort.signal).catch(() => {});
    try {
      s.agent.enqueuePrompt(text, "user");
      if (s.agent.status !== "running") s.agent.start("acp prompt");
      await s.agent.settled();
      abort.abort();
      await stream; 
      return this.ok(id, { stopReason: this.cancelled.has(s.id) ? "cancelled" : "end_turn" });
    } catch (err) {
      return this.fail(id, INTERNAL_ERROR, (err as Error).message);
    } finally {
      abort.abort();
      this.turnUpdates.delete(id);
    }
  }

  async drainOnce(sessionId: string, afterSeq = 0): Promise<number> {
    const s = this.sessions.get(sessionId);
    if (!s) return afterSeq;
    const events = await readEvents(s.agent.log.filePath).catch(() => []);
    for (const e of events) {
      if (e.seq <= afterSeq) continue;
      const update = updateForEvent(e, { workspace: s.cwd });
      if (update) this.notify("session/update", { sessionId, update });
    }
    return events.reduce((m, e) => Math.max(m, e.seq), afterSeq);
  }

  private async streamTurn(sessionId: string, signal: AbortSignal): Promise<void> {
    let cursor = await this.logTail(sessionId);
    for (;;) {
      cursor = await this.drainOnce(sessionId, cursor);
      if (signal.aborted) return;
      await sleep(STREAM_POLL_MS);
    }
  }

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
