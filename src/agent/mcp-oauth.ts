/**
 * MCP OAuth 2.1 (#67 follow-up): discovery, PKCE, token exchange, refresh.
 *
 * An OAuth-protected MCP server answers an unauthenticated request with **401 and a
 * `WWW-Authenticate: Bearer …` challenge**. That single response carries everything
 * needed to find the authorization server, so no configuration is required from the
 * operator: probe → discover → register → authorize → retry.
 *
 * The chain, and the spec each link comes from:
 *
 *   401 + WWW-Authenticate            RFC 6750  (the challenge, with `resource_metadata`)
 *   → protected-resource metadata      RFC 9728  (`authorization_servers`, `scopes_supported`)
 *   → authorization-server metadata    RFC 8414  (`/.well-known/oauth-authorization-server`)
 *   → optional dynamic registration    RFC 7591  (`registration_endpoint`)
 *   → authorization code + PKCE S256   RFC 7636  (MCP requires PKCE; it leaks nothing
 *                                                 because the verifier never leaves us)
 *   → token exchange / refresh
 *
 * What is modelled from the reference implementations (akku1139/deepseek-pp PR #1 and
 * easywebui), and why:
 *   - send a REAL `initialize` POST when probing, because servers police the request
 *     shape differently and a bare GET can 200 on a health page;
 *   - only trust a 401 that carries a Bearer challenge — a plain 401 with no
 *     `WWW-Authenticate` is a "wrong token", not "use OAuth here";
 *   - keep the access token in MEMORY only, bound to a fingerprint of the credentials,
 *     so a changed client id can never reuse a stale token;
 *   - persist the REFRESH token, and persist a ROTATED one immediately — a server that
 *     rotates invalidates the old token, and reusing it fails with `invalid_grant`;
 *   - re-request the originally granted scopes on refresh, or the token endpoint can
 *     return 200 with a token the resource server then refuses.
 *
 * What is DELIBERATELY different: the redirect. easywebui runs serverless and needs a
 * host-provided browser identity port; teapot is a local server with a browser UI, so
 * it runs a real loopback callback (`OAuthPending`). That removes the copy-paste step
 * entirely — the operator opens a URL and the tab closes itself.
 */

import { createHash, randomBytes } from "node:crypto";

/** one parsed `WWW-Authenticate: Bearer …` challenge */
export interface BearerChallenge {
  /** the `resource_metadata` parameter, resolved against the request url */
  resourceMetadataUrl?: string;
  /** the `realm`/`error`/`scope` parameters, kept for diagnostics */
  scope?: string;
  error?: string;
  raw: string;
}

/**
 * Parse the FIRST Bearer challenge out of a `WWW-Authenticate` header.
 *
 * The header can carry several challenges (`Digest …, Bearer …`), and commas appear
 * both between challenges and INSIDE the Bearer parameters, so this scans for
 * `Bearer` and then reads `key="value"` / `key=token` pairs without splitting on
 * commas — splitting first is the classic way to lose `resource_metadata` when its URL
 * contains one.
 */
export function parseBearerChallenge(header: string | null | undefined): BearerChallenge | null {
  if (!header) return null;
  const at = header.search(/\bBearer\b/i);
  if (at === -1) return null;
  const rest = header.slice(at + "Bearer".length);
  const out: BearerChallenge = { raw: header };
  // stop at the next scheme if another challenge follows
  const nextScheme = rest.search(/,\s*[A-Za-z][A-Za-z0-9_-]*\s+[^=,\s]/);
  const body = nextScheme === -1 ? rest : rest.slice(0, nextScheme);
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const key = m[1]!.toLowerCase();
    const value = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
    if (key === "resource_metadata") out.resourceMetadataUrl = value;
    else if (key === "scope") out.scope = value;
    else if (key === "error") out.error = value;
  }
  return out;
}

/** PKCE verifier + S256 challenge (RFC 7636) */
export function pkcePair(): { verifier: string; challenge: string } {
  // 32 random bytes → 43 base64url chars, inside the spec's 43..128 range
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** the metadata document an MCP server points at, plus where it came from */
export interface ResolvedAuthServer {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes: string[];
  /** the `resource` value to send (RFC 8707) — the MCP endpoint itself */
  resource?: string;
  issuer?: string;
}

const PROBE_TIMEOUT_MS = 15_000;

async function fetchJson(url: string, signal?: AbortSignal): Promise<Record<string, any>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: ac.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text) as Record<string, any>;
    } catch {
      // keep the body visible: an HTML login page with a JSON content type is a
      // completely different problem from a malformed metadata document
      throw new Error(`${url} did not return JSON: ${text.slice(0, 160)}`);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : undefined;

/**
 * Probe an MCP endpoint and, when it demands OAuth, resolve its authorization server.
 *
 * Returns `requiresOAuth: false` with no error for a healthy endpoint (nothing to do)
 * and for one whose 401 carries no Bearer challenge (a bad token, not a missing grant).
 */
export async function detectOAuth(
  endpoint: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; resource?: string } = {},
): Promise<{
  requiresOAuth: boolean;
  challenge?: BearerChallenge;
  authServer?: ResolvedAuthServer;
  /** why detection stopped early, when it did */
  reason?: string;
}> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { requiresOAuth: false, reason: `invalid url: ${endpoint}` };
  }
  if (!["http:", "https:"].includes(url.protocol))
    return { requiresOAuth: false, reason: `not an http(s) url: ${endpoint}` };

  // A REAL initialize request: servers police the shape differently, and a bare GET
  // often 200s on a landing page, which would read as "no auth needed".
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teapot", version: "1" } },
      }),
      // manual so an HTML login page is visible rather than silently followed
      redirect: "manual",
      signal: ac.signal,
    });
  } catch (err) {
    return {
      requiresOAuth: false,
      reason: (err as Error).name === "AbortError" ? "probe timed out" : (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
  // drain so the socket is released
  await res.body?.cancel().catch(() => {});

  if (res.status !== 401) return { requiresOAuth: false };
  const challenge = parseBearerChallenge(res.headers.get("www-authenticate"));
  if (!challenge)
    return {
      requiresOAuth: false,
      reason:
        "the server answered 401 without a Bearer challenge — this is a rejected credential, " +
        "not a missing OAuth grant",
    };

  const resource = opts.resource ?? url.toString();
  if (!challenge.resourceMetadataUrl)
    return {
      requiresOAuth: true,
      challenge,
      reason: "the 401 challenge names no resource_metadata document",
    };

  let metadataUrl: string;
  try {
    // the parameter is usually absolute, but is allowed to be relative
    metadataUrl = new URL(challenge.resourceMetadataUrl, url).toString();
  } catch {
    return { requiresOAuth: true, challenge, reason: "the resource_metadata url is malformed" };
  }

  try {
    const protectedResource = await fetchJson(metadataUrl, opts.signal);
    const servers = strList(protectedResource.authorization_servers);
    const issuer = servers?.[0];
    if (!issuer)
      return {
        requiresOAuth: true,
        challenge,
        reason: "the protected-resource metadata names no authorization server",
      };
    // Authorization-server metadata: try EVERY shape the specs define, in order.
    //
    // MEASURED against real servers, which is the only way to get this right:
    //
    //   GitHub (issuer https://github.com/login/oauth) serves
    //     https://github.com/.well-known/oauth-authorization-server/login/oauth   200
    //     https://github.com/login/oauth/.well-known/oauth-authorization-server   404
    //   Notion (issuer https://mcp.notion.com, no path) serves the root form.
    //
    // So RFC 8414 §3.1 is "insert the well-known segment BEFORE the issuer's path"
    // (`/.well-known/oauth-authorization-server` + path), and the ".../path/.well-known/…"
    // shape is the **OIDC Discovery 1.0** form, which GitHub uses for
    // `.well-known/openid-configuration`. An earlier version of this code tried only the
    // post-path form and hardcoded the conclusion that the pre-path form was wrong —
    // GitHub returned 404 and the whole discovery failed.
    //
    // Both are legitimate and different providers publish different ones, so the fix is
    // to TRY ALL of them rather than to pick a favourite.
    //
    // Built by string concatenation, NOT `new URL("/.well-known/…", issuer)`: a leading
    // slash replaces the path, which silently drops the issuer's segment.
    const issuerUrl = new URL(issuer);
    const basePath = issuerUrl.pathname.replace(/\/$/, "");
    const candidates = [
      // RFC 8414 §3.1 — well-known BEFORE the path (GitHub's shape)
      `${issuerUrl.origin}/.well-known/oauth-authorization-server${basePath}`,
      // OIDC Discovery 1.0 §4 — well-known AFTER the path
      `${issuerUrl.origin}${basePath}/.well-known/openid-configuration`,
      // the same two for the OAuth metadata name, for providers that publish both
      `${issuerUrl.origin}${basePath}/.well-known/oauth-authorization-server`,
      // no path at all: the common case for a bare issuer
      `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
    ];
    let meta: Record<string, any> | null = null;
    let lastErr = "";
    for (const candidate of [...new Set(candidates)]) {
      try {
        const m = await fetchJson(candidate, opts.signal);
        // accept only a document that actually describes an authorization server
        if (str(m.authorization_endpoint) && str(m.token_endpoint)) {
          meta = m;
          break;
        }
        lastErr = `${candidate} has no authorization_endpoint/token_endpoint`;
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }
    if (!meta) {
      return {
        requiresOAuth: true,
        challenge,
        reason: `could not resolve authorization-server metadata for ${issuer}: ${lastErr}`,
      };
    }
    // `meta` is guaranteed to carry both endpoints by the loop above.
    const authorizationEndpoint = meta.authorization_endpoint as string;
    const tokenEndpoint = meta.token_endpoint as string;
    return {
      requiresOAuth: true,
      challenge,
      authServer: {
        authorizationEndpoint,
        tokenEndpoint,
        ...(str(meta.registration_endpoint)
          ? { registrationEndpoint: meta.registration_endpoint as string }
          : {}),
        // the RESOURCE's scopes win: they describe what this MCP server accepts
        scopes:
          strList(protectedResource.scopes_supported) ?? strList(meta.scopes_supported) ?? [],
        resource,
        ...(str(meta.issuer) ? { issuer: meta.issuer as string } : {}),
      },
    };
  } catch (err) {
    return { requiresOAuth: true, challenge, reason: (err as Error).message };
  }
}

/** POST an `application/x-www-form-urlencoded` body; returns the JSON response */
async function postForm(
  url: string,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(body).toString(),
      signal: ac.signal,
    });
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, any>) : {};
    } catch {
      /* an HTML error page — reported with the status below */
    }
    if (!res.ok) {
      const detail = str(json.error_description) ?? str(json.error) ?? text.slice(0, 200);
      throw new Error(`${url} returned HTTP ${res.status}: ${detail || "(no body)"}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export interface OAuthTokens {
  accessToken: string;
  tokenType: string;
  /** epoch ms, or null when the provider advertised no expiry */
  expiresAt: number | null;
  refreshToken?: string;
  scope?: string;
}

const toExpiry = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Date.now() + n * 1000 : null;
};

const tokensFrom = (payload: Record<string, any>, keepRefresh?: string): OAuthTokens => {
  const accessToken = str(payload.access_token);
  if (!accessToken) throw new Error("the token endpoint returned no access_token");
  const out: OAuthTokens = {
    accessToken,
    tokenType: str(payload.token_type) ?? "Bearer",
    expiresAt: toExpiry(payload.expires_in),
  };
  const rt = str(payload.refresh_token) ?? keepRefresh;
  if (rt) out.refreshToken = rt;
  if (str(payload.scope)) out.scope = payload.scope as string;
  return out;
};

/**
 * Dynamic client registration (RFC 7591).
 *
 * Required by the MCP spec for servers that hand out no static client id. Sent as a
 * public client (`token_endpoint_auth_method: "none"`) because a local harness cannot
 * keep a client secret meaningful — the code runs on the operator's own machine.
 */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<{ clientId: string; clientSecret?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "teapot",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`dynamic client registration failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
    const json = JSON.parse(text) as Record<string, any>;
    const clientId = str(json.client_id);
    if (!clientId) throw new Error("dynamic client registration returned no client_id");
    return { clientId, ...(str(json.client_secret) ? { clientSecret: json.client_secret as string } : {}) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** build the URL the operator is sent to */
export function buildAuthorizeUrl(input: {
  authServer: ResolvedAuthServer;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes?: string[];
}): string {
  const url = new URL(input.authServer.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.codeChallenge);
  // S256 only: MCP requires PKCE and forbids `plain`
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  const scopes = input.scopes?.length ? input.scopes : input.authServer.scopes;
  if (scopes.length) url.searchParams.set("scope", scopes.join(" "));
  // RFC 8707: bind the grant to THIS resource, so a token minted for another server
  // cannot be replayed here
  if (input.authServer.resource) url.searchParams.set("resource", input.authServer.resource);
  return url.toString();
}

/** exchange an authorization code for tokens */
export async function exchangeCode(input: {
  authServer: ResolvedAuthServer;
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  signal?: AbortSignal;
}): Promise<OAuthTokens> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
  };
  if (input.clientSecret) body.client_secret = input.clientSecret;
  if (input.authServer.resource) body.resource = input.authServer.resource;
  const payload = await postForm(input.authServer.tokenEndpoint, body, input.signal);
  return tokensFrom(payload);
}

/**
 * Refresh an access token.
 *
 * The previously granted SCOPES are re-requested: a refresh that silently drops them
 * can return 200 with a token the resource server then refuses, which looks like an
 * authentication failure at the wrong end of the chain. A ROTATED refresh token is
 * returned in the result so the caller can persist it immediately — a server that
 * rotates invalidates the old one, so a discarded rotation breaks the next refresh.
 */
export async function refreshTokens(input: {
  authServer: ResolvedAuthServer;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  scopes?: string[];
  signal?: AbortSignal;
}): Promise<OAuthTokens> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  };
  if (input.clientSecret) body.client_secret = input.clientSecret;
  const scopes = input.scopes?.length ? input.scopes : input.authServer.scopes;
  if (scopes.length) body.scope = scopes.join(" ");
  if (input.authServer.resource) body.resource = input.authServer.resource;
  const payload = await postForm(input.authServer.tokenEndpoint, body, input.signal);
  // keepRefresh: a server that does not rotate omits refresh_token, and dropping it
  // would end the grant after one refresh
  return tokensFrom(payload, input.refreshToken);
}
