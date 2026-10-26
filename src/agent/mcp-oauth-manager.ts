
import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

interface StoredAuth {
  clientId?: string;
  clientSecret?: string;
  clientInformation?: Record<string, unknown>;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  codeVerifier?: string;
  scope?: string;
  discoveryState?: OAuthDiscoveryState;
}

export type OAuthPhase =
  | { phase: "idle" }
  | { phase: "authorizing"; url: string; startedAt: number }
  | { phase: "done" }
  | { phase: "error"; message: string };

export interface OAuthStatus {
  pending: boolean;
  authorized: boolean;
  expiresAt: number | null;
  hasRefreshToken: boolean;
  clientId?: string;
  flow: OAuthPhase;
  lastError?: string;
}

export const FLOW_TIMEOUT_MS = 5 * 60_000;

export class ServerAuth implements OAuthClientProvider {
  private authUrl?: URL;
  private verifier?: string;
  private flow: OAuthPhase = { phase: "idle" };
  private lastError?: string;
  private store: StoredAuth = {};
  readonly server: string;
  readonly redirectUrl: string;
  private persist: (server: string, data: StoredAuth) => Promise<void>;

  constructor(
    server: string,
    redirectUrl: string,
    persist: (server: string, data: StoredAuth) => Promise<void>,
  ) {
    this.server = server;
    this.redirectUrl = redirectUrl;
    this.persist = persist;
  }

  async hydrate(data: StoredAuth | undefined): Promise<void> {
    if (!data) return;
    this.store = { ...data };
    if (data.codeVerifier) this.verifier = data.codeVerifier;
  }

  snapshot(): StoredAuth {
    return { ...this.store };
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "teapot",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }

  private redirectMatches(recorded: string): boolean {
    if (recorded === this.redirectUrl) return true;
    try {
      const a = new URL(recorded);
      const b = new URL(this.redirectUrl);
      const loopback = (h: string) => h === "127.0.0.1" || h === "::1" || h === "localhost";
      if (!loopback(a.hostname) || !loopback(b.hostname)) return false;
      return a.protocol === b.protocol && a.pathname === b.pathname;
    } catch {
      return false; 
    }
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    if (!this.store.clientId) return undefined;
    const stored = this.store.clientInformation as StoredOAuthClientInformation | undefined;
    if (stored) {
      const uris = Array.isArray((stored as { redirect_uris?: unknown }).redirect_uris)
        ? ((stored as { redirect_uris: unknown[] }).redirect_uris as string[])
        : [];
      if (uris.length === 0) return stored;
      if (uris.some((u) => this.redirectMatches(String(u)))) return stored;
      return undefined;
    }
    return {
      client_id: this.store.clientId,
      ...(this.store.clientSecret ? { client_secret: this.store.clientSecret } : {}),
    } as StoredOAuthClientInformation;
  }

  private registrationIsStale(): boolean {
    const stored = this.store.clientInformation as { redirect_uris?: unknown } | undefined;
    const uris = Array.isArray(stored?.redirect_uris) ? (stored.redirect_uris as string[]) : [];
    if (uris.length === 0) return false; 
    return !uris.some((u) => this.redirectMatches(String(u)));
  }

  async saveClientInformation(info: StoredOAuthClientInformation, _ctx?: unknown): Promise<void> {
    const i = info as { client_id?: unknown; client_secret?: unknown };
    const previous = this.store.clientId;
    if (typeof i?.client_id === "string") this.store.clientId = i.client_id;
    if (typeof i?.client_secret === "string") this.store.clientSecret = i.client_secret;
    if (previous && typeof i?.client_id === "string" && i.client_id !== previous) {
      this.store.accessToken = undefined;
      this.store.refreshToken = undefined;
      this.store.expiresAt = undefined;
    }
    this.store.clientInformation = info as Record<string, unknown>;
    await this.persist(this.server, this.store);
  }

  tokens(_ctx?: unknown): StoredOAuthTokens | undefined {
    if (this.store.accessToken && this.registrationIsStale()) return undefined;
    if (!this.store.accessToken) return undefined;
    return {
      access_token: this.store.accessToken,
      token_type: "Bearer",
      ...(this.store.refreshToken ? { refresh_token: this.store.refreshToken } : {}),
      ...(this.store.expiresAt ? { expires_in: Math.max(0, Math.round((this.store.expiresAt - Date.now()) / 1000)) } : {}),
      ...(this.store.scope ? { scope: this.store.scope } : {}),
    } as StoredOAuthTokens;
  }

  async saveTokens(tokens: StoredOAuthTokens, _ctx?: unknown): Promise<void> {
    this.store.accessToken = tokens.access_token;
    if (tokens.refresh_token) this.store.refreshToken = tokens.refresh_token;
    if (typeof tokens.expires_in === "number" && tokens.expires_in > 0)
      this.store.expiresAt = Date.now() + tokens.expires_in * 1000;
    if (typeof tokens.scope === "string") this.store.scope = tokens.scope;
    this.flow = { phase: "done" };
    await this.persist(this.server, this.store);
  }

  redirectToAuthorization(url: URL): void {
    this.authUrl = url;
    this.flow = { phase: "authorizing", url: url.toString(), startedAt: Date.now() };
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this.verifier = verifier;
    this.store.codeVerifier = verifier;
    await this.persist(this.server, this.store);
  }

  codeVerifier(): string {
    const v = this.verifier ?? this.store.codeVerifier;
    if (!v) throw new Error("no PKCE verifier — the authorization flow did not start here");
    return v;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.store.discoveryState;
  }
  expectedIssuer(): string | undefined {
    const meta = this.store.discoveryState?.authorizationServerMetadata as
      | { issuer?: unknown }
      | undefined;
    if (typeof meta?.issuer === "string" && meta.issuer) return meta.issuer;
    const url = this.store.discoveryState?.authorizationServerUrl;
    return typeof url === "string" && url ? url : undefined;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    if (!state || typeof state !== "object") return;
    this.store.discoveryState = state;
    await this.persist(this.server, this.store);
  }

  pendingUrl(): string | undefined {
    return this.flow.phase === "authorizing" ? this.flow.url : undefined;
  }

  markError(message: string): void {
    this.lastError = message;
    this.flow = { phase: "error", message };
  }

  async clear(): Promise<void> {
    this.store = {};
    this.verifier = undefined;
    this.authUrl = undefined;
    this.flow = { phase: "idle" };
    this.lastError = undefined;
    await this.persist(this.server, this.store);
  }

  status(): OAuthStatus {
    const expiresAt = this.store.expiresAt ?? null;
    const fresh = Boolean(this.store.accessToken) && (expiresAt === null || Date.now() < expiresAt - 60_000);
    return {
      pending: this.flow.phase === "authorizing",
      authorized: fresh,
      expiresAt,
      hasRefreshToken: Boolean(this.store.refreshToken),
      ...(this.store.clientId ? { clientId: this.store.clientId } : {}),
      flow: this.flow,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}

export async function listenForCallback(): Promise<{
  redirectUrl: string;
  wait: (timeoutMs: number) => Promise<{ code: string; iss?: string }>;
  close: () => Promise<void>;
}> {
  return await new Promise((resolve, reject) => {
    const server: Server = createServer();
    let deliver: ((v: { code: string; iss?: string }) => void) | null = null;
    let fail: ((e: Error) => void) | null = null;
    const result = new Promise<{ code: string; iss?: string }>((res, rej) => {
      deliver = res;
      fail = rej;
    });
    let sawFirst = false;
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        const desc = url.searchParams.get("error_description") ?? error;
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("authorization failed", desc));
        fail?.(new Error(`authorization was refused: ${desc}`));
        return;
      }
      if (!code) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not the oauth callback");
        return;
      }
      if (sawFirst) {
        res.writeHead(409, { "content-type": "text/plain" }).end("already received");
        return;
      }
      sawFirst = true;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("authorized", "you can close this tab"));
      const iss = url.searchParams.get("iss") ?? undefined;
      deliver?.({ code, ...(iss ? { iss } : {}) });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("could not determine the loopback port"));
        return;
      }
      resolve({
        redirectUrl: `http://127.0.0.1:${addr.port}/callback`,
        wait: (timeoutMs) =>
          new Promise((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error("the authorization page was not completed in time")),
              timeoutMs,
            );
            result.then(
              (v) => {
                clearTimeout(timer);
                res(v);
              },
              (e) => {
                clearTimeout(timer);
                rej(e);
              },
            );
          }),
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui;margin:12vh auto;max-width:34rem;text-align:center;color:#222}
h1{font-size:1.1rem}p{color:#555}</style>
<h1>${title}</h1><p>${body}</p>
<p>You can close this tab and return to teapot.</p>`;
}

type StoreFile = Record<string, StoredAuth>;

export class McpAuthStore {
  private file: string;
  private cache: StoreFile | null = null;

  constructor(dir: string) {
    this.file = path.join(dir, "mcp-oauth.json");
  }

  private async load(): Promise<StoreFile> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as StoreFile;
      const out: StoreFile = {};
      for (const [k, v] of Object.entries(raw ?? {}))
        if (v && typeof v === "object") out[k] = v as StoredAuth;
      this.cache = out;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async get(server: string): Promise<StoredAuth | undefined> {
    return (await this.load())[server];
  }

  async set(server: string, data: StoredAuth): Promise<void> {
    const all = await this.load();
    all[server] = data;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(all, null, 2), { mode: 0o600 });
    } catch {
    }
  }
}
