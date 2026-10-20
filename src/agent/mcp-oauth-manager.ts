/**
 * The OAuth flow for MCP servers (#67): start it, wait for the browser, keep the grant.
 *
 * Teapot is a LOCAL server with a browser UI, so the redirect can be a real loopback
 * callback: a tiny HTTP listener on 127.0.0.1 receives `?code=…&state=…`, the page
 * closes itself, and the tools appear without the operator copying anything. The
 * reference implementations (easywebui, deepseek-pp) run serverless and therefore need
 * a host-provided browser identity; this is the simpler shape that a real local port
 * allows.
 *
 * What lives where:
 *   - **access token**: MEMORY ONLY, bound to a fingerprint of the credentials. A
 *     changed client id can therefore never reuse a stale token, and it never reaches
 *     `config.json`.
 *   - **refresh token**: PERSISTED, because it is the durable grant. A rotated one is
 *     written back immediately — a server that rotates invalidates the previous token,
 *     and reusing it fails with `invalid_grant` on the next refresh.
 *
 * The state parameter is a random value, checked on the callback: without it any page
 * could deliver a code to the loopback listener.
 */

import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildAuthorizeUrl,
  detectOAuth,
  exchangeCode,
  parseBearerChallenge,
  pkcePair,
  refreshTokens,
  registerClient,
  type OAuthTokens,
  type ResolvedAuthServer,
} from "./mcp-oauth.ts";

/** what we persist per server. The access token is deliberately absent. */
export interface OAuthGrant {
  /** which token endpoint minted this — a changed server means start over */
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  refreshToken?: string;
  scopes: string[];
  resource?: string;
  /** when the grant was first obtained, ms epoch */
  obtainedAt: number;
}

interface CachedToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number | null;
  /** binds the cache entry to the credentials that produced it */
  fingerprint: string;
}

export type OAuthFlowPhase =
  | { phase: "idle" }
  | { phase: "authorizing"; url: string; startedAt: number }
  | { phase: "done"; ok: true }
  | { phase: "error"; message: string };

export interface OAuthFlowStatus {
  /** the server demands OAuth (detected, or configured by hand) */
  required: boolean;
  /** a usable access token exists right now */
  authorized: boolean;
  expiresAt: number | null;
  hasRefreshToken: boolean;
  scopes: string[];
  /** the resolved authorization server, once known */
  authServer?: ResolvedAuthServer;
  flow: OAuthFlowPhase;
  lastError?: string;
}

/** how long a started flow waits for the browser before giving up */
const FLOW_TIMEOUT_MS = 5 * 60_000;
/** refresh this long before expiry, so a token cannot expire mid-call */
const REFRESH_SKEW_MS = 60_000;

const fingerprintOf = (grant: Pick<OAuthGrant, "clientId" | "clientSecret" | "tokenEndpoint">): string =>
  createHash("sha256")
    .update(`${grant.tokenEndpoint}\u0000${grant.clientId}\u0000${grant.clientSecret ?? ""}`)
    .digest("hex")
    .slice(0, 32);

/**
 * Listen on a free loopback port and resolve with the redirect URI plus the one-shot
 * handler that finishes the flow.
 *
 * Binding 127.0.0.1 (not 0.0.0.0) matters: this listener accepts an authorization code
 * and must not be reachable from the network.
 */
async function listenLoopback(): Promise<{
  redirectUri: string;
  wait: (timeoutMs: number) => Promise<{ code: string; state: string }>;
  close: () => Promise<void>;
}> {
  return await new Promise((resolve, reject) => {
    const server: Server = createServer();
    let deliver: ((v: { code: string; state: string }) => void) | null = null;
    let fail: ((e: Error) => void) | null = null;
    const result = new Promise<{ code: string; state: string }>((res, rej) => {
      deliver = res;
      fail = rej;
    });
    let sawFirst = false;
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      if (error) {
        const desc = url.searchParams.get("error_description") ?? error;
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("authorization failed", desc));
        fail?.(new Error(`authorization was refused: ${desc}`));
        return;
      }
      if (!code) {
        // a favicon or a stray probe: keep listening rather than failing the flow
        res.writeHead(404, { "content-type": "text/plain" }).end("not the oauth callback");
        return;
      }
      if (sawFirst) {
        res.writeHead(409, { "content-type": "text/plain" }).end("already received");
        return;
      }
      sawFirst = true;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("authorized", "you can close this tab"));
      deliver?.({ code, state: state ?? "" });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("could not determine the loopback port"));
        return;
      }
      resolve({
        redirectUri: `http://127.0.0.1:${addr.port}/callback`,
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

/** the page the operator sees in the callback tab */
function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui;margin:12vh auto;max-width:34rem;text-align:center;color:#222}
h1{font-size:1.1rem}</style>
<h1>${title}</h1><p>${body}</p>
<script>setTimeout(()=>window.close(),1200)</script>`;
}

export class McpOAuthManager {
  private grants = new Map<string, OAuthGrant>();
  private tokens = new Map<string, CachedToken>();
  private flows = new Map<string, OAuthFlowPhase>();
  private discovered = new Map<string, ResolvedAuthServer>();
  /** servers known to demand OAuth, so the UI can offer "authorize" */
  private required = new Set<string>();
  private storePath: string;

  constructor(storeDir: string) {
    this.storePath = path.join(storeDir, "mcp-oauth.json");
  }

  /** read persisted grants; a missing or corrupt file is simply no grants */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.storePath, "utf8")) as Record<string, OAuthGrant>;
      for (const [server, g] of Object.entries(raw)) {
        if (g && typeof g.clientId === "string" && typeof g.tokenEndpoint === "string") this.grants.set(server, g);
      }
    } catch {
      /* first run, or an unreadable store — both mean "no grants" */
    }
  }

  private async save(): Promise<void> {
    const out: Record<string, OAuthGrant> = {};
    for (const [k, v] of this.grants) out[k] = v;
    try {
      await mkdir(path.dirname(this.storePath), { recursive: true });
      // 0600: a refresh token is a credential
      await writeFile(this.storePath, JSON.stringify(out, null, 2), { mode: 0o600 });
    } catch {
      /* a failed write must not break a live session */
    }
  }

  /** forget a grant entirely (disconnect) */
  async disconnect(server: string): Promise<void> {
    this.grants.delete(server);
    this.tokens.delete(server);
    this.flows.delete(server);
    await this.save();
  }

  status(server: string): OAuthFlowStatus {
    const grant = this.grants.get(server);
    const tok = this.tokens.get(server);
    const fresh = Boolean(tok && (tok.expiresAt === null || Date.now() < tok.expiresAt - REFRESH_SKEW_MS));
    return {
      required: this.required.has(server) || Boolean(grant),
      authorized: fresh,
      expiresAt: tok?.expiresAt ?? null,
      hasRefreshToken: Boolean(grant?.refreshToken),
      scopes: grant?.scopes ?? [],
      ...(this.discovered.has(server) ? { authServer: this.discovered.get(server) } : {}),
      flow: this.flows.get(server) ?? { phase: "idle" },
    };
  }

  /** mark a server as needing OAuth after a 401 challenge */
  noteRequired(server: string): void {
    this.required.add(server);
  }

  /**
   * Probe an endpoint and remember whether it demands OAuth.
   *
   * Called when a connection fails with 401, and from the settings panel's `test`, so
   * the operator never has to know the difference between "wrong header" and "this
   * needs a real grant" — the 401 challenge tells us.
   */
  async detect(
    server: string,
    endpoint: string,
    opts: { headers?: Record<string, string>; resource?: string } = {},
  ): Promise<{ requiresOAuth: boolean; reason?: string; authServer?: ResolvedAuthServer; challenge?: string }> {
    const d = await detectOAuth(endpoint, {
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.resource ? { resource: opts.resource } : {}),
    });
    if (d.requiresOAuth) this.required.add(server);
    if (d.authServer) this.discovered.set(server, d.authServer);
    return {
      requiresOAuth: d.requiresOAuth,
      ...(d.reason ? { reason: d.reason } : {}),
      ...(d.authServer ? { authServer: d.authServer } : {}),
      ...(d.challenge ? { challenge: d.challenge.raw } : {}),
    };
  }

  /**
   * Run the whole flow: discover (if needed), register, authorize, exchange, store.
   *
   * Resolves once the redirect has been received — the caller starts the flow, hands
   * the URL to the UI, and this promise settles when the browser comes back.
   */
  async authorize(
    server: string,
    endpoint: string,
    opts: { scopes?: string[]; clientId?: string; clientSecret?: string; resource?: string } = {},
  ): Promise<{ ok: true }> {
    this.flows.set(server, { phase: "idle" });
    let loop: Awaited<ReturnType<typeof listenLoopback>> | null = null;
    try {
      // an auth server is required; discover it when the operator has not saved one
      let authServer = this.discovered.get(server);
      if (!authServer) {
        const d = await this.detect(server, endpoint, {
          ...(opts.resource ? { resource: opts.resource } : {}),
        });
        if (!d.requiresOAuth) throw new Error("this server did not request OAuth (no 401 Bearer challenge)");
        authServer = d.authServer;
        if (!authServer)
          throw new Error(
            d.reason ??
              "this server requires OAuth but did not publish authorization-server metadata; " +
                "save its authorization/token endpoints by hand",
          );
      }

      loop = await listenLoopback();
      const redirectUri = loop.redirectUri;

      // client id: given, persisted, or dynamically registered (RFC 7591)
      const prev = this.grants.get(server);
      let clientId = opts.clientId ?? prev?.clientId;
      let clientSecret = opts.clientSecret ?? prev?.clientSecret;
      if (!clientId) {
        if (!authServer.registrationEndpoint)
          throw new Error(
            "this server does not support dynamic client registration, so a client id must be entered by hand",
          );
        const reg = await registerClient(authServer.registrationEndpoint, redirectUri);
        clientId = reg.clientId;
        clientSecret = reg.clientSecret;
      }

      const { verifier, challenge } = pkcePair();
      const state = randomBytes(16).toString("base64url");
      const scopes = opts.scopes?.length ? opts.scopes : (prev?.scopes ?? authServer.scopes);
      const url = buildAuthorizeUrl({
        authServer,
        clientId,
        redirectUri,
        codeChallenge: challenge,
        state,
        scopes,
      });
      this.flows.set(server, { phase: "authorizing", url, startedAt: Date.now() });

      // wait for the browser WHILE the caller shows the url
      const { code, state: got } = await loop.wait(FLOW_TIMEOUT_MS);
      if (got !== state)
        throw new Error("the authorization callback carried the wrong state — refusing the code");

      const tokens = await exchangeCode({
        authServer,
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
        code,
        codeVerifier: verifier,
        redirectUri,
      });
      const grant: OAuthGrant = {
        tokenEndpoint: authServer.tokenEndpoint,
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        scopes: tokens.scope ? tokens.scope.split(" ") : scopes,
        ...(authServer.resource ? { resource: authServer.resource } : {}),
        obtainedAt: Date.now(),
      };
      this.grants.set(server, grant);
      this.tokens.set(server, {
        accessToken: tokens.accessToken,
        tokenType: tokens.tokenType,
        expiresAt: tokens.expiresAt,
        fingerprint: fingerprintOf(grant),
      });
      this.flows.set(server, { phase: "done", ok: true });
      await this.save();
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      this.flows.set(server, { phase: "error", message });
      throw err;
    } finally {
      await loop?.close();
    }
  }

  /**
   * The `Authorization` value for this server, refreshing when needed.
   *
   * Returns null when the server has no grant (nothing to add). Throws when a refresh
   * is needed but fails, so the caller can surface "re-authorize" instead of sending an
   * unauthenticated request that will 401 anyway.
   */
  async authorization(server: string): Promise<string | null> {
    const grant = this.grants.get(server);
    if (!grant) return null;
    const fp = fingerprintOf(grant);
    const cached = this.tokens.get(server);
    if (cached && cached.fingerprint === fp) {
      if (cached.expiresAt === null || Date.now() < cached.expiresAt - REFRESH_SKEW_MS)
        return `${cached.tokenType || "Bearer"} ${cached.accessToken}`;
    }
    if (!grant.refreshToken)
      throw new Error("the MCP grant has expired and carries no refresh token — re-authorize");
    const authServer = this.discovered.get(server);
    if (!authServer)
      throw new Error("the MCP authorization server is not resolved — re-authorize");
    const tokens: OAuthTokens = await refreshTokens({
      authServer,
      clientId: grant.clientId,
      ...(grant.clientSecret ? { clientSecret: grant.clientSecret } : {}),
      refreshToken: grant.refreshToken,
      scopes: grant.scopes,
    });
    // PERSIST A ROTATED TOKEN IMMEDIATELY: a server that rotates invalidates the old
    // one, so a discarded rotation breaks the NEXT refresh with `invalid_grant`.
    if (tokens.refreshToken && tokens.refreshToken !== grant.refreshToken) {
      grant.refreshToken = tokens.refreshToken;
      await this.save();
    }
    this.tokens.set(server, {
      accessToken: tokens.accessToken,
      tokenType: tokens.tokenType,
      expiresAt: tokens.expiresAt,
      fingerprint: fp,
    });
    return `${tokens.tokenType || "Bearer"} ${tokens.accessToken}`;
  }

  /** drop the cached ACCESS token so the next call refreshes (after a 401) */
  invalidate(server: string): void {
    this.tokens.delete(server);
  }
}

/**
 * Process-wide manager.
 *
 * Starts EMPTY and inert: until `initMcpOAuth()` points it at the data dir it has no
 * grants, which is the safe default (no token is ever read from an assumed location).
 */
export let oauth = new McpOAuthManager(path.join(process.cwd(), ".teapot-oauth"));

export async function initMcpOAuth(dir: string): Promise<void> {
  oauth = new McpOAuthManager(dir);
  await oauth.load();
}

export { parseBearerChallenge };
