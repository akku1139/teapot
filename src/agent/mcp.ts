/**
 * MCP client (#67): the subset of Model Context Protocol teapot actually needs.
 *
 * Scope is deliberately minimal. An MCP server is a source of TOOLS, so what must
 * exist is: connect, discover (`tools/list` with pagination), call (`tools/call`),
 * and the auth headers a remote server demands. No prompts, no resources, no
 * sampling, no roots — adding transports and capabilities that nothing in the harness
 * consumes is how an MCP client becomes a maintenance sink.
 *
 * Transports:
 *   - **Streamable HTTP** (the current spec). A POST carries one JSON-RPC message; the
 *     reply is either `application/json` or a `text/event-stream` carrying the same
 *     message as a `data:` line. Both are handled, because servers differ.
 *   - **legacy HTTP+SSE** (2024-11-05): a GET holds an event stream open and the POST
 *     replies come back ON THAT STREAM. Detected by trying the modern shape first and
 *     falling back when the endpoint refuses POST.
 *   - **stdio**: a child process speaking newline-delimited JSON-RPC on stdin/stdout.
 *
 * What is modelled from the reference implementation (akku1139/easywebui,
 * `src/worker/api/mcp-*.ts`) and kept for the same reasons:
 *   - read the reply UNTIL the matching `id` arrives instead of awaiting the end of an
 *     SSE stream, which may stay open indefinitely;
 *   - `Mcp-Session-Id` and `MCP-Protocol-Version` headers on every request after
 *     `initialize` — a server that issued a session id rejects requests without it;
 *   - `notifications/initialized` as a notification (no id, no reply);
 *   - treat a 3xx as an ERROR rather than following it: an MCP endpoint that redirects
 *     is usually redirecting to an HTML login page, and following it produces a JSON
 *     parse error that hides the real cause;
 *   - cap the response size and the pagination loop, and detect a cursor that repeats;
 *   - validate each tool definition (`name`, object `inputSchema`) instead of trusting
 *     the server, because a malformed tool becomes a malformed function spec sent to
 *     the LLM.
 *
 * Deliberately NOT modelled: OAuth. easywebui runs on a serverless edge with no place
 * to keep a token, so it implements a full OAuth dance. teapot runs locally and already
 * has a config file for secrets, so a static header map (`headers`) covers the real
 * cases (a bearer token, an API key) without a redirect flow, a token store, and a
 * refresh timer. If OAuth turns out to be needed, it can be added behind the same
 * `headers` field rather than as a parallel auth path.
 */

/** JSON-RPC envelope — narrow, because that is all that crosses this boundary. */
type Rpc = {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
};

export class McpError extends Error {
  /** true when the server answered 401/403 — the caller may need to fix a header */
  readonly authRequired: boolean;

  // NOT a parameter property (`constructor(msg, readonly x)`) — Node's
  // type-stripping loader refuses that syntax, and `pnpm test` runs the sources
  // directly (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  constructor(message: string, authRequired = false) {
    super(message);
    this.name = "McpError";
    this.authRequired = authRequired;
  }
}

/** One tool as the MCP server described it. */
export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments — forwarded to the LLM verbatim */
  inputSchema: Record<string, unknown>;
  /** which configured server it came from */
  server: string;
}

/** A server config, as it lives in the teapot config file. */
export interface McpServerConfig {
  name: string;
  /** http(s) URL for the network transports; omitted for stdio */
  url?: string;
  /** stdio: the command to spawn */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** stdio: working directory (Agent Plugins sets this from the plugin root/data) */
  cwd?: string;
  /** static headers for every request (Authorization, X-Api-Key, …) */
  headers?: Record<string, string>;
  /** "http" (default when url is set) | "sse" (legacy) | "stdio" */
  transport?: "http" | "sse" | "stdio";
  /** disabled servers are listed but not connected */
  enabled?: boolean;
  /** per-request timeout, ms */
  timeoutMs?: number;
}

const PROTOCOL_VERSION = "2025-06-18";
/** versions we accept from a server's `initialize` reply */
const KNOWN_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
/** a response larger than this is not a tool result, it is a mistake */
const MAX_RESPONSE_BYTES = 2_000_000;
/** hard stop on tools/list pagination ("did not finish" is a real server bug) */
const MAX_PAGES = 50;

function parseJson(text: string, what: string): Rpc {
  try {
    return JSON.parse(text) as Rpc;
  } catch {
    // keep the offending body visible: servers behind an auth page or proxy answer
    // HTML with a JSON content type, and "invalid JSON" alone hides that
    throw new McpError(`${what} returned invalid JSON: ${text.slice(0, 200)}`);
  }
}

/** pull the `data:` payloads out of one SSE event block */
function sseData(block: string): string {
  return block
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n");
}

/**
 * Read a Streamable-HTTP reply until the JSON-RPC message with `id` arrives.
 *
 * Exported for tests: the two reply shapes (plain JSON, SSE) and the "stream ends
 * without our id" case are exactly what breaks against real servers, and they are
 * awkward to provoke through a live one.
 */
export async function readRpcResult(
  response: Response,
  id: number,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  const reader = response.body?.getReader();
  if (!reader) throw new McpError("MCP server returned an empty response");
  const decoder = new TextDecoder();
  let buf = "";
  let size = 0;
  const resolve = (rpc: Rpc): unknown => {
    if (rpc.id !== id) throw new McpError("Invalid MCP response (id mismatch)");
    if (rpc.error) throw new McpError(`MCP error: ${rpc.error.message ?? "request failed"}`);
    if (rpc.result === undefined) throw new McpError("MCP response has no result");
    return rpc.result;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        size += value.byteLength;
        if (size > maxBytes) throw new McpError("MCP response is too large");
      }
      buf += decoder.decode(value, { stream: !done });
      if (type.includes("text/event-stream")) {
        // normalise CRLF after decoding, including a CRLF split across two chunks
        buf = buf.replace(/\r\n/g, "\n");
        let end = buf.indexOf("\n\n");
        while (end !== -1 || (done && buf.length > 0)) {
          if (end === -1) end = buf.length;
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const data = sseData(block);
          if (data) {
            const rpc = parseJson(data, "MCP event");
            // notifications and unrelated ids are skipped: a server is allowed to
            // interleave them on the stream, and only OUR id ends the read
            if (rpc.id === id) return resolve(rpc);
          }
          end = buf.indexOf("\n\n");
        }
      } else if (done) {
        if (!type.includes("application/json"))
          throw new McpError(
            "MCP endpoint must answer with JSON or text/event-stream (Streamable HTTP) — " +
              `got ${type || "no content-type"}`,
          );
        return resolve(parseJson(buf, "MCP server"));
      }
      if (done) throw new McpError("MCP stream ended without a matching response");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** a live connection: one call surface, whatever the transport */
export interface McpConnection {
  tools(): Promise<McpTool[]>;
  call(name: string, args: unknown): Promise<{ text: string; ok: boolean }>;
  close(): Promise<void>;
}

/** shared state for the two network transports */
async function connectHttp(cfg: McpServerConfig): Promise<McpConnection> {
  if (!cfg.url) throw new McpError(`MCP server "${cfg.name}" has no url`);
  let parsed: URL;
  try {
    parsed = new URL(cfg.url);
  } catch {
    throw new McpError(`MCP server "${cfg.name}" has an invalid url: ${cfg.url}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new McpError(`MCP server "${cfg.name}" must use http(s), not ${parsed.protocol}`);
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  let sessionId: string | null = null;
  let version: string | null = null;
  let seq = 0;

  const post = async (method: string, params?: unknown, notification = false): Promise<unknown> => {
    const id = notification ? undefined : ++seq;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(cfg.headers ?? {}),
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (version) headers["mcp-protocol-version"] = version;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(parsed, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(notification ? {} : { id }),
          method,
          ...(params === undefined ? {} : { params }),
        }),
        // manual, NOT follow: a redirect is almost always an HTML login page, and
        // following it turns a clear auth problem into a confusing JSON parse error
        redirect: "manual",
        signal: ac.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        throw new McpError(
          `MCP endpoint redirected (HTTP ${res.status} to ${res.headers.get("location") ?? "?"}) — ` +
            "the url may be wrong, or the session expired",
        );
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300);
        if (res.status === 405)
          throw new McpError(
            `MCP endpoint answered 405 — it does not accept POST (Streamable HTTP): ${body || "(no body)"}`,
          );
        throw new McpError(
          `MCP server returned HTTP ${res.status}: ${body || "(no body)"}`,
          res.status === 401 || res.status === 403,
        );
      }
      if (notification) {
        await res.body?.cancel().catch(() => {});
        return undefined;
      }
      if (method === "initialize") sessionId = res.headers.get("mcp-session-id");
      return readRpcResult(res, id!);
    } catch (err) {
      if ((err as Error).name === "AbortError")
        throw new McpError(`MCP request timed out after ${timeoutMs}ms (${cfg.url})`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  const init = (await post("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "teapot", version: "1" },
  })) as { protocolVersion?: string };
  if (!init?.protocolVersion || !KNOWN_VERSIONS.includes(init.protocolVersion))
    throw new McpError(
      `unsupported MCP protocol version: ${init?.protocolVersion ?? "(none)"}`,
    );
  version = init.protocolVersion;
  await post("notifications/initialized", undefined, true);

  const listTools = async (): Promise<McpTool[]> => {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = (await post("tools/list", cursor ? { cursor } : {})) as {
        tools?: unknown;
        nextCursor?: unknown;
      };
      if (!Array.isArray(res?.tools))
        throw new McpError(`MCP tools/list did not return a tools array`);
      for (const t of res.tools as Array<Record<string, unknown>>) {
        // validate rather than trust: a bad definition becomes a bad function spec
        if (typeof t?.name !== "string" || !t.name)
          throw new McpError("MCP tool is missing a name");
        if (typeof t.inputSchema !== "object" || t.inputSchema === null || Array.isArray(t.inputSchema))
          throw new McpError(`MCP tool "${t.name}" has no object inputSchema`);
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          inputSchema: t.inputSchema as Record<string, unknown>,
          server: cfg.name,
        });
      }
      if (res.nextCursor === undefined) return tools;
      if (typeof res.nextCursor !== "string")
        throw new McpError("MCP tools cursor is not a string");
      if (seen.has(res.nextCursor))
        throw new McpError("MCP tool pagination returned the same cursor twice");
      seen.add(res.nextCursor);
      cursor = res.nextCursor;
    }
    throw new McpError(`MCP tools/list did not finish within ${MAX_PAGES} pages`);
  };

  return {
    tools: listTools,
    async call(name, args) {
      const res = (await post("tools/call", { name, arguments: args ?? {} })) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };
      // MCP returns a CONTENT ARRAY, not a string. Concatenate the text parts and
      // name the unsupported ones instead of dropping them silently — a json/pdf
      // part vanishing would look like an empty answer.
      const parts: string[] = [];
      for (const c of res?.content ?? []) {
        if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
        else if (c?.type) parts.push(`[${c.type} content omitted]`);
      }
      return { text: parts.join("\n") || "(no content)", ok: !res?.isError };
    },
    async close() {
      /* HTTP: nothing to tear down — the session dies with the process */
    },
  };
}

/** stdio: newline-delimited JSON-RPC over a child's stdin/stdout */
async function connectStdio(cfg: McpServerConfig): Promise<McpConnection> {
  if (!cfg.command) throw new McpError(`MCP server "${cfg.name}" has no command`);
  const { spawn } = await import("node:child_process");
  const child = spawn(cfg.command, cfg.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(cfg.env ?? {}) },
    // a plugin's PLUGIN_ROOT/PLUGIN_DATA make its own relative paths work; without
    // passing this the server starts in the harness's cwd and cannot find its files
    ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
  });
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  let seq = 0;
  let buf = "";
  let stderr = "";
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const fail = (err: Error) => {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  };
  child.on("error", (e) => fail(new McpError(`MCP server "${cfg.name}" failed to start: ${e.message}`)));
  child.on("exit", (code) =>
    fail(new McpError(`MCP server "${cfg.name}" exited (${code ?? "signal"})${stderr ? `: ${stderr.slice(-300)}` : ""}`)),
  );
  child.stderr?.on("data", (d) => {
    stderr = (stderr + String(d)).slice(-4000);
  });
  child.stdout?.on("data", (d) => {
    buf += String(d);
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch {
        continue; // a server that logs to stdout gets skipped, not fatal
      }
      if (typeof msg.id !== "number") continue; // notification
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new McpError(`MCP error: ${msg.error.message ?? "request failed"}`));
      else p.resolve(msg.result);
    }
  });

  const request = (method: string, params?: unknown): Promise<unknown> => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new McpError(`MCP request timed out after ${timeoutMs}ms (${method})`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
    });
  };
  const notify = (method: string, params?: unknown) =>
    child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }) + "\n");

  const init = (await request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "teapot", version: "1" },
  })) as { protocolVersion?: string };
  if (!init?.protocolVersion || !KNOWN_VERSIONS.includes(init.protocolVersion))
    throw new McpError(`unsupported MCP protocol version: ${init?.protocolVersion ?? "(none)"}`);
  notify("notifications/initialized");

  return {
    async tools() {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = (await request("tools/list", cursor ? { cursor } : {})) as {
          tools?: unknown;
          nextCursor?: unknown;
        };
        if (!Array.isArray(res?.tools)) throw new McpError("MCP tools/list did not return a tools array");
        for (const t of res.tools as Array<Record<string, unknown>>) {
          if (typeof t?.name !== "string" || !t.name) throw new McpError("MCP tool is missing a name");
          if (typeof t.inputSchema !== "object" || t.inputSchema === null || Array.isArray(t.inputSchema))
            throw new McpError(`MCP tool "${t.name}" has no object inputSchema`);
          tools.push({
            name: t.name,
            description: typeof t.description === "string" ? t.description : "",
            inputSchema: t.inputSchema as Record<string, unknown>,
            server: cfg.name,
          });
        }
        if (res.nextCursor === undefined) return tools;
        if (typeof res.nextCursor !== "string") throw new McpError("MCP tools cursor is not a string");
        if (seen.has(res.nextCursor)) throw new McpError("MCP tool pagination returned the same cursor twice");
        seen.add(res.nextCursor);
        cursor = res.nextCursor;
      }
      throw new McpError(`MCP tools/list did not finish within ${MAX_PAGES} pages`);
    },
    async call(name, args) {
      const res = (await request("tools/call", { name, arguments: args ?? {} })) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };
      const parts: string[] = [];
      for (const c of res?.content ?? []) {
        if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
        else if (c?.type) parts.push(`[${c.type} content omitted]`);
      }
      return { text: parts.join("\n") || "(no content)", ok: !res?.isError };
    },
    async close() {
      child.kill();
    },
  };
}

/** connect to one configured server */
export async function connectMcp(cfg: McpServerConfig): Promise<McpConnection> {
  const transport = cfg.transport ?? (cfg.command && !cfg.url ? "stdio" : "http");
  if (transport === "stdio") return connectStdio(cfg);
  if (transport === "sse") return connectLegacySse(cfg);
  return connectHttp(cfg);
}

/**
 * Legacy HTTP+SSE (2024-11-05): a GET holds an event stream open, the server sends an
 * `endpoint` event naming a POST url, and replies to POSTs arrive ON the GET stream.
 *
 * Kept separate from `connectHttp` because the request/reply plumbing is genuinely
 * different — there is no response body to read a result from — and folding them
 * together produced a function that could not be followed.
 */
async function connectLegacySse(cfg: McpServerConfig): Promise<McpConnection> {
  if (!cfg.url) throw new McpError(`MCP server "${cfg.name}" has no url`);
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const ac = new AbortController();
  const res = await fetch(cfg.url, {
    headers: { accept: "text/event-stream", ...(cfg.headers ?? {}) },
    signal: ac.signal,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new McpError(
      `MCP (legacy SSE) endpoint returned HTTP ${res.status}`,
      res.status === 401 || res.status === 403,
    );
  }
  const reader = res.body?.getReader();
  if (!reader) throw new McpError("MCP (legacy SSE) endpoint returned an empty stream");
  const decoder = new TextDecoder();
  let endpoint: string | null = null;
  let buf = "";
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new McpError(`MCP (legacy SSE) did not send an endpoint within ${timeoutMs}ms`)),
      timeoutMs,
    );
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          buf = buf.replace(/\r\n/g, "\n");
          let end = buf.indexOf("\n\n");
          while (end !== -1) {
            const block = buf.slice(0, end);
            buf = buf.slice(end + 2);
            end = buf.indexOf("\n\n");
            const ev = (/^event:\s*(.+)$/m.exec(block)?.[1] ?? "message").trim();
            const data = sseData(block);
            if (ev === "endpoint" && data) {
              endpoint = new URL(data, cfg.url).toString();
              clearTimeout(timer);
              resolve();
              continue;
            }
            if (!data) continue;
            let msg: Rpc;
            try {
              msg = JSON.parse(data) as Rpc;
            } catch {
              continue;
            }
            if (typeof msg.id !== "number") continue;
            const p = pending.get(msg.id);
            if (!p) continue;
            pending.delete(msg.id);
            if (msg.error) p.reject(new McpError(`MCP error: ${msg.error.message ?? "request failed"}`));
            else p.resolve(msg.result);
          }
        }
        clearTimeout(timer);
        reject(new McpError("MCP (legacy SSE) stream closed"));
      } catch (e) {
        clearTimeout(timer);
        reject(e as Error);
      }
    })();
  });
  await ready;
  if (!endpoint) throw new McpError("MCP (legacy SSE) stream exposed no endpoint");
  const postUrl = endpoint;

  const send = async (method: string, params?: unknown, notification = false): Promise<unknown> => {
    const id = ++seq;
    const body: Rpc = {
      jsonrpc: "2.0",
      ...(notification ? {} : { id }),
      method,
      ...(params === undefined ? {} : { params }),
    };
    const r = await fetch(postUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.headers ?? {}) },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    await r.body?.cancel().catch(() => {});
    if (!r.ok)
      throw new McpError(`MCP (legacy SSE) POST returned HTTP ${r.status}`, r.status === 401 || r.status === 403);
    if (notification) return undefined;
    // the reply arrives on the GET stream, so wait for it there
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new McpError(`MCP request timed out after ${timeoutMs}ms (${method})`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  };

  const init = (await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "teapot", version: "1" },
  })) as { protocolVersion?: string };
  if (!init?.protocolVersion || !KNOWN_VERSIONS.includes(init.protocolVersion))
    throw new McpError(`unsupported MCP protocol version: ${init?.protocolVersion ?? "(none)"}`);
  await send("notifications/initialized", undefined, true);

  return {
    async tools() {
      const out: McpTool[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = (await send("tools/list", cursor ? { cursor } : {})) as {
          tools?: unknown;
          nextCursor?: unknown;
        };
        if (!Array.isArray(r?.tools)) throw new McpError("MCP tools/list did not return a tools array");
        for (const t of r.tools as Array<Record<string, unknown>>) {
          if (typeof t?.name !== "string" || !t.name) throw new McpError("MCP tool is missing a name");
          if (typeof t.inputSchema !== "object" || t.inputSchema === null || Array.isArray(t.inputSchema))
            throw new McpError(`MCP tool "${t.name}" has no object inputSchema`);
          out.push({
            name: t.name,
            description: typeof t.description === "string" ? t.description : "",
            inputSchema: t.inputSchema as Record<string, unknown>,
            server: cfg.name,
          });
        }
        if (r.nextCursor === undefined) return out;
        if (typeof r.nextCursor !== "string") throw new McpError("MCP tools cursor is not a string");
        if (seen.has(r.nextCursor)) throw new McpError("MCP tool pagination returned the same cursor twice");
        seen.add(r.nextCursor);
        cursor = r.nextCursor;
      }
      throw new McpError(`MCP tools/list did not finish within ${MAX_PAGES} pages`);
    },
    async call(name, args) {
      const r = (await send("tools/call", { name, arguments: args ?? {} })) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };
      const parts: string[] = [];
      for (const c of r?.content ?? []) {
        if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
        else if (c?.type) parts.push(`[${c.type} content omitted]`);
      }
      return { text: parts.join("\n") || "(no content)", ok: !r?.isError };
    },
    async close() {
      ac.abort();
      await reader.cancel().catch(() => {});
    },
  };
}
