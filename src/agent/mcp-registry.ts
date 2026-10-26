
import type { McpAuth, McpConnection, McpServerConfig, McpTool } from "./mcp.ts";
const connectMcp = async (...args: Parameters<typeof import("./mcp.ts").connectMcp>) =>
  (await import("./mcp.ts")).connectMcp(...args);
import {
  FLOW_TIMEOUT_MS,
  McpAuthStore,
  ServerAuth,
  listenForCallback,
  type OAuthStatus,
} from "./mcp-oauth-manager.ts";

export const MCP_PREFIX = "mcp__";

export function flattenToolName(server: string, tool: string): string {
  const s = server.replace(/__/g, "_");
  return `${MCP_PREFIX}${s}__${tool}`;
}

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
  status: "disconnected" | "connecting" | "connected" | "error" | "disabled" | "authorizing";
  lastError?: string;
  lastChecked?: number;
  oauthRequired?: boolean;
}

interface PendingFlow {
  server: string;
  redirectUrl: string;
  wait: (timeoutMs: number) => Promise<{ code: string; iss?: string }>;
  close: () => Promise<void>;
}

export class McpRegistry {
  private servers = new Map<string, McpServerState>();
  private auths = new Map<string, ServerAuth>();
  private store: McpAuthStore | null = null;
  private flows = new Map<string, PendingFlow>();

  init(dataDir: string): void {
    this.store = new McpAuthStore(dataDir);
  }

  apply(configs: McpServerConfig[]): void {
    const wanted = new Set(configs.map((c) => c.name));
    for (const [name, st] of this.servers) {
      if (!wanted.has(name)) {
        void st.connection?.close();
        this.servers.delete(name);
      }
    }
    for (const cfg of configs) {
      const prev = this.servers.get(cfg.name);
      const changed = Boolean(prev) && JSON.stringify(prev!.config) !== JSON.stringify(cfg);
      if (changed) void prev!.connection?.close();
      const reuse = prev && !changed;
      const status: McpServerState["status"] =
        cfg.enabled === false ? "disabled" : reuse ? prev!.status : "disconnected";
      const next: McpServerState = { config: cfg, tools: reuse ? prev!.tools : [], status };
      if (reuse && prev!.connection) next.connection = prev!.connection;
      if (reuse && prev!.lastError) next.lastError = prev!.lastError;
      if (reuse && prev!.lastChecked) next.lastChecked = prev!.lastChecked;
      if (reuse && prev!.oauthRequired) next.oauthRequired = true;
      this.servers.set(cfg.name, next);
    }
  }

  names(): string[] {
    return [...this.servers.keys()];
  }

  states(): McpServerState[] {
    return [...this.servers.values()];
  }

  state(name: string): McpServerState | undefined {
    return this.servers.get(name);
  }

  recordSuccess(name: string, tools: McpServerState["tools"]): void {
    const st = this.servers.get(name);
    if (!st) return; 
    st.status = "connected";
    st.tools = tools;
    st.lastError = undefined;
    st.lastChecked = Date.now();
    st.oauthRequired = false;
  }

  oauthStatus(name: string): OAuthStatus {
    return this.auths.get(name)?.status() ?? { pending: false, authorized: false, expiresAt: null, hasRefreshToken: false, flow: { phase: "idle" } };
  }

  private async authFor(name: string): Promise<ServerAuth | undefined> {
    if (!this.store) return undefined;
    const existing = this.auths.get(name);
    if (existing) return existing;
    const stored = await this.store.get(name);
    const auth = new ServerAuth(name, "http://127.0.0.1/callback", (server, data) =>
      this.store!.set(server, data),
    );
    await auth.hydrate(stored);
    this.auths.set(name, auth);
    return auth;
  }

  async testConfig(cfg: McpServerConfig): Promise<{ tools: McpTool[] }> {
    const auth = await this.authFor(cfg.name);
    const authArg: McpAuth | undefined = auth ? { provider: auth } : undefined;
    const conn = await connectMcp({ ...cfg, enabled: true }, authArg);
    try {
      return { tools: await conn.tools() };
    } finally {
      await conn.close();
    }
  }

  async connect(name: string): Promise<McpServerState> {
    const st = this.servers.get(name);
    if (!st) throw new Error(`no such MCP server: ${name}`);
    if (st.config.enabled === false) {
      st.status = "disabled";
      return st;
    }
    if (st.status === "connected" && st.connection) {
      try {
        st.tools = await st.connection.tools();
        st.lastChecked = Date.now();
        return st;
      } catch {
        st.connection = undefined;
        st.tools = [];
        st.status = "disconnected";
      }
    }
    st.status = "connecting";
    st.lastError = undefined;
    const auth = await this.authFor(name);
    const authArg: McpAuth | undefined = auth ? { provider: auth } : undefined;
    try {
      const conn = await connectMcp(st.config, authArg);
      st.connection = conn;
      st.tools = await conn.tools();
      st.status = "connected";
      st.lastChecked = Date.now();
      st.oauthRequired = false;
      return st;
    } catch (err) {
      st.status = "error";
      st.lastError = (err as Error).message;
      st.lastChecked = Date.now();
      st.connection = undefined;
      st.tools = [];
      const status = (err as { status?: unknown }).status;
      const msg = (err as Error).message ?? "";
      const needsAuth =
        status === 401 ||
        status === 403 ||
        /unauthoriz|invalid_token|authorization required/i.test(msg);
      if (needsAuth) {
        st.oauthRequired = true;
        st.lastError = "this server requires OAuth — use 🔑 authorize in ⚙️ settings → MCP servers";
      }
      throw err;
    }
  }

  async connectAll(): Promise<void> {
    await Promise.all(
      [...this.servers.keys()].map(async (n) => {
        try {
          await this.connect(n);
        } catch {
        }
      }),
    );
  }

  allTools(): McpTool[] {
    return [...this.servers.values()]
      .filter((s) => s.status === "connected")
      .flatMap((s) => s.tools);
  }

  async call(flatName: string, args: unknown): Promise<{ ok: boolean; text: string } | null> {
    const parts = splitToolName(flatName);
    if (!parts) return null;
    const st = this.servers.get(parts.server);
    if (!st) return { ok: false, text: `no such MCP server: ${parts.server}` };
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
      const st = this.servers.get(parts.server);
      if (st) {
        st.connection = undefined;
        st.tools = [];
        st.status = "disconnected";
        st.lastError = (err as Error).message;
        st.lastChecked = Date.now();
      }
      return { ok: false, text: `MCP call failed: ${(err as Error).message}` };
    }
  }

  registerUnsaved(cfg: McpServerConfig): void {
    const existing = this.servers.get(cfg.name);
    if (existing?.connection) return;
    if (existing) existing.config = cfg;
    else this.servers.set(cfg.name, { config: cfg, status: "disconnected", tools: [] } as never);
  }

  async startOAuth(name: string, opts: { scopes?: string[] } = {}): Promise<{ url: string }> {
    const st = this.servers.get(name);
    if (!st) throw new Error(`no such MCP server: ${name}`);
    if (!st.config.url) throw new Error("OAuth needs an http(s) url; a stdio server has no authorizer");
    const existing = this.flows.get(name);
    if (existing) await this.finishFlow(name, existing);

    const loop = await listenForCallback();
    const auth = new ServerAuth(name, loop.redirectUrl, (server, data) => this.store!.set(server, data));
    if (this.store) await auth.hydrate(await this.store.get(name));
    this.auths.set(name, auth);

    const pending: PendingFlow = {
      server: name,
      redirectUrl: loop.redirectUrl,
      wait: loop.wait,
      close: loop.close,
    };
    this.flows.set(name, pending);

    st.oauthRequired = true;
    let pendingConn: McpConnection | null = null;
    try {
      const conn = await connectMcp(st.config, { provider: auth });
      st.connection = conn;
      st.tools = await conn.tools();
      st.status = "connected";
      st.oauthRequired = false;
      await this.finishFlow(name, pending);
      return { url: "" };
    } catch (err) {
      pendingConn = (err as { connection?: McpConnection }).connection ?? null;
      const url = auth.pendingUrl();
      if (!url) {
        const message = (err as Error).message;
        auth.markError(message);
        await this.finishFlow(name, pending);
        throw new Error(`could not start the authorization flow: ${message}`);
      }
      st.status = "authorizing";
      void (async () => {
        try {
          const { code, iss } = await loop.wait(FLOW_TIMEOUT_MS);
          const conn = pendingConn;
          if (!conn) throw new Error("the authorization flow lost its connection");
          const live = await conn.finishAuth(code, iss ?? auth.expectedIssuer());
          await conn.close().catch(() => {});
          st.connection = live;
          st.tools = await live.tools();
          st.status = "connected";
          st.oauthRequired = false;
          st.lastError = undefined;
          await this.finishFlow(name, pending);
        } catch (e) {
          const err = e as Error & { cause?: unknown };
          const name = err.constructor?.name ?? "Error";
          const cause = err.cause instanceof Error ? err.cause.message : String(err.cause ?? "");
          const detail = [err.message, cause && cause !== err.message ? `(${cause})` : ""]
            .filter(Boolean)
            .join(" ");
          const message = `${name}: ${detail}`;
          auth.markError(message);
          if (st.status === "authorizing") st.status = "error";
          st.lastError = message;
          await this.finishFlow(name, pending);
        }
      })();
      return { url };
    }
  }

  private async finishFlow(name: string, f: PendingFlow): Promise<void> {
    if (this.flows.get(name) === f) this.flows.delete(name);
    await f.close().catch(() => {});
  }

  async disconnect(name: string): Promise<void> {
    const auth = this.auths.get(name);
    if (auth) await auth.clear();
    const st = this.servers.get(name);
    if (st) {
      await st.connection?.close().catch(() => {});
      st.connection = undefined;
      st.tools = [];
      st.status = st.config.enabled === false ? "disabled" : "disconnected";
      st.oauthRequired = false;
    }
  }

  async closeAll(): Promise<void> {
    for (const f of this.flows.values()) await f.close().catch(() => {});
    this.flows.clear();
    for (const st of this.servers.values()) await st.connection?.close().catch(() => {});
    for (const st of this.servers.values()) {
      st.connection = undefined;
      st.status = st.config.enabled === false ? "disabled" : "disconnected";
    }
  }
}

export const mcp = new McpRegistry();
