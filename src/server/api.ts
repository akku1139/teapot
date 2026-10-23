/**
 * REST + SSE API on Hono, plus static file serving for the web UI.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { currentSkills } from "../agent/tools.ts";
import { readSkillFile } from "../agent/skills.ts";
import { detectImageTools, downscaleImage, scaledName, widthName, MAX_EDGE } from "./image-resize.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSchedule } from "../scheduler/cron.ts";
import {
  attachTerminal,
  closeTerminal,
  closeTerminalsFor,
  createTerminal,
  detachTerminal,
  forgetTerminalSize,
  listTerminals,
  reapIdleTerminals,
  resizeTerminal,
  setTerminalResize,
  writeTerminal,
} from "./terminals.ts";
import { applyPtySize, TermSizeTracker, resolvePtySlave } from "./term-size.ts";
import { expandTilde, homeDir } from "../home.ts";
import { SUB_PERSONAS, resolveWorkspace } from "../master.ts";
import { ConfigPatchSchema, formatZodError } from "../config-schema.ts";
import type { ProviderConfig } from "../master.ts";
import { providerHeaders } from "../agent/llm.ts";
import { safeJoin } from "../agent/tools.ts";

interface ModelEntry {
id: string;
  contextLength?: number;
  pricing?: { prompt: number; completion: number };
  modalities?: { input: string[]; output: string[] };
}

/** GET <baseUrl>/models on any OpenAI-compatible endpoint (id + ctx window + pricing). */
async function listModels(
  baseUrl: string,
  apiKey?: string,
): Promise<ModelEntry[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...providerHeaders(baseUrl), // OpenRouter app attribution
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  // OpenRouter-style entries carry context_length + per-token pricing —
  // surface them so the UI can show what each model offers
    const j = (await res.json()) as {
      data?: {
        id?: string;
        context_length?: number;
        pricing?: { prompt?: string | number; completion?: string | number };
        architecture?: {
          modality?: string;
          input_modalities?: string[];
          output_modalities?: string[];
        };
      }[];
    };
    return (j.data ?? [])
    .map((m) => ({
      id: typeof m.id === "string" ? m.id : "",
      contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
      pricing:
        m.pricing && (m.pricing.prompt !== undefined || m.pricing.completion !== undefined)
          ? {
              prompt: Number(m.pricing.prompt ?? 0),
              completion: Number(m.pricing.completion ?? 0),
            }
          : undefined,
      modalities:
        Array.isArray(m.architecture?.input_modalities) && m.architecture!.input_modalities!.length
          ? {
              input: m.architecture!.input_modalities!,
              output: m.architecture!.output_modalities ?? ["text"],
            }
          : undefined,
    }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}
import path from "node:path";
import { bus } from "../bus.ts";
import { readEvents, readEventsTail, filterByBranch } from "../log/events.ts";
import type { Master } from "../master.ts";
import { mcp } from "../agent/mcp-registry.ts";
import { connectMcp, type McpServerConfig } from "../agent/mcp.ts";

/** media categories the file tree can preview inline */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]);

function mediaKind(p: string): "image" | "video" | "audio" | null {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
}

/** extension → MIME (used for the media preview endpoint) */
export const MEDIA_MIME: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const e of IMAGE_EXT) m[e] = `image/${e === "jpg" ? "jpeg" : e}`;
  Object.assign(m, { svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif" });
  for (const e of VIDEO_EXT) m[e] = `video/${e === "mov" ? "quicktime" : e === "mkv" ? "x-matroska" : e}`;
  for (const e of AUDIO_EXT) m[e] = `audio/${e}`;
  Object.assign(m, { m4a: "audio/mp4", mp3: "audio/mpeg" });
  return m;
})();

/** category → generic fallback when no specific extension match exists */
const KIND_MIME: Record<"image" | "video" | "audio", string> = {
  image: "application/octet-stream",
  video: "application/octet-stream",
  audio: "application/octet-stream",
};

function mimeFor(rel: string, kind: "image" | "video" | "audio"): string {
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_MIME[ext] ?? KIND_MIME[kind];
}

export function buildApp(master: Master): Hono {
  const app = new Hono();

/**
 * Cap on concurrent `/api/ws` event-stream clients.
 *
 * Each one holds a listener on the global bus and receives every agent's
 * events, so this bounds real fan-out. 64 is far above any plausible number of
 * open tabs on a LAN and low enough that a runaway client cannot exhaust memory.
 */
const MAX_WS_CLIENTS = 64;

  // Optional bearer auth for LAN exposure — TEAPOT_API_TOKEN env wins, else
  // the config's `password` field. Static files stay public; only /api/* is
  // gated.
  // Optional bearer auth for LAN exposure — TEAPOT_API_TOKEN env wins, else
  // the config's `password` field. Static files stay public; only /api/* is
  // gated.
  //
  // Read DYNAMICALLY: `config.password` changes while this app is running — the
  // settings panel writes it through `PUT /api/config`. A const captured here once
  // meant a password set after boot did not take effect until a process restart,
  // leaving the server open while the operator believed it was closed.
  const apiToken = () => process.env.TEAPOT_API_TOKEN || master.config.password || "";

  /**
   * Routes where `?token=` is accepted.
   *
   * A browser WebSocket handshake cannot send an Authorization header, so the
   * query parameter is the ONLY way for the UI to authenticate those two
   * sockets. It used to be accepted on EVERY `/api/*` route, which put the
   * secret into proxy access logs, `Referer` headers and browser history for
   * requests that never needed it — `DELETE /api/agents/:id`, `PUT
   * /api/config`, `POST /api/update/restart`.
   *
   * So this narrows where the secret can LEAK rather than changing who is
   * authenticated: every route still accepts the header, and only these two
   * also accept the query form.
   */
  const tokenInQueryOk = (path: string): boolean =>
    path === "/api/ws" || /^\/api\/agents\/[^/]+\/term$/.test(path);

  /**
   * Requests that a PAGE ON ANOTHER ORIGIN must not be able to make.
   *
   * This is the defence that does not depend on the operator configuring a token, and it closes
   * the browser half of the OpenCode advisory (CVE-2026-22812 / GHSA-vxw4-wv6m-9hhh): their server
   * was unauthenticated AND sent permissive CORS, so any website could drive it. teapot sends no
   * CORS headers — a cross-origin READ is already blocked by the browser — but a cross-origin
   * WRITE is still DELIVERED, and these routes have side effects a website must not trigger:
   *
   *     POST /api/agents/:id/prompt      → the agent runs the model with tool access
   *     POST /api/agents/:id/restart     → restart onto a different build
   *     PUT  /api/config                 → rewrite the config, including API keys
   *     POST /api/update/restart         → restart the process
   *     POST /api/setup                  → set the password on a first-run server
   *
   * The check is deliberately structural rather than a header-name list: a browser always sends
   * `Origin` on a cross-origin request (and on every `fetch` it sends `Sec-Fetch-Site`), while a
   * local process — which the OS already isolates from other users — sends neither. So "an Origin
   * that is not this server" is rejected, and a request with no Origin at all (curl, the CLI, the
   * desktop shell) is unaffected.
   *
   * on the same machine, and it is not meant to — that is what the token and the loopback bind are
   * for. See `docs/security-advisories.md`.
   */
  const sameOrigin = (c: Context): boolean => {
    const origin = c.req.header("origin");
    // no Origin at all: a non-browser client. A browser ALWAYS sets it cross-origin.
    if (origin === undefined) return true;
    /**
     * `Sec-Fetch-Site` FIRST — the browser computes it and NOTHING in the request path can rewrite
     * it, unlike `Host`.
     *
     * (`http-proxy`, `changeOrigin: true`) from :7788 to :7789, so the browser's `Origin` says
     * `:7788` while the `Host` reaching teapot says `:7789` — and comparing those two refused every
     * prompt sent through the proxy ("リバースプロキシした先からプロンプトを送信できない").
     *
     * `Sec-Fetch-Site` is `same-origin` on the operator's own page and `cross-site` on an attacker's,
     * regardless of how many proxies sit in between, because it describes the INITIATOR, not the
     * URL. Modern browsers always send it on a state-changing request.
     */
    const site = c.req.header("sec-fetch-site");
    if (site === "cross-site") return false;
    if (site === "same-origin" || site === "none") return true;
    /**
     * Older browsers do not send `Sec-Fetch-Site`, so fall back to comparing hosts — using
     * `X-Forwarded-Host` when a proxy supplied one.
     *
     * That is not a bypass: `X-Forwarded-Host` is not a CORS-safelisted header, so a cross-origin
     * page cannot set it without a preflight, and this server approves no preflight. A LOCAL process
     * could forge it — and a local process can already read the config, so it is not the threat this
     * guards.
     */
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "";
    try {
      const u = new URL(origin);
      if (u.host === host) return true;
    } catch {
      /* "null" (a sandboxed iframe or a redirect) is never acceptable */
      return false;
    }
    return false;
  };

  app.use("/api/*", async (c, next) => {
    /**
     * A cross-origin WRITE is refused BEFORE the token check.
     *
     * Order matters: a token-less server (`!want` below) would otherwise hand every cross-origin
     * request straight through, which is exactly the state a first-run install is in.
     */
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && !sameOrigin(c)) {
      return c.json(
        { error: "cross-origin request refused — set an API token in settings, or call the API from a local client" },
        403,
      );
    }
    const want = apiToken();
    /**
     * With no token configured the API is still open to LOCAL clients, but it now says so loudly.
     *
     * Opening it is a real decision: a fresh install has no password, and on loopback that is the
     * safe default — only this machine can reach it. (It IS settable now, in settings → live update;
     * before that the only path was `POST /api/setup`, which refuses once a config file exists, so
     * the wizard's removal had left no way at all.) Leaving the state silent is how the OpenCode
     * advisory happened — their server was unauthenticated by default and nobody noticed. The header
     * makes it visible to every client, and the startup banner says it once in plain words.
     */
    if (!want) {
      c.header("x-teapot-auth", "none");
      return next();
    }
    const h = c.req.header("authorization");
    const provided = h?.startsWith("Bearer ") ? h.slice(7) : undefined;
    if (provided && provided === want) return next();
    if (tokenInQueryOk(c.req.path)) {
      const q = c.req.query("token");
      if (q && q === want) return next();
    }
    return c.json({ error: "unauthorized" }, 401);
  });

  // The per-agent terminal cap lives in `terminals.ts` now, next to the registry that owns the
  // shells — a counter here could drift from the shells it was meant to bound (it did once:
  // #70, where a refused connection decremented a slot it never took).

  /**
   * Live `/api/ws` event-stream connections.
   *
   * Every one of these receives EVERY agent's events, so the count is a direct
   * multiplier on fan-out, and `bus.setMaxListeners(1000)` only silences a
   * warning — it does not bound anything. Capped so a stuck or hostile client
   * cannot pin unbounded memory, and paired with a liveness check below so a
   * client that stops reading is reaped rather than buffered for ever.
   */
  let wsClients = 0;

  /**
   * Agent ids reserved by an in-flight create.
   *
   * The uniqueness loop is a check, not a reservation, and `addAgent` only
   * publishes the id after awaiting — so concurrent creates all computed the
   * same "unique" id and all persisted an entry. Reserving before the first
   * await closes the window. Entries are released as soon as the agent is
   * published or the create fails, so this never grows.
   */
  const idReservations = new Set<string>();

  // keyed by CHILD, not agent: one agent may have up to 10 concurrent
  // terminals, each with its own size and its own foreground program
  const termSizes = new TermSizeTracker();
  // #20 follow-up: apply the size with an ioctl on the pty DEVICE
  // (`stty -F <slave>`) rather than writing `stty …` into the child's stdin.
  //
  // Writing to stdin is only safe while a SHELL is reading it: when an
  // interactive program owns the tty (vim, less, a REPL) it is the PROGRAM that
  // reads, so the command arrived as keystrokes and landed in the operator's
  // document. MEASURED: `stty -F /dev/pts/0 rows 55 cols 190` sets the size
  // (readback 55 190), delivers a real SIGWINCH to the foreground process, and
  // emits no bytes into the terminal stream at all — the same mechanism VS Code
  // (node-pty) and Alacritty use.
  //
  // The slave is resolved per call rather than cached: `script` may have exited
  // and been replaced, and a stale device path would resize someone else's pty.
  //
  // There is deliberately NO stdin fallback. Writing `stty rows R cols C` into the child's
  // stdin is the bug that was reported twice: when a full-screen program owns the tty it
  // receives that line as KEYSTROKES, so it lands in the operator's document. A resize that
  // cannot be applied is better than one that types into vim — so this does nothing instead.
  // Hosts without /proc are covered by `resolvePtySlave`'s `ps` path.
  const setTermSize = (child: ChildProcess, rows: number, cols: number): void =>
    termSizes.request(child, rows, cols, (r, c) => {
      applyPtySize(child, r, c);
    });


  // ---- realtime events over WebSocket (replaces SSE for the web UI) ----
  app.get(
    "/api/ws",
    upgradeWebSocket(() => {
      let onUpdate: ((ev: unknown) => void) | null = null;
      let ka: ReturnType<typeof setInterval> | null = null;
      // set by onOpen, cleared by a pong. Declared at the connection's scope
      // because onMessage is a SIBLING handler and cannot see a local in onOpen.
      let awaitingPong = false;
      let counted = false;
      return {
        onOpen(_evt, ws) {
          // refuse beyond the cap rather than accepting and buffering.
          // Each connection costs a listener on the global bus and receives
          // every agent's events, so this bounds real memory, not just a count.
          if (wsClients >= MAX_WS_CLIENTS) {
            try {
              ws.send(JSON.stringify({ kind: "error", error: `too many event-stream clients (max ${MAX_WS_CLIENTS})` }));
              ws.close(1013, "too many clients");
            } catch {
              /* already gone */
            }
            return;
          }
          wsClients++;
          counted = true;
          // a client that stops reading makes ws.send buffer without bound; the
          // app-level ping doubles as a liveness probe — if a ping goes
          // unanswered the socket is reaped instead of accumulating
          const send = (data: unknown) => {
            try {
              ws.send(JSON.stringify(data));
            } catch {
              /* client gone */
            }
          };
          send({ kind: "hello", agents: [...master.agents.values()].map((a) => a.snapshot()) });
          onUpdate = (raw: unknown) => {
            const ev = raw as { kind?: string; agentId?: string };
            // attach the fresh snapshot to agent-update events so clients can
            // update their state WITHOUT a follow-up GET /api/agents poll
            if (ev?.kind === "agent-update" && ev.agentId) {
              const a = master.agents.get(ev.agentId);
              send({ ...ev, snapshot: a?.snapshot() });
              return;
            }
            send(ev);
          };
          bus.on("update", onUpdate);
          // app-level liveness ping every 30s, and a reaper for a client that
          // has stopped answering
          ka = setInterval(() => {
            if (awaitingPong) {
              // the previous ping went unanswered: the client is not reading,
              // so its send buffer is growing. Reap it.
              try {
                ws.close(1011, "unresponsive");
              } catch {
                /* already gone */
              }
              return;
            }
            awaitingPong = true;
            send({ kind: "ping" });
          }, 30_000);
        },
        onMessage(evt, ws) {
          // clients may send {"kind":"ping"} — nothing else to do today
          try {
            const m = JSON.parse(String(evt.data));
            if (m?.kind === "ping") ws.send(JSON.stringify({ kind: "pong" }));
            if (m?.kind === "pong") awaitingPong = false;
          } catch {
            /* ignore junk */
          }
        },
        onClose() {
          if (ka) clearInterval(ka);
          if (onUpdate) bus.off("update", onUpdate);
          // only a connection that was actually admitted owns a slot — a
          // refused one must not decrement one it never took (#70's lesson)
          if (counted) wsClients = Math.max(0, wsClients - 1);
        },
      };
    }),
  );

  // ---- human terminal: interactive shell in the agent's workspace ----
  // Uses util-linux `script` as a zero-dependency PTY when available (colors,
  // line editing, ctrl+c); falls back to plain pipes otherwise.

  /*
   * Terminals are SERVER state now (#term-shared): the list survives a reload and several
   * clients see the same shells. These REST routes own creation and closing; the WebSocket
   * below only ATTACHES to an existing terminal (or creates one when asked).
   */
  setTerminalResize(setTermSize, resolvePtySlave);
  // Terminals outlive a disconnect on purpose, but a CLOSED tab never re-attaches. Sweep the
  // ones nobody has held for hours so an abandoned shell does not live as long as the process.
  {
    const t = setInterval(() => {
      const n = reapIdleTerminals();
      if (n) console.log(`[teapot] ⌨ reaped ${n} idle terminal(s)`);
    }, 30 * 60_000);
    t.unref?.();
  }

  /** every live terminal, so a fresh page can rebuild the tab strip */
  app.get("/api/terminals", (c) => c.json({ terminals: listTerminals() }));

  app.post("/api/terminals", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { agentId?: string; title?: string }
      | null;
    if (!body) return c.json({ error: "a JSON body is required" }, 400);
    const agentId = String(body.agentId ?? "").trim();
    const agent = agentId ? master.agents.get(agentId) : undefined;
    if (!agent) return c.json({ error: `no such agent: ${agentId}` }, 404);
    const r = createTerminal(agentId, agent.workspace, body.title);
    if (!r.ok) return c.json({ error: r.error }, 409);
    return c.json({ terminal: r.terminal });
  });

  app.delete("/api/terminals/:tid", (c) => {
    const closed = closeTerminal(c.req.param("tid") ?? "");
    return c.json({ closed });
  });

  // every terminal of one agent (the UI groups tabs by agent)
  app.delete("/api/agents/:id/terminals", (c) => {
    const n = closeTerminalsFor(c.req.param("id") ?? "");
    return c.json({ closed: n });
  });

  app.get(
    "/api/agents/:id/term",
    upgradeWebSocket((c) => {
      const agentId = c.req.param("id") ?? "";
      /**
       * `?terminal=<id>` ATTACHES to an existing shell; without it a new one is created.
       *
       * The distinction is the whole point of moving terminals server-side: a reload sends the
       * id it already knows and gets its screen back, while a new tab sends nothing and gets a
       * fresh shell.
       */
      const wanted = c.req.query("terminal") ?? "";
      let attachedId = "";
      // the sink is a stable identity for THIS connection, so the registry can key per-client
      // sizes by it and detach exactly this one
      const sink = (msg: { kind: "data"; data: string } | { kind: "exit"; code: number | null }) => {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          /* client gone; onClose detaches */
        }
      };
      let ws: { send: (s: string) => void; close: () => void };
      return {
        onOpen(_evt, socket) {
          ws = socket;
          const agent = master.agents.get(agentId);
          if (!agent) {
            sink({ kind: "exit", code: null });
            try {
              socket.send(JSON.stringify({ kind: "exit", error: `no such agent: ${agentId}` }));
            } catch {
              /* ignore */
            }
            return;
          }
          let id = wanted;
          if (!id) {
            const created = createTerminal(agentId, agent.workspace);
            if (!created.ok) {
              try {
                socket.send(JSON.stringify({ kind: "exit", error: created.error }));
              } catch {
                /* ignore */
              }
              return;
            }
            id = created.terminal.id;
          }
          const r = attachTerminal(id, sink);
          if (!r.ok) {
            try {
              socket.send(JSON.stringify({ kind: "exit", error: r.error }));
            } catch {
              /* ignore */
            }
            return;
          }
          attachedId = id;
          // tell the client WHICH terminal this connection is for, then REPLAY the backlog so
          // the screen is correct before live output starts arriving
          try {
            socket.send(JSON.stringify({ kind: "attach", terminal: r.terminal }));
            if (r.replay) socket.send(JSON.stringify({ kind: "data", data: r.replay }));
          } catch {
            /* ignore */
          }
        },
        onMessage(evt) {
          let m: { kind?: string; data?: string; rows?: number; cols?: number };
          try {
            m = JSON.parse(String(evt.data));
          } catch {
            return;
          }
          if (!attachedId) return;
          if (m.kind === "input") writeTerminal(attachedId, String(m.data ?? ""));
          else if (m.kind === "resize") {
            const r = Number(m.rows) | 0;
            const cl = Number(m.cols) | 0;
            if (r > 0 && cl > 0) resizeTerminal(attachedId, sink, r, cl);
          }
        },
        onClose() {
          // DETACH, do not kill: a reload must not destroy the shell (#term-shared)
          if (!attachedId) return;
          detachTerminal(attachedId, sink);
          // the pty outlives us; drop this client's size so it stops constraining the others
          forgetTerminalSize(attachedId, sink);
        },
      };
    }),
  );

  // ---- agents ----
  app.get("/api/agents", (c) => c.json({ agents: [...master.agents.values()].map((a) => a.snapshot()) }));

  // create + start an agent on an arbitrary directory
  app.post("/api/agents", async (c) => {
    // `.catch(() => null)` like every other body read in this file. An
    // unparseable body used to throw inside the handler and surface as a bare
    // 500 — a client bug reported to the operator as a server fault, and it made
    // the route's own `400 "workspace required"` unreachable.
    const body = await c.req
      .json<{
      workspace?: string;
      id?: string;
      provider?: string;
      model?: string;
      start?: boolean;
    }>()
      .catch(() => null);
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    if (!body.workspace?.trim()) return c.json({ error: "workspace required" }, 400);
    const ws = resolveWorkspace(body.workspace, path.dirname(master.configPath));
    try {
      const st = await fs.stat(ws);
      if (!st.isDirectory()) return c.json({ error: "not a directory" }, 400);
    } catch {
      return c.json({ error: `directory not found: ${ws}` }, 400);
    }
    const base = (body.id?.trim() || path.basename(ws)).replace(/[^\w.-]/g, "-").slice(0, 40);
    // agent ids are unique among running agents (they key the URL) — on a
    // collision, auto-suffix so creating ~/a/proj and ~/b/proj just works
    let id = base;
    let n = 2;
    // ids must be unique among RUNNING agents AND persisted config entries —
    // a config-only agent (not yet loaded) would otherwise collide on addAgent
    //
    // the loop below is a CHECK, not a RESERVATION, and addAgent only
    // publishes the id after several awaits (mkdirSync, agent.init()). Every
    // concurrent request therefore passed the check, computed the same "unique"
    // id, and all persisted an entry — measured: 3 concurrent creates → 3 config
    // entries, and with 5 concurrent spawns each minting its own session dir,
    // `resolveSessionDir` binds to the first entry on restart and the rest are
    // orphaned.
    //
    // So the id is RESERVED synchronously, before the first await. The set is
    // per-process and only guards the window; a real agent arriving through
    // another path still collides correctly via addAgent's own check.
    while (
      (master.agents.has(id) || master.config.agents.some((a) => a.id === id) || idReservations.has(id))
    )
      id = `${base.slice(0, 38)}-${n++}`;
    idReservations.add(id);
    const releaseId = () => idReservations.delete(id);
    try {
      // the reservation covers the awaits inside addAgent; once the agent is
      // published the reservation is redundant and must be released
      const agent = await master.addAgent(
        { id, workspace: ws, provider: body.provider, model: body.model },
        { persist: true, fresh: true }, // new incarnation → never reuse old history
      );
      releaseId();
      // NOTE: creation no longer auto-starts an LLM loop — the agent sits in
      // "stopped" (a lazy, zero-cost session) until the operator sends the
      // first prompt or presses ▶ start. The web UI relies on this.
      if (body.start === true) agent.start("created via web");
      return c.json({ ok: true, agent: agent.snapshot() });
    } catch (err) {
      releaseId(); // never leak a reservation on failure
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // archive / restore / purge. "remove" used to mean "delete the config entry and
  // orphan the history on disk"; these make the three intents distinct — put it
  // away (reversible), bring it back, or destroy it for real.
  app.get("/api/archived", (c) => c.json({ agents: master.archivedAgents() }));

  app.post("/api/agents/:id/archive", async (c) => {
    try {
      return c.json(await master.archiveAgent(c.req.param("id")));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.post("/api/agents/:id/restore", async (c) => {
    try {
      return c.json(await master.restoreAgent(c.req.param("id")));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  // DESTRUCTIVE: config entry AND session directories
  app.delete("/api/agents/:id/purge", async (c) => {
    try {
      return c.json(await master.purgeAgent(c.req.param("id")));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  // remove agent (log file is kept)
  app.delete("/api/agents/:id", async (c) => {
    try {
      await master.removeAgent(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  // ---- filesystem browsing (read-only, for the workspace picker) ----
  app.get("/api/fs", async (c) => {
    // read the home directory through the shared helper. `process.env.HOME`
    // is unset on Windows, which made the old fallback yield the literal "~" —
    // and /api/fs would then browse a directory named ~.
    let p = c.req.query("path") || homeDir() || path.parse(process.cwd()).root;
    p = path.resolve(expandTilde(p));
    try {
      const entries = await fs.readdir(p, { withFileTypes: true });
      return c.json({
        path: p,
        parent: path.dirname(p),
        entries: entries
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .slice(0, 500)
          .map((e) => e.name)
          .sort(),
      });
    } catch {
      return c.json({ error: "cannot read" }, 400);
    }
  });

  /**
   * Batched ignore lookup: runs `git check-ignore --stdin` once per directory
   * and returns the subset of names that are gitignored. Never throws — a
   * non-git workspace simply yields an empty set.
   */
  async function checkIgnoredBatch(dirAbs: string, dirents: import("node:fs").Dirent[]): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      /**
       * Run git FROM THE DIRECTORY BEING LISTED, and pass bare names.
       *
       * `git -C <workspace> check-ignore` with workspace-relative paths fails when the workspace
       * itself is not a repository — and a workspace is very often just a PARENT FOLDER holding
       * several checkouts. MEASURED: with `~/work/tyb2` as the workspace, listing
       * `mt6589-emulator/` (its own repo, whose `.gitignore` line 1 is `renode/`) returned nothing
       * ignored, because `git -C ~/work/tyb2` exits with "not a git repository" and the empty
       * result was read as "nothing is ignored".
       *
       * `git -C <dirAbs>` finds the enclosing repo by walking UP, which is exactly the behaviour a
       * file tree wants: each directory reports against whichever repository actually contains it,
       * including a nested `.gitignore`. Bare names keep the parse below simple.
       */
      const relPaths = dirents.filter((d) => !d.name.startsWith(".")).map((d) => d.name);
      if (relPaths.length === 0) return out;
      const { execFile } = await import("node:child_process");
      const res = await new Promise<string>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const finished = (v: string) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        };
        const p = execFile(
          "git",
          // NOTE: no --quiet — it suppresses the stdout we parse
          // `-C dirAbs`, not the workspace: git then finds the enclosing repo by walking up, so a
          // workspace that is merely a PARENT of several checkouts still reports each one correctly
          ["-C", dirAbs, "check-ignore", "--stdin", "-z", "--verbose"],
          { encoding: "utf8", maxBuffer: 1 << 20 },
          (err, stdout) => finished(err || !stdout ? "" : stdout),
        );
        // git can exit before we finish writing (nothing to ignore, or the
        // cap below killed it). Without this handler the stdin "error"
        // becomes an UNCAUGHT EXCEPTION that kills the request — seen as
        // "write EPIPE" right after boot when several trees load at once.
        p.stdin?.on("error", () => { /* EPIPE etc. — result is just empty */ });
        // end stdin only AFTER the write flushes (ending immediately raced
        // the write and git saw an empty list), and hard-cap in case git
        // wedges — a tree listing must never hang
        p.stdin?.write(relPaths.join("\0") + "\0", () => {
          try { p.stdin?.end(); } catch { /* already gone */ }
        });
        timer = setTimeout(() => {
          try { p.kill("SIGKILL"); } catch { /* */ }
          finished("");
        }, 5_000);
      });
      // -z --verbose emits records as
      //   "<source> NUL <line> NUL <pattern> NUL <path> NUL"
      // so the ignored path is every 4th field starting at index 3
      const fields = res.split("\0");
      for (let i = 3; i < fields.length; i += 4) {
        const p = fields[i];
        if (p) out.add(path.basename(p));
      }
    } catch {
      /* no git, not a repo, or spawn failed → treat all as unignored */
    }
    return out;
  }

  // ---- workspace file tree (read-only, powers the 🗂 files panel) ----
  app.get("/api/agents/:id/tree", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const rel = c.req.query("path") || ".";
    let abs: string;
    try {
      abs = safeJoin(a.workspace, rel);
    } catch (err) {
      // safeJoin's message embeds the RESOLVED absolute path
      // ("path escapes workspace: /home/user/secret/project/…"), so returning it
      // verbatim hands the caller the server's directory layout. The rejection is
      // correct; the disclosure was not. Echo back the path AS GIVEN.
      return c.json({ error: `path is outside the workspace: ${rel}` }, 400);
    }
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return c.json({ error: "cannot read directory" }, 400);
    }
    const showHidden = c.req.query("hidden") === "1";
    const entries: { name: string; dir: boolean; size?: number; ignored?: boolean }[] = [];
    // one batched `git check-ignore` for the whole directory (respects
    // nested .gitignore files); absent repo / no git → nothing is "ignored"
    const ignoredNames = await checkIgnoredBatch(abs, dirents);
    for (const d of dirents) {
      if (d.name.startsWith(".") && !(showHidden && d.name !== "." && d.name !== ".."))
        continue; // hidden files stay out unless the caller opted in
      // .git behaves like an ignored entry (dimmed/hidden with the rest)
      const forceIgnored = !d.isDirectory() ? false : d.name === ".git";
      const isDir = d.isDirectory();
      let size: number | undefined;
      if (!isDir) {
        try {
          size = (await fs.stat(path.join(abs, d.name))).size;
        } catch {
          /* vanished mid-scan — fine */
        }
      }
      const gitIg = ignoredNames.has(d.name);
      entries.push({
        name: d.name,
        dir: isDir,
        ...(size !== undefined ? { size } : {}),
        ...(gitIg || forceIgnored ? { ignored: true } : {}),
      });
    }
    entries.sort((x, y) => (x.dir !== y.dir ? (x.dir ? -1 : 1) : x.name.localeCompare(y.name)));
    return c.json({
      path: rel === "." ? "" : rel,
      workspace: a.workspace,
      entries,
    });
  });

  // small text-file preview for the tree (binary-safe guard, hard cap)
  app.get("/api/agents/:id/file", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const rel = c.req.query("path") ?? "";
    if (!rel.trim()) return c.json({ error: "path required" }, 400);
    let abs: string;
    try {
      abs = safeJoin(a.workspace, rel);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    try {
      const buf = await fs.readFile(abs);
      if (buf.subarray(0, 8192).includes(0))
        return c.json({ path: rel, binary: true, content: "" });
      return c.json({
        path: rel,
        truncated: buf.length > 100_000,
        content: buf.subarray(0, 100_000).toString("utf8"),
        media: mediaKind(rel),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // raw bytes for media previews (images / video / audio) — auth-gated like
  // every other agent route, workspace-confined, served with the right MIME
  app.get("/api/agents/:id/raw", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const rel = c.req.query("path") ?? "";
    if (!rel.trim()) return c.json({ error: "path required" }, 400);
    let abs: string;
    try {
      abs = safeJoin(a.workspace, rel);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    try {
      const buf = await fs.readFile(abs);
      const kind = mediaKind(rel);
      if (!kind)
        return c.json({ error: "not a previewable media file" }, 400);
      if (buf.length > 200 * 1024 * 1024)
        return c.json({ error: "file too large to preview (>200MB)" }, 413);
      // hono-native body API — a raw `new Response(...)` returned here lost
      // its headers somewhere in the middleware chain (content-type arrived
      // as undefined), while c.body() passes them through correctly
      return c.body(
        new Uint8Array(buf),
        200,
        {
          "content-type": mimeFor(rel, kind),
          // previews only; the browser shouldn't cache stale workspace files
          "cache-control": "no-store",
          "content-disposition": `inline; filename="${encodeURIComponent(path.basename(rel))}"`,
        },
      );
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // write a file from the web UI's file-tree editor (human action, not an
  // agent tool — allowed even for read-only personas, never notifies the
  // agent). Optional baseContent enables optimistic-concurrency checking.
  app.put("/api/agents/:id/file", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const rel = c.req.query("path") ?? "";
    if (!rel.trim()) return c.json({ error: "path required" }, 400);
    const body = await c.req.json<{ content?: string; baseContent?: string }>().catch(() => null);
    if (body === null || typeof body.content !== "string")
      return c.json({ error: "content required" }, 400);
    let abs: string;
    try {
      abs = safeJoin(a.workspace, rel);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    try {
      let existing: Buffer | null = null;
      try {
        existing = await fs.readFile(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      // refuse to clobber binary files (same 8KB NUL probe as GET)
      if (existing && existing.subarray(0, 8192).includes(0))
        return c.json({ error: "binary file — edit refused" }, 400);
      // conflict check: the editor sends what it loaded; if disk moved on,
      // bounce with the fresh content instead of silently overwriting
      if (
        typeof body.baseContent === "string" &&
        existing &&
        existing.subarray(0, 100_000).toString("utf8") !== body.baseContent
      ) {
        return c.json(
          {
            error: "file changed on disk",
            current: existing.subarray(0, 100_000).toString("utf8"),
          },
          409,
        );
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const content = Buffer.from(body.content, "utf8");
      await fs.writeFile(abs, content);
      return c.json({ ok: true, path: rel, size: content.length });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ---- config (view/edit from the web UI) ----
  app.get("/api/config", (c) => {
    const mask = (p: Record<string, { baseUrl: string; apiKey?: string; model?: string }> | undefined) =>
      Object.fromEntries(
        Object.entries(p ?? {}).map(([k, v]) => [
          k,
          { ...v, apiKey: v.apiKey ? "•••" + String(v.apiKey).slice(-4) : undefined },
        ]),
      );
    return c.json({
      configPath: master.configPath,
      /**
       * "First run" now means NO AI PROVIDER IS REGISTERED, not "no config file".
       *
       * The wizard that used to gate on the config file is gone. A config file can exist with no
       * usable provider (the operator edited it by hand, or every provider was removed), and in
       * that state the wizard did not appear and the app simply could not do anything. The
       * question the UI actually needs answered is "can this thing talk to a model yet?".
       *
       * A provider counts as registered when it has an entry at all — a key may legitimately be
       * absent for a local endpoint (ollama, a proxy that authenticates by network), so requiring
       * one would nag about a working setup.
       */
      needsSetup: Object.keys(master.config.providers ?? {}).length === 0,
      /**
       * Whether an API password is set — the FACT only, never the value.
       *
       * The panel needs it to label the field honestly ("unchanged" vs "none"); sending the secret
       * back would put it in the DOM and in any devtools capture of the response.
       */
      hasPassword: Boolean(master.config.password),
      providers: mask(master.config.providers),
      defaultProvider: master.config.defaultProvider,
      progressIntervalMs: master.config.progressIntervalMs,
      progressMinChars: master.config.progressMinChars,
      contextTokenBudget: master.config.contextTokenBudget,
      contextWindowTokens: master.config.contextWindowTokens,
      maxSpawnDepth: master.config.maxSpawnDepth,
      shortContext: master.config.shortContext,
      tasks: master.config.tasks,
      // the SAVED MCP servers. Without this the settings dialog opened with an
      // empty list, so adding a server, saving, and reopening showed nothing — the save
      // had worked, but nothing ever read it back. Headers are returned as saved: they
      // are ordinary config, and the dialog needs them to round-trip.
      mcpServers: master.config.mcpServers ?? [],
      agents: master.config.agents.map((a) => ({ id: a.id, workspace: a.workspace, provider: a.provider, model: a.model })),
      version: master.getVersion(),
    });
  });

  app.put("/api/config", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    // schema gate first: reject malformed edits with actionable messages
    const parsed = ConfigPatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: formatZodError(parsed.error) }, 400);
    const patch = parsed.data;
    try {
      for (const t of patch.tasks ?? []) parseSchedule(t.schedule);
      // keep masked keys intact: "•••1234" means "unchanged"
      const prev = master.config.providers ?? {};
      const providers: Record<string, ProviderConfig> = {};
      for (const [name, p] of Object.entries(patch.providers ?? {})) {
        const masked = !p.apiKey || p.apiKey.startsWith("•••");
        providers[name] = {
          baseUrl: p.baseUrl ?? "",
          apiKey: masked ? prev[name]?.apiKey : p.apiKey,
          ...(p.model ? { model: p.model } : {}),
        };
      }
      master.updateConfig({
        providers,
        defaultProvider: patch.defaultProvider,
        progressIntervalMs: patch.progressIntervalMs,
        progressMinChars: patch.progressMinChars,
        contextTokenBudget: patch.contextTokenBudget,
        // these four were validated (200 ok) and then DROPPED — the settings
        // modal's context window never reached the config at all
        contextWindowTokens: patch.contextWindowTokens,
        maxTurnsPerRound: patch.maxTurnsPerRound,
        onError: patch.onError,
        retryDelayMs: patch.retryDelayMs,
        maxSpawnDepth: patch.maxSpawnDepth,
        shortContext: patch.shortContext,
        tasks: patch.tasks,
        mcpServers: patch.mcpServers,
        ...(patch.password !== undefined ? { password: patch.password } : {}),
      });
      // apply the new server list to the live registry and connect in the
      // background — an added server's tools must appear on the next turn without a
      // restart, and a removed one's connection must be closed now.
      if (patch.mcpServers) {
        mcp.apply(patch.mcpServers);
        void mcp.connectAll();
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ---- MCP servers ----
  //
  // `test` is the endpoint the settings panel uses to answer "does this work?" before
  // saving: it connects, lists tools, and reports the count or the exact failure. Doing
  // that through `PUT /api/config` would mean saving a broken server first, and the
  // failure would then surface on an agent's turn instead of in the panel that caused it.
  app.get("/api/mcp", (c) =>
    c.json({
      servers: master.config.mcpServers ?? [],
      states: mcp.states().map((s) => ({
        name: s.config.name,
        status: s.status,
        tools: s.tools.length,
        ...(s.lastError ? { lastError: s.lastError } : {}),
        ...(s.lastChecked ? { lastChecked: s.lastChecked } : {}),
      })),
    }),
  );

  // Agent Plugins: what was loaded, and where from. Read-only on purpose —
  // installing a plugin is a filesystem act, and a web endpoint that unpacks an
  // archive is a much larger surface than this feature is worth.
  app.get("/api/plugins", (c) =>
    c.json({
      pluginsDir:
        master.config.pluginsDir === false
          ? null
          : (master.config.pluginsDir ?? null),
      plugins: master.plugins.map((p) => ({
        name: p.name,
        ...(p.version ? { version: p.version } : {}),
        ...(p.description ? { description: p.description } : {}),
        root: p.root,
        skills: p.skills,
        mcpServers: p.mcpServers.map((s) => s.name),
        warnings: p.warnings,
      })),
    }),
  );

  /**
   * Start an OAuth flow for one server.
   *
   * Responds with the URL to open IMMEDIATELY; the exchange finishes when the browser
   * comes back to the loopback listener. That split is what lets the panel show a
   * clickable link instead of hanging the request for minutes.
   */
  app.post("/api/mcp/oauth/start", async (c) => {
    const body = await c.req
      .json<{ name?: string; scopes?: string[]; url?: string; transport?: McpServerConfig["transport"] }>()
      .catch(() => null);
    if (!body?.name) return c.json({ error: "missing name" }, 400);
    /**
     * Accept a server that has not been SAVED yet.
     *
     * Requiring a saved entry forced the operator through save → dialog closes → reopen → authorize,
     * and then a second save afterwards to keep the grant attached. Asked as "未保存のMCPサーバーに
     * 対してOAuthまでした状態を後から保存するというちょっとめんどくさいフローが発生しちゃう".
     *
     * The URL from the request wins when present; otherwise the saved entry is used. Nothing is
     * written here — the grant is stored per server NAME in the OAuth store, so saving afterwards
     * keeps it.
     */
    const saved = (master.config.mcpServers ?? []).find((m) => m.name === body.name);
    const targetUrl = String(body.url ?? saved?.url ?? "").trim();
    if (!targetUrl)
      return c.json({ error: "this server has no url — OAuth needs an http(s) endpoint" }, 400);
    try {
      // register the candidate so the flow has a config to drive; replaced by the real one on save
      mcp.registerUnsaved({ name: body.name, url: targetUrl, transport: body.transport ?? "http", enabled: true });
      // `startOAuth` drives the SDK's own flow: discovery, dynamic registration, and the
      // PKCE challenge all happen inside `connectMcp`, so this returns as soon as there
      // is a URL to open. The exchange finishes when the browser hits the callback.
      const { url } = await mcp.startOAuth(body.name, {
        ...(body.scopes?.length ? { scopes: body.scopes } : {}),
      });
      const st = mcp.oauthStatus(body.name);
      if (!url && st.authorized)
        // a stored refresh token was still good — nothing for the operator to do
        return c.json({ ok: true, alreadyAuthorized: true });
      if (!url)
        return c.json({ ok: false, error: st.lastError ?? "the authorization server produced no url" });
      return c.json({ ok: true, url });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message });
    }
  });

  app.get("/api/mcp/oauth/status", (c) => {
    const name = c.req.query("name");
    if (!name) return c.json({ error: "missing name" }, 400);
    // "needs OAuth" is now discovered by the SDK itself: an unauthorized connect leaves
    // the server in `oauthRequired`, so there is no separate probe endpoint. The panel
    // triggers that by calling `/api/mcp/connect` or by `test`.
    const st = mcp.states().find((s) => s.config.name === name);
    return c.json({ ...mcp.oauthStatus(name), required: Boolean(st?.oauthRequired) });
  });

  app.post("/api/mcp/oauth/disconnect", async (c) => {
    const body = await c.req.json<{ name?: string }>().catch(() => null);
    if (!body?.name) return c.json({ error: "missing name" }, 400);
    await mcp.disconnect(body.name);
    return c.json({ ok: true });
  });
  app.post("/api/mcp/test", async (c) => {
    const body = await c.req.json<McpServerConfig>().catch(() => null);
    if (!body?.name) return c.json({ error: "a server needs a name" }, 400);
    try {
      // no OAuth provider here on purpose: `test` answers "is this reachable and what
      // does it expose", which an unauthorized server can still answer with a clear 401.
      // Starting a browser flow from a test button would be a surprise.
      const conn = await connectMcp({ ...body, enabled: true });
      try {
        const tools = await conn.tools();
        return c.json({
          ok: true,
          tools: tools.map((t) => ({ name: t.name, description: t.description })),
        });
      } finally {
        await conn.close();
      }
    } catch (err) {
      const message = (err as Error).message;
      // The SDK reports a missing grant as an HTTP error with a `status`. Reading that is
      // reliable; matching the message is not (it is just "Error POSTing to endpoint").
      const status = (err as { status?: unknown }).status;
      const needsAuth =
        status === 401 || status === 403 || /unauthoriz|invalid_token|authorization required/i.test(message);
      return c.json({ ok: false, error: message, needsOAuth: needsAuth }, 200);
    }
  });

  app.post("/api/mcp/connect", async (c) => {
    const body = await c.req.json<{ name?: string }>().catch(() => null);
    if (!body?.name) return c.json({ error: "missing name" }, 400);
    try {
      const st = await mcp.connect(body.name);
      return c.json({ ok: true, status: st.status, tools: st.tools.length });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 200);
    }
  });

  app.get("/api/agents/:id", (c) => {
    const a = master.agents.get(c.req.param("id"));
    return a ? c.json(a.snapshot()) : notFound(c, "agent", c.req.param("id"));
  });

  // lazy session load: stopped (not restored) → idle, history rebuilt from the log
  app.post("/api/agents/:id/load", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    await a.load();
    return c.json({ ok: true, agent: a.snapshot() });
  });

  app.post("/api/agents/:id/prompt", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const body = await c.req
      .json<{ text?: string; start?: boolean; images?: { url: string; name?: string }[] }>()
      .catch(() => null); // #110
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    if (!body.text?.trim() && !body.images?.length)
      return c.json({ error: "text or images required" }, 400);
    // validate images: data URLs or http(s), size-capped (a 20MB base64 blob
    // in the log would hurt every future replay of this session)
    const images = (body.images ?? []).filter((im) => {
      const u = String(im?.url ?? "");
      if (u.startsWith("data:image/")) return u.length < 12_000_000; // ~9MB binary
      return /^https?:\/\//.test(u);
    });
    const text = body.text ?? "";
    // returns immediately: the prompt is logged + broadcast now, delivered to
    // the model at the next turn boundary (never blocks on a running agent).
    // promptId ties the UI's pending echo to the later prompt-delivered note.
    const promptId = a.enqueuePrompt(text || "(see attached image)", "user", images.length ? images : undefined);
    if (body.start !== false && a.status !== "running") a.start("prompt");
    return c.json({ ok: true, promptId, queued: a.snapshot().pendingPrompts });
  });

  // Withdraw a still-pending prompt; returns its text for the composer draft.
  app.post("/api/agents/:id/prompt/cancel", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const body = await c.req.json<{ promptId?: string }>().catch(() => null); // #110
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    if (!body.promptId) return c.json({ error: "promptId required" }, 400);
    const text = a.cancelPrompt(body.promptId);
    if (text === null) return c.json({ error: "not pending (already delivered?)" }, 409);
    return c.json({ ok: true, text });
  });

  app.post("/api/agents/:id/start", (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    a.start("api start");
    return c.json({ ok: true });
  });

  // ---- providers & models (for the session panel's model switcher) ----
  app.get("/api/providers", (c) =>
    c.json({
      providers: Object.entries(master.config.providers ?? {}).map(([name, p]) => ({
        name,
        baseUrl: p.baseUrl,
        hasKey: !!p.apiKey,
        model: p.model,
      })),
      defaultProvider: master.config.defaultProvider,
    }),
  );

  // OpenAI-compatible upstream model listing (GET /v1/models)
  app.get("/api/models", async (c) => {
    const provName = c.req.query("provider") || master.config.defaultProvider || "";
    const prov = master.config.providers?.[provName];
    if (!prov?.baseUrl) return c.json({ error: `unknown provider: ${provName}` }, 400);
    try {
      return c.json({ provider: provName, models: await listModels(prov.baseUrl, prov.apiKey) });
    } catch (err) {
      return c.json({ error: `model list failed: ${(err as Error).message}` }, 502);
    }
  });

  // Model discovery DURING first-run setup — the config file doesn't exist
  // yet, so there are no named providers to ask for. Takes the raw endpoint
  // + key the operator is typing in the wizard and proxies GET /models.
  app.get("/api/setup/models", async (c) => {
    if (master.configFileExists) return c.json({ error: "setup already completed" }, 409);
    const baseUrl = c.req.query("baseUrl") ?? "";
    if (!/^https?:\/\//.test(baseUrl)) return c.json({ error: "valid baseUrl required" }, 400);
    try {
      return c.json({
        models: await listModels(baseUrl, c.req.query("apiKey") || undefined),
      });
    } catch (err) {
      return c.json({ error: `model list failed: ${(err as Error).message}` }, 502);
    }
  });

  // switch a running session's model/provider
  app.post("/api/agents/:id/model", async (c) => {
    const body = await c.req
      .json<{
        provider?: string;
        model?: string;
        contextWindowTokens?: number;
        reasoningEffort?: string; // "" clears back to the provider default (#47)
      }>()
      .catch(() => null);
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    try {
      const r = await master.setAgentModel(
        c.req.param("id"),
        body.provider,
        body.model,
        body.contextWindowTokens,
        body.reasoningEffort,
      );
      return c.json({ ok: true, ...r });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post("/api/agents/:id/stop", (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    a.stop("stopped via api");
    return c.json({ ok: true });
  });

  app.post("/api/agents/:id/goal", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const body = await c.req.json<{
      text?: string;
      status?: "active" | "done" | "paused";
      notify?: boolean;
      verify?: string; // verification contract (pi-goal-x style completion audit)
    }>()
      .catch(() => null); // #110
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    if (body.text) {
      await a.setGoal(body.text);
      if (typeof body.verify === "string" && body.verify.trim())
        await a.setGoalVerify(body.verify.trim());
      // goals live behind get_goal(), so a silent save would go unnoticed —
      // queue a harness prompt unless the caller explicitly declines
      if (body.notify !== false) {
        a.enqueuePrompt(
          `[harness] The operator set a new goal:\n\n${body.text}\n\nAlign your work with it.`,
          "harness",
        );
        // an idle agent must actually START working on the new goal — the
        // queued prompt alone sat there forever when nothing else started
        // the loop (reported: goal save left the session idle indefinitely)
        if (a.status !== "running") a.start("goal set");
      }
    } else if (body.status) await a.setGoalStatus(body.status);
    else return c.json({ error: "text or status required" }, 400);
    return c.json({ ok: true });
  });

  // skills visible to an agent (workspace + global + bundled roots)
  app.get("/api/agents/:id/skills", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    try {
      const list = await currentSkills(a.toolCtx);
      return c.json({
        skills: list.map((s) => ({ name: s.name, description: s.description, source: s.source })),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /**
   * The BODY of one skill, by name.
   *
   * The list endpoint returns name/description/source only, which is what the `/` palette and the
   * settings list need — a skill body is up to tens of KB and no list should carry every one.
   * Reading is separate and on demand, the same shape as the timeline's event paging.
   *
   * Resolved through `currentSkills` rather than from a path in the request: the client never
   * names a file, so there is no traversal surface, and a skill that is not in this agent's roots
   * simply does not exist here.
   */
  app.get("/api/agents/:id/skills/:name", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const want = c.req.param("name");
    try {
      const list = await currentSkills(a.toolCtx);
      const def = list.find((s) => s.name === want);
      if (!def) return c.json({ error: `no skill named ${want}` }, 404);
      const text = await readSkillFile(def);
      // a hard cap, like the code preview: a pathological file must not fill the panel
      const MAX = 400_000;
      return c.json({
        name: def.name,
        description: def.description,
        source: def.source,
        files: def.files,
        text: text.length > MAX ? `${text.slice(0, MAX)}\n… truncated` : text,
        truncated: text.length > MAX,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // force a context compaction pass (slash command /compact)
  app.post("/api/agents/:id/compact", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    try {
      return c.json({ ok: true, ...(await a.compactNow()) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  // first-run wizard bootstrap — only while no config file exists
  app.post("/api/setup", async (c) => {
    if (master.configFileExists) return c.json({ error: "setup already completed" }, 409);
    const body = await c.req
      .json<{
        baseUrl?: string;
        apiKey?: string;
        model?: string;
        workspace?: string;
        agentName?: string;
        password?: string;
      }>()
      .catch(() => null);
    if (!body?.baseUrl || !body.model)
      return c.json({ error: "baseUrl and model are required" }, 400);
    try {
      return c.json(await master.applySetup(body as Parameters<Master["applySetup"]>[0]));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // per-agent auto-continue toggle (loops toward an active goal)
  app.post("/api/agents/:id/auto-continue", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const body = await c.req.json<{ value?: boolean }>().catch(() => null);
    if (!body || typeof body.value !== "boolean")
      return c.json({ error: "boolean value required" }, 400);
    const ac = master.config.agents.find((x) => x.id === c.req.param("id"));
    if (ac) ac.autoContinue = body.value;
    (a as unknown as { opts: { autoContinue: boolean } }).opts.autoContinue = body.value;
    master.saveConfig();
    bus.emit("update", { kind: "agent-update", agentId: c.req.param("id") });
    return c.json({ ok: true, value: body.value });
  });

  // per-agent auto-compact toggle (auto-summarize when context exceeds budget)
  app.post("/api/agents/:id/auto-compact", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const body = await c.req.json<{ value?: boolean }>().catch(() => null);
    if (!body || typeof body.value !== "boolean")
      return c.json({ error: "boolean value required" }, 400);
    const ac = master.config.agents.find((x) => x.id === c.req.param("id"));
    if (ac) ac.autoCompact = body.value;
    (a as unknown as { opts: { autoCompact: boolean } }).opts.autoCompact = body.value;
    master.saveConfig();
    bus.emit("update", { kind: "agent-update", agentId: c.req.param("id") });
    return c.json({ ok: true, value: body.value });
  });

  // default sub-agent personas for @mentions and spawn_agent
  app.get("/api/personas", (c) =>
    c.json({
      personas: Object.entries(SUB_PERSONAS).map(([key, p]) => ({ key, label: p.label, directive: p.directive })),
    }),
  );

  /**
   * Custom themes, SERVER-side, so they follow the config instead of one browser.
   *
   * They lived in `localStorage`: a theme made on the desktop did not exist on a phone or in a
   * second browser, and clearing site data lost it. Asked for as "カスタムテーマをlocalStorageじゃ
   * なくてサーバーで管理するようにしたい".
   *
   * Validation is deliberately shallow — `customThemes` is opaque to the server and the frontend
   * already sanitises on read (`sanitizeTheme`), which is where the palette's required shape is
   * known. What the server DOES enforce is that it is an array of objects and that the write lands
   * in the config FILE: a theme that exists only in memory is the #67 failure.
   */
  app.get("/api/themes", (c) =>
    c.json({
      themes: Array.isArray(master.config.customThemes) ? master.config.customThemes : [],
      prefs: master.config.themePrefs ?? {},
    }),
  );
  app.put("/api/themes", async (c) => {
    const body = await c.req
      .json<{ themes?: unknown; prefs?: unknown }>()
      .catch(() => null);
    if (!body || !Array.isArray(body.themes)) return c.json({ error: "themes[] required" }, 400);
    for (const t of body.themes) {
      if (!t || typeof t !== "object" || Array.isArray(t))
        return c.json({ error: "every theme must be an object" }, 400);
    }
    master.config.customThemes = body.themes;
    if (body.prefs && typeof body.prefs === "object" && !Array.isArray(body.prefs))
      master.config.themePrefs = body.prefs as typeof master.config.themePrefs;
    master.saveConfig();
    return c.json({ ok: true, themes: master.config.customThemes });
  });

  // spawn a sub-agent from the UI (@mention flow / manual)
  app.post("/api/agents/:id/spawn", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const body = await c.req
      .json<{ task?: string; context?: string; name?: string; persona?: string }>()
      .catch(() => null);
    if (!body?.task?.trim()) return c.json({ error: "task required" }, 400);
    try {
      const r = await master.spawnChildFor(a, {
        task: body.task,
        context: body.context === "fork" ? "fork" : "none",
        name: body.name,
        persona: body.persona,
      });
      return c.json({ ok: true, ...r });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // bulk-stop a parent's sub-agents (descendants included by default)
  app.post("/api/agents/:id/stop-children", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const body = await c.req.json<{ ids?: string[] }>().catch(() => ({ ids: undefined }));
    try {
      const r = await master.stopChildrenFor(c.req.param("id"), body.ids);
      return c.json({ ok: true, ...r });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // operator-maintained task list (todo.md) with optional agent notification
  app.post("/api/agents/:id/todo", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const body = await c.req.json<{ text?: string; notify?: boolean }>().catch(() => null);
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    await a.setTodo(body.text ?? "");
    // a notification-bearing save must actually WAKE the idle agent (the
    // queued prompt used to sit forever).
    //
    // #123 residual: but the START follows the NOTIFICATION, not the save. The
    // original fix left `a.start(...)` outside the gate — a brace-less if only
    // gates the enqueue — so `notify:false` (whose entire meaning is "save
    // silently") booted a stopped agent, and so did an EMPTY list. A todo save
    // is note-taking; booting an incarnation is a side effect.
    const shouldNotify = body.notify !== false && !!body.text?.trim();
    if (shouldNotify) {
      a.enqueuePrompt(
        `[harness] The operator updated the task list:\n\n${body.text}\n\nWork through it (get_todo() always has the latest).`,
        "harness",
      );
      if (a.status !== "running") a.start("todo set");
    }
    return c.json({ ok: true });
  });

  // edit a previously-sent prompt: forks there, optionally summarizes the tail
  app.post("/api/agents/:id/edit-prompt", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const body = await c.req
      .json<{ eventId?: string; text?: string; tail?: string }>()
      .catch(() => null);
    if (!body?.eventId || !body.text?.trim())
      return c.json({ error: "eventId and text required" }, 400);
    try {
      const r = await a.editPromptAt(
        body.eventId,
        body.text,
        body.tail === "summarize" ? "summarize" : "discard",
      );
      // the UI button is labelled "fork & RESEND", but nothing resent.
      // `editPromptAt` rewrites history and returns, leaving the agent idle —
      // so the edited prompt sat in the timeline looking sent while the model
      // had never seen it, and the operator had to notice and press start.
      //
      // start() here rather than in the client: the route already knows the edit
      // succeeded, and a client that failed to call it would leave the agent
      // silently idle with no error anywhere.
      a.start("edited prompt resent");
      return c.json({ ok: true, ...r });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  app.post("/api/agents/:id/fork", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const body = await c.req.json<{ fromEvent?: string | null }>().catch(() => ({ fromEvent: null }));
    const r = await a.fork(body.fromEvent ?? null);
    return c.json({ ok: true, ...r });
  });

  // ---- event log access (human/inspect friendly) ----
  // mtime-keyed parse cache: the web UI polls this endpoint every ~400ms and
  // re-reading + re-parsing the WHOLE chat.jsonl each time dominated CPU on
  // multi-MB sessions. The file only ever appends, so an unchanged mtime lets
  // us serve the previous parse verbatim.
  const eventsCache = new Map<string, { mtimeMs: number; size: number; events: Awaited<ReturnType<typeof readEvents>> }>();
  async function readEventsCached(filePath: string) {
    try {
      const st = await fs.stat(filePath);
      const hit = eventsCache.get(filePath);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.events;
      const events = await readEvents(filePath);
      if (eventsCache.size > 64) eventsCache.clear();
      eventsCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, events });
      return events;
    } catch {
      return readEvents(filePath);
    }
  }
  app.get("/api/agents/:id/events", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    // the frontend pairs a tool_call with its tool_result by walking the
    // events it holds, so a window that can contain a result WITHOUT its call
    // strands the bash row at "waiting for output…" forever — the call scrolled
    // out while the command was still running. 200 was small enough to hit this
    // on any moderately long command. The default is now sized to hold a whole
    // pair even when thousands of events land in between (a long stream logs one
    // per delta); the server clamps hard, so a caller asking for more is cheap.
    const limit = Math.min(Number(c.req.query("limit") ?? 2000), 20000);
    let filePath = a.log.filePath;
    // ?session=<internalId> reads ANY session owned by this agent (past
    // incarnations too) — the internal id, not the agent id, is the stable
    // timeline handle. Ownership is enforced via the manifest.
    const sessionId = c.req.query("session");
    if (sessionId) {
      const rec = master.sessionById(sessionId);
      if (!rec || rec.agentId !== c.req.param("id"))
        return notFound(c, "session (or it belongs to another agent)", sessionId);
      filePath = path.join(rec.dir, "chat.jsonl");
    }
    // the plain "latest N" request is what the UI polls every ~120 ms for
    // a RUNNING agent, and it is the one that does NOT need history — it serves
    // it from a tail read that scans ~2% of the file. `?before` (older pages)
    // and `?branch` genuinely need the whole log, so they keep the full parse.
    // `total` is a lower bound on the tail path (see readEventsTail) and is
    // only used for the "load older" affordance, where approximate is fine.
    const branch = c.req.query("branch");
    const before = c.req.query("before");
    // `?after=<id>` returns only what landed AFTER that event.
    //
    // This is the cursor the reconnect path was missing. Without it a dropped
    // socket is recovered by re-fetching the whole tail — 2,000 events by default
    // — and throwing away all but the few that are new. That is what makes the
    // architecture REST-authoritative: the frontend can only learn "something
    // changed" and must re-read to find out what.
    //
    // It is also the only cursor that can be cheap here: the tail path scans
    // backwards from EOF, so an `after` lookup that lands near the end reads a
    // small window instead of parsing the whole log.
    const after = c.req.query("after");
    if (after && !before && !branch) {
      const all = await readEventsCached(filePath);
      const idx = all.findIndex((e) => e.id === after);
      // an unknown cursor means the client's view is not a prefix of ours (a
      // compacted or rotated log), so a full tail is the only safe answer
      if (idx === -1) {
        const tail = await readEventsTail(filePath, limit);
        return c.json({ events: tail.events, total: tail.total, partial: tail.truncated, gap: true });
      }
      const events = all.slice(idx + 1);
      return c.json({ events, total: all.length, appended: events.length > 0 });
    }
    if (!before && !branch) {
      const tail = await readEventsTail(filePath, limit);
      return c.json({ events: tail.events, total: tail.total, partial: tail.truncated });
    }

    let events = await readEventsCached(filePath);
    if (branch) events = filterByBranch(events, branch, c.req.query("lineage") === "true");
    // cursor pagination for older pages: everything strictly BEFORE this id
    if (before) {
      const idx = events.findIndex((e) => e.id === before);
      events = idx === -1 ? [] : events.slice(0, idx);
      return c.json({ events: events.slice(-limit), total: events.length });
    }
    return c.json({ events: events.slice(-limit), total: events.length });
  });

  // ONE readdir-backed snapshot of every session on disk, owner included.
  // The UI fetches this once per agent-set change instead of fanning out one
  // request per agent — /api/agents/:id/sessions stays for compatibility.
  app.get("/api/sessions", (c) => c.json({ sessions: master.allSessions() }));

  // list the internal session ids (= stable timeline handles) an agent owns,
  // newest first — the web UI routes /session/<internalId> by these
  app.get("/api/agents/:id/sessions", (c) => {
    const id = c.req.param("id");
    // resolvable when live, configured, OR still owning sessions on disk
    // (a stopped/lazy agent must keep its timeline reachable)
    const known = master.agents.has(id) || master.config.agents.some((a) => a.id === id);
    const owned = master.sessionsOf(id);
    if (!known && owned.length === 0) return notFound(c, "agent", id);
    return c.json({ sessions: owned });
  });

  app.get("/api/agents/:id/branches", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    // cached like /events — this used to bypass it and re-read the whole log
    const events = await readEventsCached(a.log.filePath);
    const branches = new Map<string, { branch: string; events: number; forkedFrom?: unknown }>();
    for (const e of events) {
      const b = branches.get(e.branch) ?? { branch: e.branch, events: 0 };
      b.events++;
      branches.set(e.branch, b);
      // A fork event is recorded on the branch it was forked FROM (so the
      // parent chain stays linked), but it describes the branch it CREATED.
      // Attribute it to the new branch, or the fork shows up as belonging to
      // the old one and the fork picker mislabels it.
      if (e.type === "fork") {
        const created = String((e.data as { newBranch?: string } | undefined)?.newBranch ?? "");
        if (created && created !== e.branch) {
          const nb = branches.get(created) ?? { branch: created, events: 0 };
          nb.forkedFrom = e.data;
          branches.set(created, nb);
          b.events--; // it is not an event OF the branch it was forked from
          if (b.events <= 0) branches.delete(e.branch);
        } else {
          b.forkedFrom = e.data;
        }
      }
    }
    return c.json({ branches: [...branches.values()] });
  });

  // ---- metrics / SSE ----
  app.get("/api/metrics", (c) => c.json(master.metrics()));

  // current server version (for live-update polling)
  /**
   * A 404 that says WHICH thing was missing.
   *
   * there were 24 hand-copied `c.json({ error: "not found" }, 404)` lines.
   * From a client they are indistinguishable — a typo in an agent id, a deleted
   * session, or a bad route all produce the same three words, and none carries
   * the id that was looked up. The id is the first thing anyone debugging this
   * needs, and it is already in hand.
   */
  const notFound = (c: Context, what: string, id: string) =>
    c.json({ error: `${what} not found: ${id || "(no id given)"}` }, 404);

  /**
   * `uptimeSeconds` exists so the UI can tell "the server restarted" apart from "it is still the
   * old one" even when the VERSION did not change.
   *
   * The reload after a live update used to key off `version !== __APP_VERSION__` alone. That is
   * baked into the bundle at build time, so it works for a published update — but a restart that
   * ships the same version number (a local build, or a fix released without a bump) left the client
   * polling for the full timeout while a perfectly healthy server was already answering. Process
   * uptime is the honest signal: it can only be small if the image was replaced.
   */
  app.get("/api/version", (c) =>
    c.json({ version: master.getVersion(), uptimeSeconds: Math.round(process.uptime()) }),
  );

  /**
   * Live update: answer FIRST, then replace the process.
   *
   * `restartServer()` ends in `process.execve`, which does not return — so awaiting it here meant
   * the response never flushed and the browser saw `SocketError: other side closed` instead of
   * `{ok:true}` (MEASURED: "restart endpoint must answer: SocketError"). The browser then could not
   * tell a successful update from a crashed one, which is exactly the state the reload logic below
   * has to distinguish.
   *
   * So the handler returns immediately and the handover runs on the next tick. That also gives the
   * pending wind-down (which can take minutes for a long build) room to finish before the image is
   * replaced.
   */
  app.post("/api/update/restart", (c) => {
    setImmediate(() => {
      void master.restartServer().catch((err) => {
        console.error("[teapot] live update failed:", (err as Error).message);
      });
    });
    return c.json({ ok: true, restarting: true });
  });

  // scheduled tasks with computed next-fire times (cron visibility for the UI)
  app.get("/api/tasks", (c) => c.json({ tasks: master.tasksView() }));

  app.get("/api/events", (c) => {
    c.header("content-type", "text/event-stream");
    c.header("cache-control", "no-cache");
    c.header("connection", "keep-alive");
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const cleanup = () => {
          closed = true;
          clearInterval(ka);
          bus.off("update", onUpdate);
        };
        const send = (data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            // client vanished mid-write — never let this reach event emitters
            cleanup();
          }
        };
        send({ kind: "hello", agents: [...master.agents.values()].map((a) => a.snapshot()) });
        const onUpdate = (ev: unknown) => send(ev);
        bus.on("update", onUpdate);
        // keep-alive ping every 30s so proxies don't close the stream
        const ka = setInterval(() => send({ kind: "ping" }), 30_000);
        c.req.raw.signal.addEventListener("abort", cleanup);
      },
      cancel() {
        /* cleanup also runs via the abort listener above */
      },
    });
    return c.body(stream);
  });

  // RFC 2324 / HTCPCP compliance
  app.on(["GET", "POST", "BREW"], "/brew", (c) =>
    c.text("418 I'm a teapot \u{1FAD6}", 418),
  );
  app.on(["GET", "POST", "BREW"], "/brew/coffee", (c) =>
    c.text("418 I'm a teapot — coffee not supported (see RFC 2324 §2.3.2)", 418),
  );

  // ---- web ui (built by vite into ./public; no bundler needed to serve) ----
  // works both from dist/server/api.js and src/server/api.ts: ../../public
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");

  /**
   * CACHE POLICY FOR THE APP SHELL — the two halves must be OPPOSITE.
   *
   * header at all. With no header a browser falls back to HEURISTIC freshness (typically
   * `10% × (now − Last-Modified)`), and the shell is the one file that must never be stale: it is
   * what names the hashed bundle. A cached `index.html` keeps pointing at the PREVIOUS
   * `index-<hash>.js`, so an update is installed, the server serves the new build, and the browser
   * silently keeps running the old frontend — reported as "もしかしてブラウザのキャッシュが効いてて
   * アップデートされたフロントエンドが完全に適用されてない?" after two rounds of UI fixes that did
   * not appear.
   *
   * `no-cache` does NOT mean "do not cache": it means "revalidate before use", so the shell costs
   * one conditional request (answered 304 from ETag/Last-Modified, which `c.body`/`c.html` supply)
   * and can never be the stale one.
   *
   * The hashed assets are the opposite case: their NAME changes with their content, so a year of
   * `immutable` is correct and free. This mirrors what the theme-image route already does above,
   * for the same reason.
   */
  const SHELL_CACHE = "no-cache";
  const ASSET_CACHE = "public, max-age=31536000, immutable";

  const mime: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  const indexHtml = () => {
    try {
      return readFileSync(path.join(webRoot, "index.html"), "utf8");
    } catch {
      return null;
    }
  };
  /**
   * The shell's ETag, derived from its own bytes.
   *
   * `cache-control: no-cache` says "revalidate", and revalidation is only cheap if there is
   * something to revalidate AGAINST. MEASURED without one: the response carried neither `ETag` nor
   * `Last-Modified`, so every load re-downloaded the whole shell instead of getting a 304 — correct
   * but wasteful, and the shell is served on every page load and every deep link.
   *
   * Hashing the content (rather than a mtime) means a rebuilt-but-identical shell keeps its ETag,
   * so the 304 survives restarts, and any real change flips it. Computed once per process: the
   * build cannot change while a server is running, and a restart is what picks up a new build.
   */
  let shellEtag: string | null | undefined;
  const shellTag = (html: string): string => {
    if (shellEtag === undefined || shellEtag === null)
      shellEtag = `"${createHash("sha256").update(html).digest("base64url").slice(0, 27)}"`;
    return shellEtag;
  };
  /** answer a shell request, honouring `If-None-Match` */
  const serveShell = (c: {
    req: { header: (n: string) => string | undefined };
    body: (b: string, s: number, h: Record<string, string>) => Response;
    text: (b: string, s: number) => Response;
  }) => {
    const html = indexHtml();
    if (!html) return c.text("web UI not built — run: pnpm build-web", 404);
    const etag = shellTag(html);
    if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
    return c.body(html, 200, {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": SHELL_CACHE,
      etag,
    });
  };
  app.get("/", (c) => {
    return serveShell(c as never);
  });
  // SPA deep links: /session/<agentId> serves the app; the client routes it
  app.get("/session/*", (c) => {
    return serveShell(c as never);
  });
  app.get("/assets/*", (c) => {
    const rel = c.req.path.replace("/assets/", "");
    const file = path.resolve(webRoot, "assets", path.basename(rel)); // basename: no traversal
    try {
      return c.body(readFileSync(file), 200, {
        "content-type": mime[path.extname(file)] ?? "application/octet-stream",
        "cache-control": ASSET_CACHE,
      });
    } catch {
      return c.notFound();
    }
  });

  /**
   * Theme background images, stored SERVER-side.
   *
   * These used to live in `localStorage` as a data URI, which forced a hard 1.5MB cap: the quota
   * is ~5MB for the WHOLE origin, so one wallpaper could brick every other setting the UI keeps
   * there (themes, panel state, session history). A 1.5MB limit is also absurdly small for a
   * photograph — the operator hits it with anything from a phone camera.
   *
   * Now the file is a FILE: uploaded once, referenced by name from the theme, and served back.
   * No quota, so no cap; the only limit is what the upload route is willing to read.
   *
   * Written by hand rather than with `serveStatic` because the API is awkward and this needs
   * three things it does not obviously give: a traversal-proof path, an immutable cache header,
   * and a name→file mapping that cannot escape the assets dir.
   */
  const assetsDir = path.join(master.config.dataDir, "assets");
  const assetName = (raw: string): string | null => {
    // only the shapes we mint: hex + a known extension. Anything else cannot name a file here.
    const m = /^([a-f0-9]{32})\.(png|jpg|jpeg|gif|webp|avif)$/i.exec(raw);
    return m ? `${m[1]!.toLowerCase()}.${m[2]!.toLowerCase()}` : null;
  };
  const assetMime: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
  };

  /**
   * Serve an asset, optionally downscaled to a requested width.
   *
   * `?w=1920` returns a 1920-wide (long-edge) version, generated once and CACHED ON DISK next to
   * the original. The client uses this through `<img srcset>`, so the browser picks the width it
   * needs from the DISPLAY area and the device pixel ratio — no guessing on our side, which is the
   * problem a fixed size at upload time cannot solve: the same server is viewed on a laptop and a
   * 4K monitor, and a phone photo is 6000px wide regardless.
   *
   * Untrusted input is bounded three ways: the width must be one of the ALLOWED_WIDTHS ladder (a
   * client cannot ask for 10000 distinct sizes and fill the disk), the name must pass `assetName`,
   * and the derived file is written under a name that function still accepts.
   */
  const ALLOWED_WIDTHS = [640, 1280, 1920, 2560, 3840] as const;
  /**
   * The width ladder, for the client's `srcset`.
   *
   * Registered BEFORE `/api/assets/:name`: Hono matches in registration order, so the parameterised
   * route would otherwise swallow `meta` and answer 404 — measured, and the reason this is a
   * separate literal route rather than something the `:name` handler inspects.
   */
  app.get("/api/assets/meta", (c) => c.json({ widths: ALLOWED_WIDTHS }));
  app.get("/api/assets/:name", async (c) => {
    const name = assetName(c.req.param("name") ?? "");
    if (!name) return c.notFound();
    const ext = name.split(".").pop()!;
    const mime = assetMime[ext] ?? "application/octet-stream";
    const src = path.join(assetsDir, name);

    const rawW = c.req.query("w");
    const wanted = rawW ? Number(rawW) : 0;
    if (wanted && !(ALLOWED_WIDTHS as readonly number[]).includes(wanted)) {
      // a bounded ladder, so a client cannot mint unbounded files
      return c.json({ error: `unsupported width ${rawW}` }, 400);
    }

    try {
      // the cache header is immutable+1y, so a resized response must be cached on disk or every
      // viewer regenerates it
      if (wanted) {
        const cached = path.join(assetsDir, widthName(name, wanted));
        if (existsSync(cached)) {
          return c.body(await fs.readFile(cached), 200, {
            "content-type": mime,
            "cache-control": "public, max-age=31536000, immutable",
          });
        }
        const toolName = await imageToolName();
        if (toolName) {
          const tool = { name: toolName, kind: toolName === "ffmpeg" ? ("ffmpeg" as const) : (toolName as "magick" | "convert") };
          const r = await downscaleImage(src, cached, tool, wanted);
          if (r.resized) {
            return c.body(await fs.readFile(cached), 200, {
              "content-type": mime,
              "cache-control": "public, max-age=31536000, immutable",
            });
          }
        }
        // no tool, or the resize did not help: serve the original rather than fail. `srcset` still
        // works — the browser just gets more pixels than it asked for.
      }
      const buf = await fs.readFile(src);
      return c.body(buf, 200, {
        "content-type": mime,
        // the name is a UUID and never reused, so it can be cached forever
        "cache-control": "public, max-age=31536000, immutable",
      });
    } catch {
      return c.notFound();
    }
  });


  /**
   * The image optimiser, probed at most ONCE.
   *
   * Booting is not async here, and probing runs the binaries, so it is resolved lazily on the
   * first upload and the promise is kept — every later upload reuses the answer instead of
   * re-probing. A missing tool caches as null, which is a valid result.
   */
  let imageToolsProbe: Promise<string | null> | null = null;
  const imageToolName = () => {
    imageToolsProbe ??= detectImageTools()
      .then((r) => r.tool?.name ?? null)
      .catch(() => null);
    return imageToolsProbe;
  };

  app.post("/api/assets", async (c) => {
    /**
     * Accepts the raw image body, not a multipart form.
     *
     * The client already holds a `File`; `fetch(url, {body: file})` sends its bytes directly, so
     * there is no parser, no boundary handling and no temp file. The extension comes from the
     * content type, which keeps the stored name within `assetName`'s accepted set.
     */
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = Object.entries(assetMime).find(([, m]) => m === type)?.[0];
    if (!ext) {
      return c.json({ error: `unsupported image type: ${type || "(none)"}` }, 415);
    }
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (!buf.length) return c.json({ error: "empty body" }, 400);
    // a sanity ceiling, not a UX limit: it exists so one request cannot fill the disk
    const MAX_UPLOAD = 64 * 1024 * 1024;
    if (buf.length > MAX_UPLOAD) {
      return c.json({ error: `image is larger than ${MAX_UPLOAD / 1024 / 1024}MB` }, 413);
    }
    await fs.mkdir(assetsDir, { recursive: true });
    const name = `${crypto.randomUUID().replace(/-/g, "")}.${ext}`;
    const dest = path.join(assetsDir, name);
    await fs.writeFile(dest, buf);
    /**
     * Downscale with a native binary when one exists.
     *
     * A phone photo is 6000x4000 and is displayed with `background-size: cover` at window size, so
     * the browser decodes and keeps decoded ~24 megapixels for nothing — reported as "背景画像が
     * 大きいとブラウザがリサイズでかなり重くなっちゃう". Doing it once here makes every later repaint
     * cheap.
     *
     * A MISSING OPTIMISER IS NOT AN ERROR: `downscaleImage` returns `resized:false` and the
     * original stays. The response says what happened so the UI can be honest rather than
     * silently claiming to have optimised something.
     */
    /**
     * The ORIGINAL is stored untouched; sizes are derived on demand by `?w=`.
     *
     * Resizing once at upload looked simpler but cannot be right: the same asset is viewed on a
     * laptop and a 4K monitor, and `background-size: cover` means the needed width depends on the
     * DISPLAY area. Baking one size in either wastes bytes on the small screen or upscales on the
     * large one. Storing the original and serving `?w=` lets the browser choose from `srcset`,
     * which is the only place the real display size is known.
     */
    return c.json({
      name,
      url: `/api/assets/${name}`,
      bytes: buf.length,
    });
  });

  /**
   * Which optional native tools were found.
   *
   * "設定ウィンドウにオプション機能がどれくらい見つかったかとかは入れると良い方" — a feature that
   * silently does nothing when a binary is missing is indistinguishable from a broken one, so the
   * panel reports what is actually available rather than leaving the operator to guess.
   */
  app.get("/api/features", async (c) => {
    const [image, script] = await Promise.all([
      detectImageTools().catch(() => ({ tool: null, found: [] })),
      Promise.resolve({ present: process.platform !== "win32" && existsSync("/usr/bin/script") }),
    ]);
    return c.json({
      imageResize: {
        available: !!image.tool,
        tool: image.tool?.name ?? null,
        /** every candidate, so "ffmpeg missing but imagemagick present" is visible */
        found: image.found,
        maxEdge: MAX_EDGE,
      },
      // a pty is what makes terminal resizing work at all; on Windows this is expected to be off
      pty: { available: script.present, provider: script.present ? "script" : null },
    });
  });

  app.delete("/api/assets/:name", async (c) => {
    const name = assetName(c.req.param("name") ?? "");
    if (!name) return c.notFound();
    await fs.rm(path.join(assetsDir, name), { force: true }).catch(() => {});
    return c.json({ ok: true });
  });

  return app;
}

/**
 * Translate a wildcard bind address into the one `node:http` treats as dual-stack.
 *
 *
 *     listen({host: "0.0.0.0"})  -> bound 0.0.0.0 | family IPv4   ← IPv4 ONLY
 *     listen({host: "::"})       -> bound ::      | family IPv6   ← DUAL STACK
 *     listen({})                 -> bound ::                     ← DUAL STACK
 *
 * Over Tailscale that difference is decisive. The tailnet hands the host BOTH an
 * IPv4 address (100.x) and an IPv6 one (fd7a:…), and a client that resolves the
 * host to its IPv6 address CANNOT connect to an IPv4-only listener. Reported as
 * "0.0.0.0 にしても tailscale 越しに接続できない", with the tell that an IPv4-only
 * reverse proxy in front worked — exactly the asymmetry this produces:
 *
 *     0.0.0.0:7789  teapot  LISTEN 0.0.0.0:7789   <- IPv4 only  ✗ IPv6
 *          *:7788  proxy   LISTEN       *:7788    <- dual stack ✓
 *
 * So `0.0.0.0` — the spelling every operator reaches for, and what `--help`
 * advertises — is translated to "no hostname" rather than passed through, because
 * a missing hostname is what makes Node bind `::` with `IPV6_V6ONLY` off.
 * `::` is passed through for the same reason.
 */
export function dualStackHost(host: string | undefined): string | undefined {
  return host === "0.0.0.0" || host === "::" ? undefined : host;
}

/**
 * Serve the app, returning a handle that can release the listening socket.
 *
 * the live-update handover needs to give the port up WITHOUT exiting —
 * the outgoing process stays attached to the operator's terminal and supervises
 * its replacement, so it must not still be holding the port the replacement is
 * waiting to bind. Returning the server is what makes "stop serving, keep
 * running" expressible; previously the handle was dropped here and the only way
 * to release the port was process.exit().
 */
export function serveApp(app: Hono, port: number, host?: string): { close: () => Promise<void> } {
  const wss = new WebSocketServer({ noServer: true });
  const bindHost = dualStackHost(host);
  const server = serve(
    { fetch: app.fetch, port, hostname: bindHost, websocket: { server: wss } },
    (info) => {
      const shown =
        host && host !== "0.0.0.0" && host !== "::"
          ? `http://${host}:${info.port}`
          : `http://localhost:${info.port} (all interfaces, IPv4 + IPv6)`;
      console.log(`[teapot] master listening on ${shown}`);
    },
  );
  return {
    close: async () => {
      // WebSocket clients hold the server open; without this the close would
      // hang on a live terminal and the handover would stall.
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // A keep-alive connection can keep the socket open indefinitely; the
        // handover must not wait on that, so force it and report the port free
        // rather than blocking the replacement forever.
        setTimeout(resolve, 2_000);
      });
    },
  };
}
