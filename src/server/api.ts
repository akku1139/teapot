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
import { listBgShells, killBgShell } from "../agent/tools.ts";
import { applyPtySize, TermSizeTracker, resolvePtySlave } from "./term-size.ts";
import { expandTilde, homeDir } from "../home.ts";
import { SUB_PERSONAS, resolveWorkspace } from "../master.ts";
import { ConfigPatchSchema, formatZodError } from "../config-schema.ts";
import type { ProviderConfig } from "../master.ts";
import { safeJoin } from "../agent/tools.ts";
import { fetchModelList, type ModelMeta } from "../model-meta.ts";

/**
 * The model list the UI's picker shows, from models.dev.
 *
 * This used to be a SECOND parser that hit the provider's own `/models` and read OpenRouter's
 * `architecture` field — so it reported no capabilities for every other provider. MEASURED:
 * `deepseek/deepseek-v4.1-flash` on Command Code resolved correctly through `model-meta.ts` (input
 * text+image) while this route returned `modalities: undefined`, because Command Code publishes no
 * `architecture` at all. Two parsers for the same fact is exactly what the operator called "無駄で
 * バグの元"; `model-meta.ts` is now the single source.
 */
async function listModels(baseUrl: string, apiKey?: string): Promise<ModelMeta[]> {
  const list = await fetchModelList(baseUrl, apiKey);
  return [...list].sort((a, b) => a.id.localeCompare(b.id));
}
import path from "node:path";
import { bus } from "../bus.ts";
import { readEvents, readEventsTail, filterByBranch } from "../log/events.ts";
import type { Master } from "../master.ts";
import { mcp } from "../agent/mcp-registry.ts";
import { connectMcp, type McpServerConfig } from "../agent/mcp.ts";

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

export const MEDIA_MIME: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const e of IMAGE_EXT) m[e] = `image/${e === "jpg" ? "jpeg" : e}`;
  Object.assign(m, { svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif" });
  for (const e of VIDEO_EXT) m[e] = `video/${e === "mov" ? "quicktime" : e === "mkv" ? "x-matroska" : e}`;
  for (const e of AUDIO_EXT) m[e] = `audio/${e}`;
  Object.assign(m, { m4a: "audio/mp4", mp3: "audio/mpeg" });
  return m;
})();

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

const MAX_WS_CLIENTS = 64;

  const apiToken = () => process.env.TEAPOT_API_TOKEN || master.config.password || "";

  const tokenInQueryOk = (path: string): boolean =>
    path === "/api/ws" || /^\/api\/agents\/[^/]+\/term$/.test(path);

  const sameOrigin = (c: Context): boolean => {
    const origin = c.req.header("origin");
    if (origin === undefined) return true;
    const site = c.req.header("sec-fetch-site");
    if (site === "cross-site") return false;
    if (site === "same-origin" || site === "none") return true;
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "";
    try {
      const u = new URL(origin);
      if (u.host === host) return true;
    } catch {
      return false;
    }
    return false;
  };

  app.use("/api/*", async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && !sameOrigin(c)) {
      return c.json(
        { error: "cross-origin request refused — set an API token in settings, or call the API from a local client" },
        403,
      );
    }
    const want = apiToken();
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

  let wsClients = 0;

  const idReservations = new Set<string>();

  const termSizes = new TermSizeTracker();
  const setTermSize = (child: ChildProcess, rows: number, cols: number): void =>
    termSizes.request(child, rows, cols, (r, c) => {
      applyPtySize(child, r, c);
    });

  app.get(
    "/api/ws",
    upgradeWebSocket(() => {
      let onUpdate: ((ev: unknown) => void) | null = null;
      let ka: ReturnType<typeof setInterval> | null = null;
      let awaitingPong = false;
      let counted = false;
      return {
        onOpen(_evt, ws) {
          if (wsClients >= MAX_WS_CLIENTS) {
            try {
              ws.send(JSON.stringify({ kind: "error", error: `too many event-stream clients (max ${MAX_WS_CLIENTS})` }));
              ws.close(1013, "too many clients");
            } catch {
            }
            return;
          }
          wsClients++;
          counted = true;
          const send = (data: unknown) => {
            try {
              ws.send(JSON.stringify(data));
            } catch {
            }
          };
          send({ kind: "hello", agents: [...master.agents.values()].map((a) => a.snapshot()) });
          onUpdate = (raw: unknown) => {
            const ev = raw as { kind?: string; agentId?: string };
            if (ev?.kind === "agent-update" && ev.agentId) {
              const a = master.agents.get(ev.agentId);
              send({ ...ev, snapshot: a?.snapshot() });
              return;
            }
            send(ev);
          };
          bus.on("update", onUpdate);
          ka = setInterval(() => {
            if (awaitingPong) {
              try {
                ws.close(1011, "unresponsive");
              } catch {
              }
              return;
            }
            awaitingPong = true;
            send({ kind: "ping" });
          }, 30_000);
        },
        onMessage(evt, ws) {
          try {
            const m = JSON.parse(String(evt.data));
            if (m?.kind === "ping") ws.send(JSON.stringify({ kind: "pong" }));
            if (m?.kind === "pong") awaitingPong = false;
          } catch {
          }
        },
        onClose() {
          if (ka) clearInterval(ka);
          if (onUpdate) bus.off("update", onUpdate);
          if (counted) wsClients = Math.max(0, wsClients - 1);
        },
      };
    }),
  );

  setTerminalResize(setTermSize, resolvePtySlave);
  {
    const t = setInterval(() => {
      const n = reapIdleTerminals();
      if (n) console.log(`[teapot] ⌨ reaped ${n} idle terminal(s)`);
    }, 30 * 60_000);
    t.unref?.();
  }

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

  app.delete("/api/agents/:id/terminals", (c) => {
    const n = closeTerminalsFor(c.req.param("id") ?? "");
    return c.json({ closed: n });
  });

  app.get(
    "/api/agents/:id/term",
    upgradeWebSocket((c) => {
      const agentId = c.req.param("id") ?? "";
      const wanted = c.req.query("terminal") ?? "";
      let attachedId = "";
      const sink = (msg: { kind: "data"; data: string } | { kind: "exit"; code: number | null }) => {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
        }
      };
      let ws: { send: (s: string) => void; close: () => void };
      let ka: ReturnType<typeof setInterval> | undefined;
      return {
        onOpen(_evt, socket) {
          ws = socket;
          const agent = master.agents.get(agentId);
          if (!agent) {
            sink({ kind: "exit", code: null });
            try {
              socket.send(JSON.stringify({ kind: "exit", error: `no such agent: ${agentId}` }));
            } catch {
            }
            return;
          }
          let id = wanted;
          ka = setInterval(() => {
            try {
              socket.send(JSON.stringify({ kind: "ping" }));
            } catch {
            }
          }, 30_000);
          if (!id) {
            const created = createTerminal(agentId, agent.workspace);
            if (!created.ok) {
              try {
                socket.send(JSON.stringify({ kind: "exit", error: created.error }));
              } catch {
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
            }
            return;
          }
          attachedId = id;
          try {
            socket.send(JSON.stringify({ kind: "attach", terminal: r.terminal }));
            if (r.replay) socket.send(JSON.stringify({ kind: "data", data: r.replay }));
          } catch {
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
          if (ka) clearInterval(ka);
          if (!attachedId) return;
          detachTerminal(attachedId, sink);
          forgetTerminalSize(attachedId, sink);
        },
      };
    }),
  );

  app.get("/api/agents", (c) => c.json({ agents: [...master.agents.values()].map((a) => a.snapshot()) }));

  app.post("/api/agents", async (c) => {
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
    let id = base;
    let n = 2;
    while (
      (master.agents.has(id) || master.config.agents.some((a) => a.id === id) || idReservations.has(id))
    )
      id = `${base.slice(0, 38)}-${n++}`;
    idReservations.add(id);
    const releaseId = () => idReservations.delete(id);
    try {
      const agent = await master.addAgent(
        { id, workspace: ws, provider: body.provider, model: body.model },
        { persist: true, fresh: true }, 
      );
      releaseId();
      if (body.start === true) agent.start("created via web");
      return c.json({ ok: true, agent: agent.snapshot() });
    } catch (err) {
      releaseId(); 
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.get("/api/agents/:id/bg-jobs", (c) => {
    const agent = master.agents.get(c.req.param("id"));
    if (!agent) return c.json({ error: "no such agent" }, 404);
    const snap = agent.snapshot();
    return c.json({ jobs: listBgShells(snap.workspace ?? "", snap.sessionDir) });
  });

  app.delete("/api/agents/:id/bg-jobs/:job", (c) => {
    const agent = master.agents.get(c.req.param("id"));
    if (!agent) return c.json({ error: "no such agent" }, 404);
    const snap = agent.snapshot();
    const ok = killBgShell(snap.workspace ?? "", c.req.param("job"), snap.sessionDir);
    return c.json({ ok }, ok ? 200 : 404);
  });

  app.get("/api/archived", (c) => c.json({ agents: master.archivedAgents() }));

  app.put("/api/agents/:id/session-title", async (c) => {
    const sessionId = c.req.query("session") ?? "";
    if (!sessionId) return c.json({ error: "?session= is required" }, 400);
    const body = await c.req.json<{ title?: string }>().catch(() => null);
    if (!body || typeof body.title !== "string") return c.json({ error: "title is required" }, 400);
    try {
      return c.json(await master.renameSession(c.req.param("id"), sessionId, body.title));
    } catch (err) {
      const msg = (err as Error).message;
      const code = /no such agent|not on session/.test(msg) ? 404 : 400;
      return c.json({ error: msg }, code);
    }
  });

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

  app.delete("/api/agents/:id/purge", async (c) => {
    try {
      return c.json(await master.purgeAgent(c.req.param("id")));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.delete("/api/agents/:id", async (c) => {
    try {
      await master.removeAgent(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.get("/api/fs", async (c) => {
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

  async function checkIgnoredBatch(dirAbs: string, dirents: import("node:fs").Dirent[]): Promise<Set<string>> {
    const out = new Set<string>();
    try {
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
          ["-C", dirAbs, "check-ignore", "--stdin", "-z", "--verbose"],
          { encoding: "utf8", maxBuffer: 1 << 20 },
          (err, stdout) => finished(err || !stdout ? "" : stdout),
        );
        p.stdin?.on("error", () => {  });
        p.stdin?.write(relPaths.join("\0") + "\0", () => {
          try { p.stdin?.end(); } catch {  }
        });
        timer = setTimeout(() => {
          try { p.kill("SIGKILL"); } catch {  }
          finished("");
        }, 5_000);
      });
      const fields = res.split("\0");
      for (let i = 3; i < fields.length; i += 4) {
        const p = fields[i];
        if (p) out.add(path.basename(p));
      }
    } catch {
    }
    return out;
  }

  app.get("/api/agents/:id/tree", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const rel = c.req.query("path") || ".";
    let abs: string;
    try {
      abs = safeJoin(a.workspace, rel);
    } catch (err) {
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
    const ignoredNames = await checkIgnoredBatch(abs, dirents);
    for (const d of dirents) {
      if (d.name.startsWith(".") && !(showHidden && d.name !== "." && d.name !== ".."))
        continue; 
      const forceIgnored = !d.isDirectory() ? false : d.name === ".git";
      const isDir = d.isDirectory();
      let size: number | undefined;
      if (!isDir) {
        try {
          size = (await fs.stat(path.join(abs, d.name))).size;
        } catch {
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
      return c.body(
        new Uint8Array(buf),
        200,
        {
          "content-type": mimeFor(rel, kind),
          "cache-control": "no-store",
          "content-disposition": `inline; filename="${encodeURIComponent(path.basename(rel))}"`,
        },
      );
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

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
      if (existing && existing.subarray(0, 8192).includes(0))
        return c.json({ error: "binary file — edit refused" }, 400);
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

  app.get("/api/config", (c) => {
    const maskKey = (k: string | undefined) => (k ? "•••" + String(k).slice(-4) : undefined);
    const mask = (
      p: Record<string, { baseUrl: string; apiKey?: string; apiKeys?: string[]; model?: string }> | undefined,
    ) =>
      Object.fromEntries(
        Object.entries(p ?? {}).map(([k, v]) => [
          k,
          {
            ...v,
            apiKey: maskKey(v.apiKey),
            ...(Array.isArray(v.apiKeys) ? { apiKeys: v.apiKeys.map(maskKey) } : {}),
          },
        ]),
      );
    return c.json({
      configPath: master.configPath,
      needsSetup: Object.keys(master.config.providers ?? {}).length === 0,
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
      mcpServers: master.config.mcpServers ?? [],
      agents: master.config.agents.map((a) => ({ id: a.id, workspace: a.workspace, provider: a.provider, model: a.model })),
      version: master.getVersion(),
    });
  });

  app.put("/api/config", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    const parsed = ConfigPatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: formatZodError(parsed.error) }, 400);
    const patch = parsed.data;
    try {
      for (const t of patch.tasks ?? []) parseSchedule(t.schedule);
      const prev = master.config.providers ?? {};
      const providers: Record<string, ProviderConfig> = {};
      for (const [name, p] of Object.entries(patch.providers ?? {})) {
        const stored = prev[name]?.apiKeys ?? (prev[name]?.apiKey ? [prev[name].apiKey] : []);
        const resolve = (k: string | undefined, i: number) => {
          if (!k || k.startsWith("•••")) return stored[i];
          return k;
        };
        const incoming = Array.isArray(p.apiKeys) && p.apiKeys.length ? p.apiKeys : undefined;
        const keys = incoming
          ? incoming.map((k, i) => resolve(k, i)).filter((k): k is string => !!k)
          : [];
        const single = !incoming
          ? !p.apiKey || p.apiKey.startsWith("•••")
            ? stored[0]
            : p.apiKey
          : keys[0];
        providers[name] = {
          baseUrl: p.baseUrl ?? "",
          ...(single ? { apiKey: single } : {}),
          ...(keys.length ? { apiKeys: keys } : {}),
          ...(p.model ? { model: p.model } : {}),
        };
      }
      master.updateConfig({
        providers,
        defaultProvider: patch.defaultProvider,
        progressIntervalMs: patch.progressIntervalMs,
        progressMinChars: patch.progressMinChars,
        contextTokenBudget: patch.contextTokenBudget,
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
      if (patch.mcpServers) {
        mcp.apply(patch.mcpServers);
        void mcp.connectAll();
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

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

  app.post("/api/mcp/oauth/start", async (c) => {
    const body = await c.req
      .json<{ name?: string; scopes?: string[]; url?: string; transport?: McpServerConfig["transport"] }>()
      .catch(() => null);
    if (!body?.name) return c.json({ error: "missing name" }, 400);
    const saved = (master.config.mcpServers ?? []).find((m) => m.name === body.name);
    const targetUrl = String(body.url ?? saved?.url ?? "").trim();
    if (!targetUrl)
      return c.json({ error: "this server has no url — OAuth needs an http(s) endpoint" }, 400);
    try {
      mcp.registerUnsaved({ name: body.name, url: targetUrl, transport: body.transport ?? "http", enabled: true });
      const { url } = await mcp.startOAuth(body.name, {
        ...(body.scopes?.length ? { scopes: body.scopes } : {}),
      });
      const st = mcp.oauthStatus(body.name);
      if (!url && st.authorized)
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
      {
        const { tools } = await mcp.testConfig(body as McpServerConfig);
        mcp.recordSuccess(body.name, tools);
        return c.json({
          ok: true,
          tools: tools.map((t) => ({ name: t.name, description: t.description })),
        });
      }
    } catch (err) {
      const message = (err as Error).message;
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
      .json<{ text?: string; start?: boolean; source?: "user" | "harness"; images?: { url: string; name?: string }[] }>()
      .catch(() => null); 
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    if (!body.text?.trim() && !body.images?.length)
      return c.json({ error: "text or images required" }, 400);
    const images = (body.images ?? []).filter((im) => {
      const u = String(im?.url ?? "");
      if (u.startsWith("data:image/")) return u.length < 12_000_000; 
      return /^https?:\/\//.test(u);
    });
    const text = body.text ?? "";
    const src = body.source === "harness" ? "harness" : "user";
    const promptId = a.enqueuePrompt(text || "(see attached image)", src, images.length ? images : undefined);
    if (body.start !== false && a.status !== "running") a.start("prompt");
    return c.json({ ok: true, promptId, queued: a.snapshot().pendingPrompts });
  });

  app.post("/api/agents/:id/prompt/cancel", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const body = await c.req.json<{ promptId?: string }>().catch(() => null); 
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

  app.post("/api/agents/:id/model", async (c) => {
    const body = await c.req
      .json<{
        provider?: string;
        model?: string;
        contextWindowTokens?: number;
        reasoningEffort?: string; 
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
      verify?: string; 
    }>()
      .catch(() => null); 
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    if (body.text) {
      await a.setGoal(body.text);
      if (typeof body.verify === "string" && body.verify.trim())
        await a.setGoalVerify(body.verify.trim());
      if (body.notify !== false) {
        a.enqueuePrompt(
          `[harness] The operator set a new goal:\n\n${body.text}\n\nAlign your work with it.`,
          "harness",
        );
        if (a.status !== "running") a.start("goal set");
      }
    } else if (body.status) await a.setGoalStatus(body.status);
    else return c.json({ error: "text or status required" }, 400);
    return c.json({ ok: true });
  });

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

  app.get("/api/agents/:id/skills/:name", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const want = c.req.param("name");
    try {
      const list = await currentSkills(a.toolCtx);
      const def = list.find((s) => s.name === want);
      if (!def) return c.json({ error: `no skill named ${want}` }, 404);
      const text = await readSkillFile(def);
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

  app.post("/api/agents/:id/compact", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    try {
      return c.json({ ok: true, ...(await a.compactNow()) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

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

  app.get("/api/personas", (c) =>
    c.json({
      personas: Object.entries(SUB_PERSONAS).map(([key, p]) => ({ key, label: p.label, directive: p.directive })),
    }),
  );

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

  app.post("/api/agents/:id/todo", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const body = await c.req.json<{ text?: string; notify?: boolean }>().catch(() => null);
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    await a.setTodo(body.text ?? "");
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

  app.post("/api/agents/:id/edit-prompt", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const body = await c.req
      .json<{ eventId?: string; text?: string }>()
      .catch(() => null);
    if (!body?.eventId || !body.text?.trim())
      return c.json({ error: "eventId and text required" }, 400);
    try {
      // a `tail` in the body is ignored on purpose: the events after the edit are discarded, so an
      // older client still sending `tail: "summarize"` gets the fast path rather than an error
      const r = await a.editPromptAt(body.eventId, body.text);
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
    if (!a) {
      const why = master.unavailableAgents.get(c.req.param("id"));
      if (why) {
        const sessionQ = c.req.query("session");
        const dir = sessionQ ?? master.sessionsOf(c.req.param("id"))[0]?.id;
        const file = dir ? path.join(master.sessionsRoot(), dir, "chat.jsonl") : null;
        if (file) {
          const limit = Math.min(Number(c.req.query("limit") ?? 2000), 20000);
          const tail = await readEventsTail(file, limit);
          return c.json({
            events: tail.events,
            total: tail.total,
            partial: tail.truncated,
            unavailable: why,
          });
        }
      }
      return notFound(c, "agent", c.req.param("id"));
    }
    const limit = Math.min(Number(c.req.query("limit") ?? 2000), 20000);
    let filePath = a.log.filePath;
    const sessionId = c.req.query("session");
    if (sessionId) {
      const rec = master.sessionById(sessionId);
      if (!rec || rec.agentId !== c.req.param("id"))
        return notFound(c, "session (or it belongs to another agent)", sessionId);
      filePath = path.join(rec.dir, "chat.jsonl");
    }
    const branch = c.req.query("branch");
    const before = c.req.query("before");
    const after = c.req.query("after");
    if (after && !before && !branch) {
      const all = await readEventsCached(filePath);
      const idx = all.findIndex((e) => e.id === after);
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
    if (before) {
      const idx = events.findIndex((e) => e.id === before);
      events = idx === -1 ? [] : events.slice(0, idx);
      return c.json({ events: events.slice(-limit), total: events.length });
    }
    return c.json({ events: events.slice(-limit), total: events.length });
  });

  app.get("/api/sessions", (c) => c.json({ sessions: master.allSessions() }));

  app.get("/api/agents/:id/sessions", (c) => {
    const id = c.req.param("id");
    const known = master.agents.has(id) || master.config.agents.some((a) => a.id === id);
    const owned = master.sessionsOf(id);
    if (!known && owned.length === 0) return notFound(c, "agent", id);
    return c.json({ sessions: owned });
  });

  app.get("/api/agents/:id/branches", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return notFound(c, "agent", c.req.param("id"));
    const events = await readEventsCached(a.log.filePath);
    const branches = new Map<string, { branch: string; events: number; forkedFrom?: unknown }>();
    for (const e of events) {
      const b = branches.get(e.branch) ?? { branch: e.branch, events: 0 };
      b.events++;
      branches.set(e.branch, b);
      if (e.type === "fork") {
        const created = String((e.data as { newBranch?: string } | undefined)?.newBranch ?? "");
        if (created && created !== e.branch) {
          const nb = branches.get(created) ?? { branch: created, events: 0 };
          nb.forkedFrom = e.data;
          branches.set(created, nb);
          b.events--; 
          if (b.events <= 0) branches.delete(e.branch);
        } else {
          b.forkedFrom = e.data;
        }
      }
    }
    return c.json({ branches: [...branches.values()] });
  });

  app.get("/api/metrics", (c) => c.json(master.metrics()));

  const notFound = (c: Context, what: string, id: string) =>
    c.json({ error: `${what} not found: ${id || "(no id given)"}` }, 404);

  app.get("/api/version", (c) =>
    c.json({ version: master.getVersion(), uptimeSeconds: Math.round(process.uptime()) }),
  );

  app.post("/api/update/restart", (c) => {
    setImmediate(() => {
      void master.restartServer().catch((err) => {
        console.error("[teapot] live update failed:", (err as Error).message);
      });
    });
    return c.json({ ok: true, restarting: true });
  });

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
            cleanup();
          }
        };
        send({ kind: "hello", agents: [...master.agents.values()].map((a) => a.snapshot()) });
        const onUpdate = (ev: unknown) => send(ev);
        bus.on("update", onUpdate);
        const ka = setInterval(() => send({ kind: "ping" }), 30_000);
        c.req.raw.signal.addEventListener("abort", cleanup);
      },
      cancel() {
      },
    });
    return c.body(stream);
  });

  app.on(["GET", "POST", "BREW"], "/brew", (c) =>
    c.text("418 I'm a teapot \u{1FAD6}", 418),
  );
  app.on(["GET", "POST", "BREW"], "/brew/coffee", (c) =>
    c.text("418 I'm a teapot — coffee not supported (see RFC 2324 §2.3.2)", 418),
  );

  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");

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
  let shellEtag: string | null | undefined;
  const shellTag = (html: string): string => {
    if (shellEtag === undefined || shellEtag === null)
      shellEtag = `"${createHash("sha256").update(html).digest("base64url").slice(0, 27)}"`;
    return shellEtag;
  };
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
  app.get("/session/*", (c) => {
    return serveShell(c as never);
  });
  app.get("/assets/*", (c) => {
    const rel = c.req.path.replace("/assets/", "");
    const file = path.resolve(webRoot, "assets", path.basename(rel)); 
    try {
      return c.body(readFileSync(file), 200, {
        "content-type": mime[path.extname(file)] ?? "application/octet-stream",
        "cache-control": ASSET_CACHE,
      });
    } catch {
      return c.notFound();
    }
  });

  const assetsDir = path.join(master.config.dataDir, "assets");
  const assetName = (raw: string): string | null => {
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

  const ALLOWED_WIDTHS = [640, 1280, 1920, 2560, 3840] as const;
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
      return c.json({ error: `unsupported width ${rawW}` }, 400);
    }

    try {
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
      }
      const buf = await fs.readFile(src);
      return c.body(buf, 200, {
        "content-type": mime,
        "cache-control": "public, max-age=31536000, immutable",
      });
    } catch {
      return c.notFound();
    }
  });

  let imageToolsProbe: Promise<string | null> | null = null;
  const imageToolName = () => {
    imageToolsProbe ??= detectImageTools()
      .then((r) => r.tool?.name ?? null)
      .catch(() => null);
    return imageToolsProbe;
  };

  app.post("/api/assets", async (c) => {
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = Object.entries(assetMime).find(([, m]) => m === type)?.[0];
    if (!ext) {
      return c.json({ error: `unsupported image type: ${type || "(none)"}` }, 415);
    }
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (!buf.length) return c.json({ error: "empty body" }, 400);
    const MAX_UPLOAD = 64 * 1024 * 1024;
    if (buf.length > MAX_UPLOAD) {
      return c.json({ error: `image is larger than ${MAX_UPLOAD / 1024 / 1024}MB` }, 413);
    }
    await fs.mkdir(assetsDir, { recursive: true });
    const name = `${crypto.randomUUID().replace(/-/g, "")}.${ext}`;
    const dest = path.join(assetsDir, name);
    await fs.writeFile(dest, buf);
    return c.json({
      name,
      url: `/api/assets/${name}`,
      bytes: buf.length,
    });
  });

  app.get("/api/features", async (c) => {
    const [image, script] = await Promise.all([
      detectImageTools().catch(() => ({ tool: null, found: [] })),
      Promise.resolve({ present: process.platform !== "win32" && existsSync("/usr/bin/script") }),
    ]);
    return c.json({
      imageResize: {
        available: !!image.tool,
        tool: image.tool?.name ?? null,
        found: image.found,
        maxEdge: MAX_EDGE,
      },
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

export function dualStackHost(host: string | undefined): string | undefined {
  return host === "0.0.0.0" || host === "::" ? undefined : host;
}

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
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 2_000);
      });
    },
  };
}
