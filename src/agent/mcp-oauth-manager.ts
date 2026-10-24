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
  OAuthDiscoveryState,
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
  /**
   * The SDK's RFC 9728 / RFC 8414 discovery result, kept verbatim.
   *
   * `OAuthClientProvider.discoveryState()` is documented as something that "MUST persist with the
   * same durability as `codeVerifier` (survives the redirect round-trip)", and teapot did not
   * implement it at all. Without it, the post-callback exchange has to re-run discovery, and the
   * `issuer` it derives is then validated (RFC 9207) against the authorization response's `iss` —
   * a value recorded at REDIRECT time by the other transport instance. MEASURED against
   * `mcp.notion.com`: the browser completed, `codeVerifier` and a real-port `redirect_uris` were
   * both stored, and `tokens` was never written, because the code was never redeemed.
   *
   * Opaque to teapot on purpose: it is the SDK's own structure, and a field added by a future SDK
   * version must survive a save/load rather than be dropped.
   */
  discoveryState?: OAuthDiscoveryState;
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

  /**
   * Is the STORED registration unusable for this run?
   *
   * True when a redirect URI was recorded and it is not the one this flow listens on — the same
   * condition `clientInformation()` acts on, factored out so `tokens()` cannot disagree with it.
   */
  private registrationIsStale(): boolean {
    const stored = this.store.clientInformation as { redirect_uris?: unknown } | undefined;
    const uris = Array.isArray(stored?.redirect_uris) ? (stored.redirect_uris as string[]) : [];
    if (uris.length === 0) return false; // unknown is not wrong: older records omit the list
    /**
     * A PLACEHOLDER redirect says NOTHING either way — so it must not be treated as stale.
     *
     * `authFor()` builds every reconnect's provider with `http://127.0.0.1/callback`, no port,
     * because none exists until a flow opens a listener. An earlier version called that
     * unconditionally stale, which made `tokens()` DROP the grant on every reconnect: a server that
     * had been authorized minutes earlier reported "needs a grant" again (MEASURED: Notion and
     * Canva both lost their access token after a restart, with `teapot.theme`-style certainty that
     * the authorization itself had worked).
     *
     * A placeholder can neither confirm nor refute a registration, so the honest answer is "I do not
     * know" — and an unknown registration keeps its grant. A real mismatch (a listener-backed URL
     * the record does not list) is still reported, which is the case that actually produced
     * `Client ID mismatch`.
     */
    if (!/:\d+\//.test(this.redirectUrl)) return false;
    return !uris.includes(this.redirectUrl);
  }

  async saveClientInformation(info: StoredOAuthClientInformation, _ctx?: unknown): Promise<void> {
    const i = info as { client_id?: unknown; client_secret?: unknown };
    const previous = this.store.clientId;
    if (typeof i?.client_id === "string") this.store.clientId = i.client_id;
    if (typeof i?.client_secret === "string") this.store.clientSecret = i.client_secret;
    /**
     * A NEW client id INVALIDATES the grant issued to the old one.
     *
     * `clientInformation()` returns undefined when the stored registration cannot match this run's
     * redirect URI, which makes the SDK register afresh. Keeping the old tokens across that is fatal:
     * the refresh request authenticates as the NEW client while presenting a refresh token the
     * authorization server bound to the OLD one, and the server answers
     * `invalid_grant: Client ID mismatch` — MEASURED against both Notion and Canva, where every
     * reconnect failed for exactly this reason while the store still held a valid-looking token.
     *
     * Dropping them turns that into an honest "needs a grant": the panel shows 🔑 authorize, and
     * completing it issues a token pair for the client that actually exists.
     */
    if (previous && typeof i?.client_id === "string" && i.client_id !== previous) {
      this.store.accessToken = undefined;
      this.store.refreshToken = undefined;
      this.store.expiresAt = undefined;
    }
    // keep the whole payload: a future field (a client id issued with metadata) survives
    this.store.clientInformation = info as Record<string, unknown>;
    await this.persist(this.server, this.store);
  }

  tokens(_ctx?: unknown): StoredOAuthTokens | undefined {
    /**
     * A grant whose client can no longer be reused must not be presented.
     *
     * `clientInformation()` returns undefined when the stored registration cannot match this run's
     * redirect URI, which makes the SDK register afresh — but `tokens()` would still hand back the
     * token pair the OLD client obtained. The refresh then authenticates as the new client while
     * presenting the old client's refresh token, and the server answers
     * `invalid_grant: Client ID mismatch` (MEASURED against Notion and Canva: every reconnect failed
     * this way while the store held a token that looked valid).
     *
     * Returning nothing makes the flow an honest "needs a grant" instead: the panel offers 🔑, and
     * completing it issues a pair for the client that actually exists.
     */
    /**
     * A registration we cannot vouch for means DO NOT PRESENT the grant — never DELETE it.
     *
     * This used to clear the stored tokens here, and clearing is not the same as declining: the
     * store persists on the next write, so an "I cannot verify this" answer from a placeholder
     * provider ERASED a working grant minutes after it was obtained (MEASURED on this machine:
     * both Notion's and Canva's `accessToken`/`refreshToken` were gone from mcp-oauth.json while the
     * authorizations themselves had succeeded).
     *
     * Declining is reversible — the next connect that CAN verify the registration reads the tokens
     * again. Erasing is not: it costs the operator a full re-authorization for a transient
     * uncertainty.
     */
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

  /**
   * The SDK's discovery cache — the reason Notion's exchange never completed.
   *
   * The OAuth flow is split across TWO transport instances: the one that hits the 401 and
   * redirects the browser, and the one built after the callback arrives. The SDK's own contract
   * says this state "MUST persist with the same durability as `codeVerifier` (survives the
   * redirect round-trip)", because the issuer recorded at redirect time is what the authorization
   * response's `iss` is validated against (RFC 9207) when the code is redeemed.
   *
   * MEASURED on this machine's real store after a BROWSER-COMPLETED Notion authorization:
   * `codeVerifier` present, `clientInformation.redirect_uris` a real ephemeral port
   * (`http://127.0.0.1:37209/callback`), and no `accessToken` — the redeeming instance had
   * re-discovered a different issuer binding, so the exchange never produced tokens. Both earlier
   * fixes (persist the verifier, re-register on a redirect mismatch) were necessary and neither was
   * sufficient.
   */
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.store.discoveryState;
  }
  /**
   * The issuer this client believes it is talking to, from our OWN discovery record.
   *
   * Needed because the SDK treats a missing `iss` on the callback as an ATTACK when the server's
   * metadata declares `authorization_response_iss_parameter_supported` (RFC 9207), and throws
   * `IssuerMismatchError` before the code is ever redeemed.
   *
   * Notion declares that support and then does not send `iss`. MEASURED against
   * `mcp.notion.com/.well-known/oauth-authorization-server`:
   * `authorization_response_iss_parameter_supported: true`, while its real redirect carries only
   * `code` and `state`. Reproduced directly against the SDK with this machine's stored grant:
   * `IssuerMismatchError: expected "https://mcp.notion.com", received undefined` — i.e. every
   * browser-completed authorization was discarded at the last step, which is the "コールバック踏んだ
   * のに Unauthorized" report.
   *
   * Supplying the issuer ourselves is sound here: the code arrived on OUR loopback listener, and
   * this value comes from the discovery document we fetched before sending the browser out. RFC 9207
   * exists to stop a MIX-UP attack, and there is no mix-up to detect when the client already knows
   * which authorization server it directed the user to. The SDK's own check
   * (`iss !== expectedIssuer`) still runs, so a genuinely wrong issuer is still rejected.
   */
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
    // same durability as the verifier: the instance that redeems the code is not this one
    await this.persist(this.server, this.store);
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
