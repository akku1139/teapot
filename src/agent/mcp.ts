/**
 * MCP client (#67), on `@modelcontextprotocol/client` v2.
 *
 * The hand-written protocol layer is GONE. It had been carrying Streamable HTTP, legacy
 * HTTP+SSE and stdio, each with its own JSON-RPC framing, session-id handling and SSE
 * parsing — which is exactly the surface the official client now owns, and protocol
 * details (new protocol versions, new transports, task-based calls) move under it.
 *
 * What teapot keeps is the part that is NOT protocol: which servers are configured, how
 * one connection is shared across agents, tool-name namespacing, and the OAuth STORE
 * (where the grant lives). The SDK supplies the discovery and the flow.
 *
 * Discovery deliberately uses the SDK's own `buildDiscoveryUrls` order rather than a
 * hand-rolled one. MEASURED against the live servers before the rewrite:
 *
 *   GitHub (issuer https://github.com/login/oauth) serves ONLY
 *     https://github.com/.well-known/oauth-authorization-server/login/oauth   200
 *     https://github.com/login/oauth/.well-known/oauth-authorization-server   404
 *   Notion (issuer https://mcp.notion.com, no path) serves the root form.
 *
 * and the SDK tries exactly: RFC 8414 pre-path oauth → pre-path OIDC → post-path OIDC.
 * It does NOT try the post-path `oauth-authorization-server` shape, which is correct —
 * no MCP server is known to publish it, and guessing more shapes risks accepting a
 * document from a different issuer.
 */

/**
 * The MCP SDK is loaded ON DEMAND, not on import.
 *
 * MEASURED: importing `@modelcontextprotocol/client` costs +30MB RSS on its own, and this module is
 * in the server's boot path (through the registry) whether or not any MCP server is configured — on
 * almost every machine, none are. `connectMcp` is already `async`, so a dynamic import there moves
 * the cost to the first actual connection and leaves the baseline alone.
 *
 * The TYPES stay static (they are erased at runtime); only the constructors are resolved lazily.
 * `instanceof` checks are replaced by a capability test, because the classes do not exist until the
 * import has run.
 */
import type { Client } from "@modelcontextprotocol/client";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { SSEClientTransport } from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

type McpSdk = typeof import("@modelcontextprotocol/client") & {
  StdioClientTransport: typeof import("@modelcontextprotocol/client/stdio").StdioClientTransport;
};
let sdkPromise: Promise<McpSdk> | undefined;
/** resolved once, on the first connection attempt */
async function mcpSdk(): Promise<McpSdk> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const [client, stdio] = await Promise.all([
        import("@modelcontextprotocol/client"),
        import("@modelcontextprotocol/client/stdio"),
      ]);
      return { ...client, StdioClientTransport: stdio.StdioClientTransport } as McpSdk;
    })();
  }
  return sdkPromise;
}
import type { OAuthClientProvider } from "@modelcontextprotocol/client";

/** One tool as the server described it. */
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
  /** static headers for every request (X-Api-Key, …) */
  headers?: Record<string, string>;
  /** "http" (default when url is set) | "sse" (legacy) | "stdio" */
  transport?: "http" | "sse" | "stdio";
  /** disabled servers are listed but not connected */
  enabled?: boolean;
  /** per-request timeout, ms */
  timeoutMs?: number;
}

/**
 * What a caller must supply for OAuth: an `OAuthClientProvider`.
 *
 * The SDK's interface already models everything a grant needs (tokens, client
 * information, the code verifier, the redirect), so teapot implements THAT rather than
 * a parallel abstraction — that is what makes "authorize" a matter of handing the
 * provider to the transport and calling `finishAuth(code)` on the callback.
 */
export interface McpAuth {
  provider: OAuthClientProvider;
  /**
   * Called with the authorization code when the loopback callback receives it.
   *
   * Kept here rather than inside the provider because the TRANSPORT owns `finishAuth`:
   * the verifier and the discovery state live on the transport instance, so completing
   * the exchange requires the same transport that started the flow.
   */
  onAuthorizationCode?: (code: string, iss?: string) => void;
}

/** a live connection: one call surface, whatever the transport */
export interface McpConnection {
  tools(): Promise<McpTool[]>;
  call(name: string, args: unknown): Promise<{ text: string; ok: boolean }>;
  /**
   * Complete an OAuth flow with the code from the redirect, returning a USABLE connection.
   *
   * It cannot be `Promise<void>` on this instance: a transport is ONE-SHOT. MEASURED — after the
   * 401 that starts the flow, a second `client.connect(sameTransport)` throws
   * "StreamableHTTPClientTransport already started!" whether or not `close()` was called. So the
   * instance that exchanges the code can never serve requests, and the caller has to get a fresh
   * one back.
   */
  finishAuth(code: string, iss?: string): Promise<McpConnection>;
  close(): Promise<void>;
}

/** pull the text out of an MCP tool result's content array */
function resultText(result: {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}): { text: string; ok: boolean } {
  const parts: string[] = [];
  for (const c of result?.content ?? []) {
    if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
    // name the parts we cannot render rather than dropping them silently: a json or
    // image part vanishing would look like an empty answer
    else if (c?.type) parts.push(`[${c.type} content omitted]`);
  }
  return { text: parts.join("\n") || "(no content)", ok: result?.isError !== true };
}

/** normalise what a server reports into teapot's tool shape */
function toTools(list: { tools?: Array<Record<string, unknown>> }, server: string): McpTool[] {
  const out: McpTool[] = [];
  for (const t of list?.tools ?? []) {
    const name = typeof t.name === "string" ? t.name : "";
    if (!name) continue; // a nameless tool is unusable either way
    const schema = t.inputSchema;
    out.push({
      name,
      description: typeof t.description === "string" ? t.description : "",
      // The SDK VALIDATES that every tool carries an object `inputSchema`, so this
      // fallback is only a type guard — a server that omits it fails at `tools()` before
      // reaching here. Kept so a future protocol version that makes it optional does not
      // hand the model an undefined schema.
      inputSchema:
        schema && typeof schema === "object" && !Array.isArray(schema)
          ? (schema as Record<string, unknown>)
          : { type: "object", properties: {} },
      server,
    });
  }
  return out;
}

/**
 * Connect to one configured server.
 *
 * `auth` is optional: without it the transports send only the static headers, which is
 * the common case (a local server, or a static API key).
 */
function buildConnection(
  cfg: McpServerConfig,
  client: Client,
  session: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport,
  auth?: McpAuth,
): McpConnection {
  return {
    async tools() {
      // one page is the norm; follow the cursor so a server that paginates is not
      // silently truncated
      const all: McpTool[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 50; page++) {
        const res = await client.listTools(cursor ? { cursor } : undefined);
        all.push(...toTools(res as { tools?: Array<Record<string, unknown>> }, cfg.name));
        const next = (res as { nextCursor?: unknown }).nextCursor;
        if (typeof next !== "string") return all;
        if (seen.has(next)) throw new Error("MCP tool pagination returned the same cursor twice");
        seen.add(next);
        cursor = next;
      }
      throw new Error("MCP tools/list did not finish within 50 pages");
    },
    async call(name, args) {
      const res = await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> });
      return resultText(res as { content?: Array<{ type?: string; text?: string }>; isError?: boolean });
    },
    async finishAuth(code, iss) {
      // a capability test, not `instanceof`: the SDK classes do not exist until the import has run
      if (typeof (session as { finishAuth?: unknown }).finishAuth !== "function")
        throw new Error("this transport has no OAuth flow");
      /**
       * Exchange on THIS transport — the PKCE verifier and the discovery record are read from the
       * provider, but the request is issued with this instance's fetch/init.
       */
      await (session as StreamableHTTPClientTransport).finishAuth(
        iss === undefined ? code : (new URLSearchParams({ code, iss }) as never),
      );
      /**
       * …then build a FRESH connection, because this one cannot be revived.
       *
       * A transport is one-shot: after the 401 that started the flow, connecting again throws
       * "already started" even without `close()`. MEASURED, and it is why the flow appeared to
       * complete and then report `UnauthorizedError: Unauthorized` — `client.connect` on a spent
       * transport fails with no message of its own, and the SDK's UnauthorizedError defaults its
       * text to the word "Unauthorized".
       *
       * The provider is shared, so the new instance reads the tokens the exchange just stored.
       */
      await client.close().catch(() => {});
      return await connectMcp(cfg, auth);
    },
    async close() {
      await client.close().catch(() => {});
    },
  };;
}

export async function connectMcp(cfg: McpServerConfig, auth?: McpAuth): Promise<McpConnection> {
  const sdk = await mcpSdk();
  const transport = cfg.transport ?? (cfg.command && !cfg.url ? "stdio" : "http");
  const client = new sdk.Client({ name: "teapot", version: "1" });

  let session: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport;

  if (transport === "stdio") {
    if (!cfg.command) throw new Error(`MCP server "${cfg.name}" has no command`);
    session = new sdk.StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
      // a server that logs to stdout can corrupt the frame stream; the SDK's stderr
      // option ("inherit" by default) is the place to say otherwise
      stderr: "inherit",
    });
  } else if (transport === "sse") {
    if (!cfg.url) throw new Error(`MCP server "${cfg.name}" has no url`);
    const url = new URL(cfg.url);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error(`MCP server "${cfg.name}" must use http(s), not ${url.protocol}`);
    session = new sdk.SSEClientTransport(url, {
      // `manual`, NOT follow: an MCP endpoint that redirects is nearly always an HTML
      // login page, and following it replaces a clear auth problem with a parse error
      redirectPolicy: "same-origin",
      ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {}),
      ...(auth ? { authProvider: auth.provider } : {}),
    });
  } else {
    if (!cfg.url) throw new Error(`MCP server "${cfg.name}" has no url`);
    const url = new URL(cfg.url);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error(`MCP server "${cfg.name}" must use http(s), not ${url.protocol}`);
    session = new sdk.StreamableHTTPClientTransport(url, {
      redirectPolicy: "same-origin",
      ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {}),
      ...(auth ? { authProvider: auth.provider } : {}),
    });
  }

  try {
    await client.connect(session);
  } catch (err) {
    /**
     * A 401 is NOT a dead connection — it is the first half of the OAuth flow.
     *
     * `client.connect()` failing with UnauthorizedError means the server wants a grant. Closing the
     * client here used to destroy the only transport that could complete it: a transport cannot be
     * re-started ("StreamableHTTPClientTransport already started!") and `finishAuth()` exchanges the
     * code through THIS instance's provider, so the second `connect()` after `finishAuth` always
     * threw — surfacing as a bare `UnauthorizedError: Unauthorized` even though the browser had
     * completed the authorization and the token WAS saved.
     *
     * MEASURED: connect → 401; close; connect again → "already started". And with the exchange
     * succeeding, the tokens were present and the connection still failed.
     *
     * So the client stays open when the caller supplied an auth provider (it may need to finish the
     * flow on it). Without a provider there is nothing to complete, so it is closed as before.
     */
    if (!auth) await client.close().catch(() => {});
    /**
     * Attach the connection so the OAuth caller can CONTINUE on this exact instance.
     *
     * The transport that received the 401 is the one that must redeem the code (a transport cannot
     * be restarted), so the caller needs a handle to it — rebuilding one loses the flow.
     */
    if (auth) {
      const conn = buildConnection(cfg, client, session, auth);
      throw Object.assign(err as Error, { connection: conn });
    }
    throw err;
  }

  return buildConnection(cfg, client, session, auth);
}
