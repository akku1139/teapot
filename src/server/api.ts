/**
 * REST + SSE API on Hono, plus static file serving for the web UI.
 */
import { Hono } from "hono";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { readFileSync, existsSync } from "node:fs";
import { currentSkills } from "../agent/tools.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSchedule } from "../scheduler/cron.ts";
import { TermSizeTracker } from "./term-size.ts";
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
 * Cap on concurrent `/api/ws` event-stream clients (#79).
 *
 * Each one holds a listener on the global bus and receives every agent's
 * events, so this bounds real fan-out. 64 is far above any plausible number of
 * open tabs on a LAN and low enough that a runaway client cannot exhaust memory.
 */
const MAX_WS_CLIENTS = 64;

  // Optional bearer auth for LAN exposure — TEAPOT_API_TOKEN env wins, else
  // the config's `password` field. Static files stay public; only /api/* is
  // gated.
  const apiToken = process.env.TEAPOT_API_TOKEN || master.config.password || "";

  /**
   * Routes where `?token=` is accepted (#79).
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

  if (apiToken)
    app.use("/api/*", async (c, next) => {
      const h = c.req.header("authorization");
      const provided = h?.startsWith("Bearer ") ? h.slice(7) : undefined;
      if (provided && provided === apiToken) return next();
      if (tokenInQueryOk(c.req.path)) {
        const q = c.req.query("token");
        if (q && q === apiToken) return next();
      }
      return c.json({ error: "unauthorized" }, 401);
    });

  // per-agent terminal spawn guard
  const termCounts = new Map<string, number>();

  /**
   * Live `/api/ws` event-stream connections (#79).
   *
   * Every one of these receives EVERY agent's events, so the count is a direct
   * multiplier on fan-out, and `bus.setMaxListeners(1000)` only silences a
   * warning — it does not bound anything. Capped so a stuck or hostile client
   * cannot pin unbounded memory, and paired with a liveness check below so a
   * client that stops reading is reaped rather than buffered for ever.
   */
  let wsClients = 0;

  /**
   * Agent ids reserved by an in-flight create (#71).
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
  const setTermSize = (child: ChildProcess, rows: number, cols: number): void =>
    termSizes.request(child, rows, cols, (r, c) => {
      if (!child.stdin?.writable) return;
      child.stdin.write(`stty rows ${r} cols ${c} >/dev/null 2>&1\n`);
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
          // #79: refuse beyond the cap rather than accepting and buffering.
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
          // has stopped answering (#79)
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
  app.get(
    "/api/agents/:id/term",
    upgradeWebSocket((c) => {
      const agentId = c.req.param("id") ?? "";
      let child: ChildProcess | null = null;
      // #70: whether THIS connection was admitted to the per-agent terminal
      // budget. Declared per connection (not inside onOpen) because onClose is a
      // sibling handler: a connection refused at the cap never incremented the
      // counter, so onClose must not decrement for it — that asymmetry walked
      // the counter below the live-shell count and disabled the cap entirely.
      let admitted = false;
      const cleanup = () => {
        if (!child) return;
        try {
          child.kill("SIGHUP");
        } catch {
          /* already gone */
        }
        child = null;
      };
      return {
        onOpen(_evt, ws) {
          const agent = master.agents.get(agentId);
          const send = (d: unknown) => {
            try {
              ws.send(JSON.stringify(d));
            } catch {
              /* client gone */
            }
          };
          const cur = termCounts.get(agentId) ?? 0;
          if (cur >= 10) {
            // soft safeguard only — the UI allows up to 10 tabs per agent
            send({ kind: "exit", error: "too many terminals for this agent (max 10)" });
            return;
          }
          termCounts.set(agentId, cur + 1);
          admitted = true;
          if (!agent) {
            // the slot was just taken and this connection owns it, so release
            // it here rather than leaving onClose to work it out
            termCounts.set(agentId, cur);
            admitted = false;
            send({ kind: "exit", error: `no such agent: ${agentId}` });
            return;
          }
          const shell = process.env.SHELL || "/bin/bash";
          const hasScript = existsSync("/usr/bin/script");
          // script's pty reports a 0x0 winsize, so shells fall back to these
          const env = { ...process.env, TERM: "xterm-256color", COLUMNS: "100", LINES: "30" };
          child = hasScript
            ? spawn("script", ["-qec", shell, "/dev/null"], { cwd: agent.workspace, env })
            : spawn(shell, [], { cwd: agent.workspace, env: { ...env, TERM: "dumb" } });
          console.log(
            `[teapot] ⌨ terminal open: ${agentId} @ ${agent.workspace} (${hasScript ? "pty" : "pipe"})`,
          );
          child.stdout?.on("data", (b: Buffer) => {
            termSizes.markBusy(child!);
            send({ kind: "data", data: b.toString("utf8") });
          });
          child.stderr?.on("data", (b: Buffer) => {
            termSizes.markBusy(child!);
            send({ kind: "data", data: b.toString("utf8") });
          });
          child.on("close", (code) => {
            send({ kind: "exit", code });
            console.log(`[teapot] ⌨ terminal exit: ${agentId} (${code ?? "signal"})`);
            child = null;
          });
        },
        onMessage(evt) {
          if (!child?.stdin?.writable) return;
          let m: { kind?: string; data?: string; rows?: number; cols?: number };
          try {
            m = JSON.parse(String(evt.data));
          } catch {
            return;
          }
          if (m.kind === "input") child.stdin.write(String(m.data ?? ""));
          else if (m.kind === "resize") {
            const r = Number(m.rows) | 0;
            const cl = Number(m.cols) | 0;
            if (r > 0 && cl > 0) setTermSize(child, r, cl);
          }
        },
        onClose() {
          // capture BEFORE cleanup() nulls the child out
          const dead = child;
          // drop the pending resize timer so we can't write into a dead child
          if (dead) termSizes.forget(dead);
          cleanup();
          // #70: only an ADMITTED connection owns a slot. A connection refused
          // at the cap never incremented, so decrementing for it is exactly
          // what drove the counter negative and disabled the limit.
          if (!admitted) return;
          const n = (termCounts.get(agentId) ?? 1) - 1;
          if (n <= 0) termCounts.delete(agentId);
          else termCounts.set(agentId, n);
        },
      };
    }),
  );

  // ---- agents ----
  app.get("/api/agents", (c) => c.json({ agents: [...master.agents.values()].map((a) => a.snapshot()) }));

  // create + start an agent on an arbitrary directory
  app.post("/api/agents", async (c) => {
    // #110: `.catch(() => null)` like every other body read in this file. An
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
    // #71: the loop below is a CHECK, not a RESERVATION, and addAgent only
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
    let p = c.req.query("path") || process.env.HOME || "/";
    p = path.resolve(p.replace(/^~/, process.env.HOME ?? "~"));
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
  async function checkIgnoredBatch(workspace: string, dirAbs: string, dirents: import("node:fs").Dirent[]): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const relPaths = dirents.filter((d) => !d.name.startsWith(".")).map((d) => path.relative(workspace, path.join(dirAbs, d.name)));
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
          ["-C", workspace, "check-ignore", "--stdin", "-z", "--verbose"],
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
    if (!a) return c.json({ error: "not found" }, 404);
    const rel = c.req.query("path") || ".";
    let abs: string;
    try {
      abs = safeJoin(a.workspace, rel);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
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
    const ignoredNames = await checkIgnoredBatch(a.workspace, abs, dirents);
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
    if (!a) return c.json({ error: "not found" }, 404);
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
    if (!a) return c.json({ error: "not found" }, 404);
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
    if (!a) return c.json({ error: "not found" }, 404);
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
      needsSetup: !master.configFileExists,
      providers: mask(master.config.providers),
      defaultProvider: master.config.defaultProvider,
      progressIntervalMs: master.config.progressIntervalMs,
      progressMinChars: master.config.progressMinChars,
      contextTokenBudget: master.config.contextTokenBudget,
      contextWindowTokens: master.config.contextWindowTokens,
      maxSpawnDepth: master.config.maxSpawnDepth,
      tasks: master.config.tasks,
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
        maxSpawnDepth: patch.maxSpawnDepth,
        tasks: patch.tasks,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.get("/api/agents/:id", (c) => {
    const a = master.agents.get(c.req.param("id"));
    return a ? c.json(a.snapshot()) : c.json({ error: "not found" }, 404);
  });

  // lazy session load: stopped (not restored) → idle, history rebuilt from the log
  app.post("/api/agents/:id/load", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    await a.load();
    return c.json({ ok: true, agent: a.snapshot() });
  });

  app.post("/api/agents/:id/prompt", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
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
    if (!a) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ promptId?: string }>().catch(() => null); // #110
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    if (!body.promptId) return c.json({ error: "promptId required" }, 400);
    const text = a.cancelPrompt(body.promptId);
    if (text === null) return c.json({ error: "not pending (already delivered?)" }, 409);
    return c.json({ ok: true, text });
  });

  app.post("/api/agents/:id/start", (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
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
    if (!a) return c.json({ error: "not found" }, 404);
    a.stop("stopped via api");
    return c.json({ ok: true });
  });

  app.post("/api/agents/:id/goal", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
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
    if (!a) return c.json({ error: "not found" }, 404);
    try {
      const list = await currentSkills(a.toolCtx);
      return c.json({
        skills: list.map((s) => ({ name: s.name, description: s.description, source: s.source })),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // force a context compaction pass (slash command /compact)
  app.post("/api/agents/:id/compact", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
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
    if (!a) return c.json({ error: "not found" }, 404);
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
    if (!a) return c.json({ error: "not found" }, 404);
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

  // spawn a sub-agent from the UI (@mention flow / manual)
  app.post("/api/agents/:id/spawn", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
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
    if (!a) return c.json({ error: "not found" }, 404);
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
    if (!a) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ text?: string; notify?: boolean }>().catch(() => null);
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    await a.setTodo(body.text ?? "");
    if (body.notify !== false && body.text?.trim())
      a.enqueuePrompt(
        `[harness] The operator updated the task list:\n\n${body.text}\n\nWork through it (get_todo() always has the latest).`,
        "harness",
      );
    return c.json({ ok: true });
  });

  // edit a previously-sent prompt: forks there, optionally summarizes the tail
  app.post("/api/agents/:id/edit-prompt", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
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
      // #96: the UI button is labelled "fork & RESEND", but nothing resent.
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
    if (!a) return c.json({ error: "not found" }, 404);
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
    if (!a) return c.json({ error: "not found" }, 404);
    // #54: the frontend pairs a tool_call with its tool_result by walking the
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
      if (!rec || rec.agentId !== c.req.param("id")) return c.json({ error: "not found" }, 404);
      filePath = path.join(rec.dir, "chat.jsonl");
    }
    // #59: the plain "latest N" request is what the UI polls every ~120 ms for
    // a RUNNING agent, and it is the one that does NOT need history — it serves
    // it from a tail read that scans ~2% of the file. `?before` (older pages)
    // and `?branch` genuinely need the whole log, so they keep the full parse.
    // `total` is a lower bound on the tail path (see readEventsTail) and is
    // only used for the "load older" affordance, where approximate is fine.
    const branch = c.req.query("branch");
    const before = c.req.query("before");
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
    if (!known && owned.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ sessions: owned });
  });

  app.get("/api/agents/:id/branches", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
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
      // the old one and the fork picker mislabels it (#38).
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
  app.get("/api/version", (c) => c.json({ version: master.getVersion() }));

  // trigger a full server restart (agents stopped gracefully, new process spawned)
  app.post("/api/update/restart", async (c) => {
    try {
      await master.restartServer();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
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
  app.get("/", (c) => {
    const html = indexHtml();
    return html ? c.html(html) : c.text("web UI not built — run: pnpm build-web", 404);
  });
  // SPA deep links: /session/<agentId> serves the app; the client routes it
  app.get("/session/*", (c) => {
    const html = indexHtml();
    return html ? c.html(html) : c.text("web UI not built — run: pnpm build-web", 404);
  });
  app.get("/assets/*", (c) => {
    const rel = c.req.path.replace("/assets/", "");
    const file = path.resolve(webRoot, "assets", path.basename(rel)); // basename: no traversal
    try {
      return c.body(readFileSync(file), 200, {
        "content-type": mime[path.extname(file)] ?? "application/octet-stream",
      });
    } catch {
      return c.notFound();
    }
  });

  return app;
}

/**
 * Serve the app, returning a handle that can release the listening socket.
 *
 * #35: the live-update handover needs to give the port up WITHOUT exiting —
 * the outgoing process stays attached to the operator's terminal and supervises
 * its replacement, so it must not still be holding the port the replacement is
 * waiting to bind. Returning the server is what makes "stop serving, keep
 * running" expressible; previously the handle was dropped here and the only way
 * to release the port was process.exit().
 */
export function serveApp(app: Hono, port: number, host?: string): { close: () => Promise<void> } {
  const wss = new WebSocketServer({ noServer: true });
  const server = serve(
    { fetch: app.fetch, port, hostname: host, websocket: { server: wss } },
    (info) => {
      const shown =
        host && host !== "0.0.0.0" && host !== "::"
          ? `http://${host}:${info.port}`
          : `http://localhost:${info.port} (all interfaces)`;
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
