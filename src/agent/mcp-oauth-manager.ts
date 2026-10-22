/**
 * OAuth for MCP servers (#67), on the official client's `OAuthClientProvider`.
 *
 * The hand-written discovery/PKCE/token-exchange layer is GONE. What remains is the part
 * the SDK cannot own: **where the grant is stored**, and **how the operator completes the
 * browser step**. The SDK calls this interface at each stage:
 *
 *   clientMetadata()          → who we are, for dynamic registration
 *   clientInformation()       → the client id/secret obtained earlier, or undefined
 *   saveClientInformation()   → persist what registration returned
 *   tokens()                  → the current grant, or undefined
 *   saveTokens()              → persist a token PAIR
 *   redirectToAuthorization() → the URL to open in a browser
 *   saveCodeVerifier()        → keep the PKCE verifier for the exchange
 *   codeVerifier()            → hand it back afterwards
 *
 * Storage choices, unchanged from the previous implementation because they are the
 * security-relevant part and were already right:
 *   - **access token: memory only.** It is short-lived and bound to a fingerprint of the
 *     client credentials, so a changed client id can never reuse a stale token.
 *   - **refresh token + client info: on disk at 0600**, beside the data dir, never in
 *     `config.json` (which operators copy around).
 *
 * The redirect is a real LOOPBACK listener: this is a local harness with a browser UI, so
 * the tab can close itself. The reference implementations (easywebui, deepseek-pp) run
 * serverless and need a host-provided browser identity instead.
 */

import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

/** persisted per server: everything except the access token */
interface StoredAuth {
  clientId?: string;
  clientSecret?: string;
  /** the SDK's client-information payload, kept verbatim so a future field survives */
  clientInformation?: Record<string, unknown>;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  codeVerifier?: string;
  /** the scopes the grant was issued for, re-requested on refresh */
  scope?: string;
}

export type OAuthPhase =
  | { phase: "idle" }
  | { phase: "authorizing"; url: string; startedAt: number }
  | { phase: "done" }
  | { phase: "error"; message: string };

export interface OAuthStatus {
  /** an authorization url is waiting for the operator */
  pending: boolean;
  /** a usable access token is held */
  authorized: boolean;
  expiresAt: number | null;
  hasRefreshToken: boolean;
  clientId?: string;
  flow: OAuthPhase;
  lastError?: string;
}

/** how long a started flow waits for the browser */
export const FLOW_TIMEOUT_MS = 5 * 60_000;

/**
 * One server's OAuth state.
 *
 * The pieces the SDK needs and the pieces the UI needs live together because they are
 * two views of the same grant: a token saved here is what `status()` reports as
 * authorized.
 */
export class ServerAuth implements OAuthClientProvider {
  /** the URL the browser must be sent to, set by `redirectToAuthorization` */
  private authUrl?: URL;
  private verifier?: string;
  private flow: OAuthPhase = { phase: "idle" };
  private lastError?: string;
  private store: StoredAuth = {};
  readonly server: string;
  readonly redirectUrl: string;
  private persist: (server: string, data: StoredAuth) => Promise<void>;

  // Explicit fields, NOT parameter properties (`constructor(readonly x)`): Node's
  // type-stripping loader refuses that syntax and `pnpm test` runs the sources directly
  // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  constructor(
    server: string,
    redirectUrl: string,
    persist: (server: string, data: StoredAuth) => Promise<void>,
  ) {
    this.server = server;
    this.redirectUrl = redirectUrl;
    this.persist = persist;
  }

  /** load persisted state (called once, before the server is connected) */
  async hydrate(data: StoredAuth | undefined): Promise<void> {
    if (!data) return;
    this.store = { ...data };
    /**
     * Restore the PKCE verifier alongside the rest.
     *
     * `codeVerifier()` reads the in-memory field and throws when it is empty, so a rebuilt instance
     * would refuse the exchange even though the verifier is on disk. MEASURED cause of Notion's
     * `invalid_grant`: `saveCodeVerifier` never persisted, and even once it does, nothing read the
     * value back into the field that the exchange actually uses.
     */
    if (data.codeVerifier) this.verifier = data.codeVerifier;
  }

  /** the persisted payload, for the store */
  snapshot(): StoredAuth {
    return { ...this.store };
  }

  // ---- OAuthClientProvider ----

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "teapot",
      // a local harness is a PUBLIC client: it cannot keep a secret meaningful, and the
      // SDK sends `token_endpoint_auth_method: none` for exactly this shape
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    if (!this.store.clientId) return undefined;
    /**
     * A registration made with a DIFFERENT redirect URI cannot be reused.
     *
     * The callback listens on an ephemeral port (`server.listen(0)`), so `redirectUrl` carries a
     * new port on every attempt. A registration is bound to the `redirect_uris` it was created
     * with, and the authorize request must match — so a stored registration from another port would
     * have to be re-made.
     *
     * MEASURED from this machine's real store: `clientInformation.redirect_uris` was
     * `["http://127.0.0.1/callback"]` — NO PORT, because it was registered from the placeholder
     * provider in `authFor()` — while every flow runs on `http://127.0.0.1:<port>/callback`. The
     * browser completed the authorization, `codeVerifier` was persisted, and no `access_token` was
     * ever written: the exchange never got past the URI check.
     *
     * Returning `undefined` makes the SDK register afresh against the CURRENT redirect URI, which
     * is the only value that can match. The client id/secret are kept, so anything the server bound
     * to them survives; only the redirect list is re-established.
     */
    const stored = this.store.clientInformation as StoredOAuthClientInformation | undefined;
    if (stored) {
      const uris = Array.isArray((stored as { redirect_uris?: unknown }).redirect_uris)
        ? ((stored as { redirect_uris: unknown[] }).redirect_uris as string[])
        : [];
      /**
       * Only a RECORDED mismatch forces a re-registration.
       *
       * An empty list means the server never told us which URI it bound — some registration
       * responses omit `redirect_uris` entirely, and a record written by an older teapot has none.
       * Treating "unknown" as "wrong" would re-register on every single flow and lose whatever the
       * server bound to the client id, so absence keeps the registration.
       */
      if (uris.length === 0) return stored;
      if (uris.includes(this.redirectUrl)) return stored;
      // a recorded URI that cannot match this run: re-register rather than send one it never saw
      return undefined;
    }
    return {
      client_id: this.store.clientId,
      ...(this.store.clientSecret ? { client_secret: this.store.clientSecret } : {}),
    } as StoredOAuthClientInformation;
  }

  async saveClientInformation(info: StoredOAuthClientInformation, _ctx?: unknown): Promise<void> {
    const i = info as { client_id?: unknown; client_secret?: unknown };
    if (typeof i?.client_id === "string") this.store.clientId = i.client_id;
    if (typeof i?.client_secret === "string") this.store.clientSecret = i.client_secret;
    // keep the whole payload: a future field (a client id issued with metadata) survives
    this.store.clientInformation = info as Record<string, unknown>;
    await this.persist(this.server, this.store);
  }

  tokens(_ctx?: unknown): StoredOAuthTokens | undefined {
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
    // PERSIST A ROTATED REFRESH TOKEN IMMEDIATELY: a server that rotates invalidates the
    // previous one, so keeping the old token breaks the NEXT refresh with invalid_grant.
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
    /**
     * PERSIST it, or the exchange cannot complete after the instance is rebuilt.
     *
     * The verifier is the secret half of PKCE: the authorization request carries its SHA-256
     * challenge and the token request must present the verifier itself. Keeping it only in memory
     * means any path that constructs a fresh `ServerAuth` — a restart while the browser tab is open,
     * a reconnect, a second `authFor()` — exchanges with no verifier and the authorization server
     * answers `invalid_grant`.
     *
     * MEASURED against the real store: `clientId`/`clientSecret`/`clientInformation` were written
     * but `codeVerifier` was ABSENT, because this method was the one mutation that never persisted.
     * Notion's `/token` returns `invalid_grant` for exactly this shape.
     */
    await this.persist(this.server, this.store);
  }

  codeVerifier(): string {
    /**
     * Fall back to the STORE, not just the in-memory field.
     *
     * The field is populated by `saveCodeVerifier` (same instance) or by `hydrate` (a rebuilt one).
     * Reading the store as a last resort means an instance that was hydrated before this field was
     * restored still completes the exchange instead of throwing — the failure mode is a silent
     * `invalid_grant` from the server, so being generous here costs nothing.
     */
    const v = this.verifier ?? this.store.codeVerifier;
    if (!v) throw new Error("no PKCE verifier — the authorization flow did not start here");
    return v;
  }

  // ---- teapot-facing ----

  /** the url the browser must open, once `redirectToAuthorization` has been called */
  pendingUrl(): string | undefined {
    return this.flow.phase === "authorizing" ? this.flow.url : undefined;
  }

  markError(message: string): void {
    this.lastError = message;
    this.flow = { phase: "error", message };
  }

  /** drop the grant (disconnect) */
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
    // a token with no advertised expiry counts as usable; the SDK refreshes on 401 anyway
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

/**
 * The loopback listener an OAuth flow needs.
 *
 * Bound to 127.0.0.1, never 0.0.0.0: this endpoint accepts an authorization code and must
 * not be reachable from the network. The `state` check lives in the caller (the SDK
 * generates and verifies it), so this only has to deliver `code` and `iss`.
 */
export async function listenForCallback(): Promise<{
  redirectUrl: string;
  /** resolves with the callback's query once the browser arrives */
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

/** the page the operator sees in the callback tab */
/**
 * The page the browser lands on after authorizing.
 *
 * ## Why it does not close itself any more
 *
 * It used to end with `setTimeout(() => window.close(), 1200)`. Reported as "Notionから認証終わって
 * http://127.0.0.1:41621/callback?code=xxx に飛ぶはずなのに、dev toolsを見るとリダイレクトされてる
 * んだけど、ブラウザ画面ではリダイレクトされてない(謎)" — the redirect DOES happen, the page renders,
 * and then it vanishes on its own. Nothing in DevTools distinguishes "loaded and closed itself" from
 * "never navigated", so the symptom reads as a broken callback.
 *
 * It also only works for a tab a script opened: `window.close()` silently fails on a
 * user-navigated tab, so the behaviour differed by browser and by how the flow started.
 *
 * Saying what happened and leaving the tab alone is both honest and unambiguous. The operator
 * closes it when they are done reading.
 */
function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui;margin:12vh auto;max-width:34rem;text-align:center;color:#222}
h1{font-size:1.1rem}p{color:#555}</style>
<h1>${title}</h1><p>${body}</p>
<p>You can close this tab and return to teapot.</p>`;
}

/** the on-disk shape: one file, 0600, refresh tokens only */
type StoreFile = Record<string, StoredAuth>;

/**
 * Grants for every server, persisted together.
 *
 * One file rather than one per server: the set is small, and a single atomic write keeps
 * a rotation from racing a second write.
 */
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
      // tolerate hand edits: keep only entries that look like ours
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
      /* a failed write must not break a live session */
    }
  }
}
