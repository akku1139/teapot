/**
 * The MCP server registry (#67): keeps connections, discovers tools, and dispatches
 * calls.
 *
 * Why a registry instead of connecting per agent: several agents usually want the same
 * server, and a stdio server is a PROCESS. One connection per agent would spawn one
 * server per agent, each with its own state and its own startup cost. The pool keys by
 * server name, so N agents share one connection — and a `tools/call` is still
 * per-agent, because the arguments are.
 *
 * Naming. Two servers may both expose `search`, and a server may expose a name that
 * collides with a built-in tool (`bash`, `read_file`). Every MCP tool is therefore
 * exposed to the model as `mcp__<server>__<tool>`, which cannot collide with a
 * built-in (those have no `__`) and tells the model where the result came from. The
 * original name is what gets sent to the server.
 */
import { connectMcp, McpError, type McpConnection, type McpServerConfig, type McpTool } from "./mcp.ts";
import { oauth, type OAuthFlowStatus } from "./mcp-oauth-manager.ts";

/** the prefix a model-visible MCP tool name carries */
export const MCP_PREFIX = "mcp__";

/** `mcp__server__tool` — the flat name handed to the LLM */
export function flattenToolName(server: string, tool: string): string {
  // `__` is the separator, so a server or tool name containing it would be ambiguous.
  // Collapse runs rather than rejecting: a server called "my__server" is unusual but
  // not worth failing over, and the mapping stays stable.
  const s = server.replace(/__/g, "_");
  return `${MCP_PREFIX}${s}__${tool}`;
}

/** pull the parts back out of a flat name, or null when it is not an MCP tool */
export function splitToolName(flat: string): { server: string; tool: string } | null {
  if (!flat.startsWith(MCP_PREFIX)) return null;
  const rest = flat.slice(MCP_PREFIX.length);
  const at = rest.indexOf("__");
  if (at <= 0 || at === rest.length - 2) return null;
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

export interface McpServerState {
  config: McpServerConfig;
  connection?: McpConnection;
  tools: McpTool[];
  status: "disconnected" | "connecting" | "connected" | "error" | "disabled";
  lastError?: string;
  lastChecked?: number;
  /** a 401 challenge said this server wants OAuth; the panel offers "authorize" */
  oauthRequired?: boolean;
}

export class McpRegistry {
  private servers = new Map<string, McpServerState>();

  /** replace the configured server list (on boot and after a settings save) */
  apply(configs: McpServerConfig[]): void {
    const wanted = new Set(configs.map((c) => c.name));
    // drop connections for servers that were removed or renamed
    for (const [name, st] of this.servers) {
      if (!wanted.has(name)) {
        void st.connection?.close();
        this.servers.delete(name);
      }
    }
    for (const cfg of configs) {
      const prev = this.servers.get(cfg.name);
      // a config EDIT means the old connection is pointing at the wrong thing
      const changed = Boolean(prev) && JSON.stringify(prev!.config) !== JSON.stringify(cfg);
      if (changed) void prev!.connection?.close();
      const reuse = prev && !changed;
      const status: McpServerState["status"] =
        cfg.enabled === false ? "disabled" : reuse ? prev!.status : "disconnected";
      const next: McpServerState = {
        config: cfg,
        tools: reuse ? prev!.tools : [],
        status,
      };
      if (reuse && prev!.connection) next.connection = prev!.connection;
      if (reuse && prev!.lastError) next.lastError = prev!.lastError;
      if (reuse && prev!.lastChecked) next.lastChecked = prev!.lastChecked;
      this.servers.set(cfg.name, next);
    }
  }

  names(): string[] {
    return [...this.servers.keys()];
  }

  states(): McpServerState[] {
    return [...this.servers.values()];
  }

  /** the OAuth state for one server, for the settings panel */
  oauthStatus(name: string): OAuthFlowStatus {
    return oauth.status(name);
  }

  /**
   * Connect one server (idempotent) and discover its tools.
   *
   * A 401 is not the end of the story: an OAuth-protected server answers with a Bearer
   * challenge, so on auth failure we DETECT and RECORD that, which is what lets the
   * settings panel offer "authorize" instead of showing a bare "error". Detection is
   * tried BEFORE the challenge reaches the operator — the reference implementations do
   * the same, and it turns "it just says 401" into "click authorize".
   */
  async connect(name: string): Promise<McpServerState> {
    const st = this.servers.get(name);
    if (!st) throw new McpError(`no such MCP server: ${name}`);
    if (st.config.enabled === false) {
      st.status = "disabled";
      return st;
    }
    if (st.status === "connected" && st.connection) return st;
    st.status = "connecting";
    st.lastError = undefined;
    // Attach the OAuth authorization when a grant exists, resolved PER REQUEST so a
    // refreshed token takes effect without reconnecting.
    const withOAuth: McpServerConfig = {
      ...st.config,
      oauthAuthorization: () => oauth.authorization(name),
      onUnauthorized: () => oauth.invalidate(name),
    };
    try {
      const conn = await connectMcp(withOAuth);
      const tools = await conn.tools();
      st.connection = conn;
      st.tools = tools;
      st.status = "connected";
      st.lastChecked = Date.now();
      return st;
    } catch (err) {
      st.status = "error";
      st.lastError = (err as Error).message;
      st.lastChecked = Date.now();
      st.connection = undefined;
      st.tools = [];
      // A 401 means "find out what auth this wants" — the challenge names it. Only for
      // HTTP transports: a stdio server has no OAuth to discover.
      if (err instanceof McpError && err.authRequired && st.config.url) {
        try {
          const d = await oauth.detect(name, st.config.url, {
            ...(st.config.headers ? { headers: st.config.headers } : {}),
          });
          if (d.requiresOAuth) {
            st.oauthRequired = true;
            st.lastError =
              `this server requires OAuth` +
              (d.authServer
                ? ` (authorization server: ${new URL(d.authServer.authorizationEndpoint).host})`
                : d.reason
                  ? ` — ${d.reason}`
                  : "") +
              " — use “authorize” in ⚙ settings → MCP servers";
          }
        } catch {
          /* detection is best-effort: the original error stands */
        }
      }
      throw err;
    }
  }

  /** connect every enabled server; failures are recorded, never thrown */
  async connectAll(): Promise<void> {
    await Promise.all(
      [...this.servers.keys()].map(async (n) => {
        try {
          await this.connect(n);
        } catch {
          /* recorded in the state; one dead server must not stop the others */
        }
      }),
    );
  }

  /** every tool from every CONNECTED server, flattened */
  allTools(): McpTool[] {
    return [...this.servers.values()]
      .filter((s) => s.status === "connected")
      .flatMap((s) => s.tools);
  }

  /** dispatch a flattened name; returns null when it is not an MCP tool */
  async call(flatName: string, args: unknown): Promise<{ ok: boolean; text: string } | null> {
    const parts = splitToolName(flatName);
    if (!parts) return null;
    const st = this.servers.get(parts.server);
    if (!st) return { ok: false, text: `no such MCP server: ${parts.server}` };
    // a call for a server that is configured but not yet connected should connect on
    // demand rather than fail: the operator adding a tool mid-session must not need a
    // restart, and auto-connect is cheap for the HTTP transports
    if (st.status !== "connected" || !st.connection) {
      try {
        await this.connect(parts.server);
      } catch (err) {
        return { ok: false, text: `MCP server "${parts.server}" is not connected: ${(err as Error).message}` };
      }
    }
    try {
      const r = await this.servers.get(parts.server)!.connection!.call(parts.tool, args);
      return { ok: r.ok, text: r.text };
    } catch (err) {
      return { ok: false, text: `MCP call failed: ${(err as Error).message}` };
    }
  }

  async closeAll(): Promise<void> {
    for (const st of this.servers.values()) await st.connection?.close();
    for (const st of this.servers.values()) {
      st.connection = undefined;
      st.status = st.config.enabled === false ? "disabled" : "disconnected";
    }
  }
}

/** process-wide registry: one connection per server, shared by every agent */
export const mcp = new McpRegistry();
