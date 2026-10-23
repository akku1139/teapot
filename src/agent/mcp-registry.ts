/**
 * The MCP server registry (#67): connections, tool discovery, dispatch, and the OAuth
 * flow's plumbing.
 *
 * Why a registry instead of connecting per agent: several agents usually want the same
 * server, and a stdio server is a PROCESS. The pool keys by server name, so N agents share
 * one connection — and a `tools/call` is still per-agent, because the arguments are.
 *
 * Naming. Two servers may both expose `search`, and a server may expose a name that
 * collides with a built-in tool (`bash`, `read_file`). Every MCP tool is therefore exposed
 * as `mcp__<server>__<tool>`, which cannot collide with a built-in (those have no `__`)
 * and tells the model where a result came from.
 *
 * OAuth lives here because it is per SERVER (one grant, shared by every agent) while the
 * protocol itself belongs to the SDK — see `mcp-oauth-manager.ts` for the provider.
 */

import { connectMcp, type McpAuth, type McpConnection, type McpServerConfig, type McpTool } from "./mcp.ts";
import {
  FLOW_TIMEOUT_MS,
  McpAuthStore,
  ServerAuth,
  listenForCallback,
  type OAuthStatus,
} from "./mcp-oauth-manager.ts";

/** the prefix a model-visible MCP tool name carries */
export const MCP_PREFIX = "mcp__";

/** `mcp__server__tool` — the flat name handed to the LLM */
export function flattenToolName(server: string, tool: string): string {
  // `__` is the separator, so a server or tool name containing it would be ambiguous.
  // Collapse runs rather than rejecting: a server called "my__server" is unusual but not
  // worth failing over, and the mapping stays stable.
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
  status: "disconnected" | "connecting" | "connected" | "error" | "disabled" | "authorizing";
  lastError?: string;
  lastChecked?: number;
  /** a 401 challenge said this server wants OAuth */
  oauthRequired?: boolean;
}

/** one in-flight authorization: the listener and the server it belongs to */
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

  /**
   * Point the registry at its grant store. Called once at boot; until then OAuth is
   * inert (no grant is read from an assumed location).
   */
  init(dataDir: string): void {
    this.store = new McpAuthStore(dataDir);
  }

  /** replace the configured server list (on boot and after a settings save) */
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
      // a config EDIT means the old connection is pointing at the wrong thing
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

  /** the OAuth state of one server, for the settings panel */
  oauthStatus(name: string): OAuthStatus {
    return this.auths.get(name)?.status() ?? { pending: false, authorized: false, expiresAt: null, hasRefreshToken: false, flow: { phase: "idle" } };
  }

  /**
   * The provider for one server, created on demand.
   *
   * The redirect URL here is used for CLIENT REGISTRATION, not just for the authorization request:
   * `clientMetadata.redirect_uris` is what gets registered on the first connect. A portless
   * placeholder therefore registers a redirect URI the real flow can never match — MEASURED, that
   * is exactly what happened (stored `redirect_uris: ["http://127.0.0.1/callback"]`), and it is why
   * a completed Notion authorization left no access token.
   *
   * `ServerAuth.clientInformation()` now refuses a registration whose URI differs from the current
   * one, so a stale record is re-made instead of reused. This value still cannot carry the real
   * port — none is known until `startOAuth` opens one — but it is now harmless, and keeping a
   * long-lived provider bound to a port that is not listening would be worse.
   */
  private async authFor(name: string): Promise<ServerAuth | undefined> {
    if (!this.store) return undefined;
    const existing = this.auths.get(name);
    if (existing) return existing;
    const stored = await this.store.get(name);
    // a flow needs a redirect; the SDK only reads it during authorize, and
    // `startOAuth` replaces the instance with one carrying the real port
    const auth = new ServerAuth(name, "http://127.0.0.1/callback", (server, data) =>
      this.store!.set(server, data),
    );
    await auth.hydrate(stored);
    this.auths.set(name, auth);
    return auth;
  }

  /** connect one server (idempotent) and discover its tools */
  async connect(name: string): Promise<McpServerState> {
    const st = this.servers.get(name);
    if (!st) throw new Error(`no such MCP server: ${name}`);
    if (st.config.enabled === false) {
      st.status = "disabled";
      return st;
    }
    if (st.status === "connected" && st.connection) return st;
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
      // The SDK reports a missing grant as an UnauthorizedError (or an HTTP 401); both
      // mean "authorize", which is a different situation from "broken".
      // The SDK reports a missing grant as an HTTP error carrying the STATUS. Reading
      // `status` is reliable; matching the message text is not, because the SDK's message
      // is just "Error POSTing to endpoint: <body>" and a server may send an empty body —
      // MEASURED with a bare 401, which produced no "401" anywhere in the text.
      const status = (err as { status?: unknown }).status;
      const msg = (err as Error).message ?? "";
      const needsAuth =
        status === 401 ||
        status === 403 ||
        /unauthoriz|invalid_token|authorization required/i.test(msg);
      if (needsAuth) {
        st.oauthRequired = true;
        st.lastError = "this server requires OAuth — use 🔑 authorize in ⚙ settings → MCP servers";
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
    // a call for a configured-but-unconnected server connects on demand: adding one
    // mid-session must not need a restart
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

  /**
   * Start an OAuth flow.
   *
   * Opens the loopback listener, points the provider at it, and makes a connect attempt
   * so the SDK performs discovery and produces the authorization URL. The returned URL is
   * what the UI opens; the promise behind it settles when the browser comes back.
   */
  async startOAuth(name: string, opts: { scopes?: string[] } = {}): Promise<{ url: string }> {
    const st = this.servers.get(name);
    if (!st) throw new Error(`no such MCP server: ${name}`);
    if (!st.config.url) throw new Error("OAuth needs an http(s) url; a stdio server has no authorizer");
    const existing = this.flows.get(name);
    if (existing) await this.finishFlow(name, existing);

    const loop = await listenForCallback();
    // a provider bound to THIS listener's port
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

    // A connect attempt is what drives the SDK: it discovers the authorization server,
    // registers a client if needed, and calls redirectToAuthorization before throwing.
    st.oauthRequired = true;
    try {
      const conn = await connectMcp(st.config, { provider: auth });
      // already authorized (a stored refresh token was good): no flow needed
      st.connection = conn;
      st.tools = await conn.tools();
      st.status = "connected";
      st.oauthRequired = false;
      await this.finishFlow(name, pending);
      return { url: "" };
    } catch (err) {
      const url = auth.pendingUrl();
      if (!url) {
        const message = (err as Error).message;
        auth.markError(message);
        await this.finishFlow(name, pending);
        throw new Error(`could not start the authorization flow: ${message}`);
      }
      st.status = "authorizing";
      // complete in the background once the browser arrives
      void (async () => {
        try {
          const { code, iss } = await loop.wait(FLOW_TIMEOUT_MS);
          const conn = await connectMcp(st.config, { provider: auth });
          /**
           * Supply `iss` from OUR discovery record when the callback omitted it.
           *
           * RFC 9207 §2 says a server that advertises
           * `authorization_response_iss_parameter_supported: true` MUST include `iss` in the
           * response, and §2.4 says clients MUST reject a response without it. Notion advertises
           * `true` and then sends only `code` and `state`, so a strictly-conforming client discards
           * every completed authorization — which is "Notionがコールバック踏んだのに Unauthorized".
           *
           * §2.4 also allows the opposite: "clients ... MAY accept authorization responses that do
           * not contain the iss parameter ... Local policy or configuration can determine whether to
           * accept such responses". We accept them, using the issuer we recorded BEFORE sending the
           * browser out, because that is the value the mix-up check needs.
           *
           * MEASURED against the real SDK with this machine's stored grant:
           *   no iss      -> IssuerMismatchError "received undefined"   (the reported failure)
           *   correct iss -> the token endpoint is reached (invalid_grant for a dummy code)
           *   wrong iss   -> IssuerMismatchError "received https://evil.example"
           * so the check is not disabled — a genuinely mismatched issuer is still rejected.
           */
          await conn.finishAuth(code, iss ?? auth.expectedIssuer());
          st.connection = conn;
          st.tools = await conn.tools();
          st.status = "connected";
          st.oauthRequired = false;
          st.lastError = undefined;
          await this.finishFlow(name, pending);
        } catch (e) {
          auth.markError((e as Error).message);
          if (st.status === "authorizing") st.status = "error";
          st.lastError = (e as Error).message;
          await this.finishFlow(name, pending);
        }
      })();
      return { url };
    }
  }

  /** close a flow's listener and record its outcome */
  private async finishFlow(name: string, f: PendingFlow): Promise<void> {
    if (this.flows.get(name) === f) this.flows.delete(name);
    await f.close().catch(() => {});
  }

  /** forget a grant (disconnect) */
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

/** process-wide registry: one connection per server, shared by every agent */
export const mcp = new McpRegistry();
