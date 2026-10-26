
import type { Client } from "@modelcontextprotocol/client";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { SSEClientTransport } from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

type McpSdk = typeof import("@modelcontextprotocol/client") & {
  StdioClientTransport: typeof import("@modelcontextprotocol/client/stdio").StdioClientTransport;
};
let sdkPromise: Promise<McpSdk> | undefined;
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

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  server: string;
}

export interface McpServerConfig {
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  transport?: "http" | "sse" | "stdio";
  enabled?: boolean;
  timeoutMs?: number;
}

export interface McpAuth {
  provider: OAuthClientProvider;
  onAuthorizationCode?: (code: string, iss?: string) => void;
}

export interface McpConnection {
  tools(): Promise<McpTool[]>;
  call(name: string, args: unknown): Promise<{ text: string; ok: boolean }>;
  finishAuth(code: string, iss?: string): Promise<McpConnection>;
  close(): Promise<void>;
}

function resultText(result: {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}): { text: string; ok: boolean } {
  const parts: string[] = [];
  for (const c of result?.content ?? []) {
    if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c?.type) parts.push(`[${c.type} content omitted]`);
  }
  return { text: parts.join("\n") || "(no content)", ok: result?.isError !== true };
}

function toTools(list: { tools?: Array<Record<string, unknown>> }, server: string): McpTool[] {
  const out: McpTool[] = [];
  for (const t of list?.tools ?? []) {
    const name = typeof t.name === "string" ? t.name : "";
    if (!name) continue; 
    const schema = t.inputSchema;
    out.push({
      name,
      description: typeof t.description === "string" ? t.description : "",
      inputSchema:
        schema && typeof schema === "object" && !Array.isArray(schema)
          ? (schema as Record<string, unknown>)
          : { type: "object", properties: {} },
      server,
    });
  }
  return out;
}

function buildConnection(
  cfg: McpServerConfig,
  client: Client,
  session: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport,
  auth?: McpAuth,
): McpConnection {
  return {
    async tools() {
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
      if (typeof (session as { finishAuth?: unknown }).finishAuth !== "function")
        throw new Error("this transport has no OAuth flow");
      await (session as StreamableHTTPClientTransport).finishAuth(
        iss === undefined ? code : (new URLSearchParams({ code, iss }) as never),
      );
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
      stderr: "inherit",
    });
  } else if (transport === "sse") {
    if (!cfg.url) throw new Error(`MCP server "${cfg.name}" has no url`);
    const url = new URL(cfg.url);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error(`MCP server "${cfg.name}" must use http(s), not ${url.protocol}`);
    session = new sdk.SSEClientTransport(url, {
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
    if (!auth) await client.close().catch(() => {});
    if (auth) {
      const conn = buildConnection(cfg, client, session, auth);
      throw Object.assign(err as Error, { connection: conn });
    }
    throw err;
  }

  return buildConnection(cfg, client, session, auth);
}
