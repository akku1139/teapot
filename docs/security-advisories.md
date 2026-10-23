# The OpenCode advisories, and what they mean here

Three 2026 OpenCode advisories were checked against teapot. This file records what each one is,
whether teapot had the same problem, and what changed — so a future reader does not have to
re-derive it from a CVE database.

## CVE-2026-22812 / GHSA-vxw4-wv6m-9hhh — unauthenticated HTTP server

**OpenCode:** automatically started an unauthenticated HTTP server, allowing any local process —
or any website, via permissive CORS — to execute arbitrary shell commands with the user's
privileges. Fixed in 1.0.216.

**teapot: the same exposure, narrower.** `apiToken()` returns
`process.env.TEAPOT_API_TOKEN || config.password || ""`, and the auth middleware did
`if (!want) return next()` — so a fresh install with no token and no password served every
`/api/*` route to anyone who could reach the port. That is the advisory's core issue.

Two things limited it, and neither was a designed defence:

- the default bind is `127.0.0.1` (`TEAPOT_HOST ?? "127.0.0.1"`), so it was not reachable from the
  LAN unless the operator asked for it;
- teapot sets **no** CORS headers, so a browser could not READ a cross-origin response.

But a cross-origin **write** is still delivered, and that is enough to matter: a page the operator
visits could `POST /api/agents/:id/prompt`, which makes the agent call the model with tool access,
and the tool results are not readable by the page — yet the side effects are real. `PUT
/api/config` and `POST /api/update/restart` were equally reachable.

**Fixed** by refusing cross-origin writes (`Origin` present and not this host) *before* the token
check, so the order cannot be defeated by an unconfigured server. A local client sends no
`Origin`, so curl, the CLI and the desktop shell are unaffected. A token-less server now also
sends `x-teapot-auth: none` on every response, making the open state visible instead of silent.

**Residual risk, stated plainly:** this stops a web page, not a local process. A local process
running as the same user can already read the config and run commands directly, so a token would
not add security there — that is why the default stays open on loopback. Operators who expose the
port must set `TEAPOT_API_TOKEN` or `config.password`; the startup banner says so.

**Corrected:** this paragraph used to justify the open default by saying "the setup wizard sets the
password *through* the API, which cannot require one". The wizard was REMOVED, and with it went the
only path that accepted a password — `POST /api/setup` returns 409 once a config file exists — so
for a while there was no way to set one at all. The password is now settable in
settings → live update (`PUT /api/config`), read dynamically, so it takes effect on the next request
with no restart, and it is persisted through the `raw` mirror (#67). A boot with no password is a
loopback-only default rather than a wizard artefact.

## CVE-2026-22813 / GHSA-c83v-7274-4vgp — HTML injection in the markdown renderer

**OpenCode:** the markdown renderer inserted arbitrary HTML into the DOM with no sanitisation and
no CSP, so controlling an LLM response gave JavaScript execution on the local origin — and from
there the `/pty/` endpoints gave shell access. Fixed in 1.1.10.

**teapot: not vulnerable, by construction.** `frontend/md.js` escapes ALL HTML first and only then
applies its own block/inline rules to the escaped text, so raw markup cannot survive as markup. It
also refuses to build a link unless the target starts with `https:`, and adds
`rel="noopener noreferrer"`.

MEASURED against the renderer directly:

| input | output |
|---|---|
| `<img src=x onerror=alert(1)>` | escaped text |
| `<script>alert(1)</script>` | escaped text |
| `<a href="javascript:alert(1)">` | escaped text |
| `[click](javascript:alert(1))` | left as literal text, no anchor |
| `[a](data:text/html,…)` | left as literal text, no anchor |
| `[a](https://ok.example)` | anchor with `rel="noopener noreferrer"` |

The `innerHTML={renderMarkdown(…)}` call sites are safe **because** that escaping happens first;
a change that starts emitting raw tags would break the guarantee, so
`test/markdown-xss.test.ts` pins these cases.

## GHSA-632h-h47v-g4x4 — RCE in the upgrade endpoint

**OpenCode:** the unauthenticated `/global/upgrade` endpoint accepted an arbitrary npm tarball
spec, so a caller could install a package of their choosing and execute it.

**teapot: not applicable.** `POST /api/update/restart` takes no body at all and calls
`master.restartServer()`, which re-execs `process.execPath` — teapot's own binary. There is no
path from a request to a package spec, a shell command or a filesystem write.

The route IS behind the same auth middleware, so before the CVE-2026-22812 fix a website could
have triggered a restart. That is now a denial-of-service surface only, closed by the
cross-origin refusal.

## What to check when a new advisory lands

1. Does the affected route exist here, and does it take a **caller-controlled** argument that
   reaches a shell, a filesystem write, or a package install? (`grep -n "execFile\|spawn\|writeFile"
   src/server/api.ts`)
2. Is it reachable **without a token**, and from **another origin**? Both have to be true for the
   browser vector; only the first for a local-process vector.
3. Is the impact actually worse than what a local process could already do? Often it is not —
   which is worth stating rather than implying the product is unscathed.
