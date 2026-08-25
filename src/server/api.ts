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
import { SUB_PERSONAS } from "../master.ts";
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
import { readEvents } from "../log/events.ts";
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

  // Optional bearer auth for LAN exposure — TEAPOT_API_TOKEN env wins, else
  // the config's `password` field. Static files stay public; only /api/* is
  // gated. WebSocket handshakes can't send headers → they accept ?token=.
  const apiToken = process.env.TEAPOT_API_TOKEN || master.config.password || "";
  if (apiToken)
    app.use("/api/*", async (c, next) => {
      const h = c.req.header("authorization");
      const provided = h?.startsWith("Bearer ") ? h.slice(7) : undefined;
      const q = c.req.query("token");
      if ((provided && provided === apiToken) || (q && q === apiToken)) return next();
      return c.json({ error: "unauthorized" }, 401);
    });

  // per-agent terminal spawn guard
  const termCounts = new Map<string, number>();

  // ---- realtime events over WebSocket (replaces SSE for the web UI) ----
  app.get(
    "/api/ws",
    upgradeWebSocket(() => {
      let onUpdate: ((ev: unknown) => void) | null = null;
      let ka: ReturnType<typeof setInterval> | null = null;
      return {
        onOpen(_evt, ws) {
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
          // app-level liveness ping every 30s
          ka = setInterval(() => send({ kind: "ping" }), 30_000);
        },
        onMessage(evt, ws) {
          // clients may send {"kind":"ping"} — nothing else to do today
          try {
            const m = JSON.parse(String(evt.data));
            if (m?.kind === "ping") ws.send(JSON.stringify({ kind: "pong" }));
          } catch {
            /* ignore junk */
          }
        },
        onClose() {
          if (ka) clearInterval(ka);
          if (onUpdate) bus.off("update", onUpdate);
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
          if (!agent) {
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
          child.stdout?.on("data", (b: Buffer) => send({ kind: "data", data: b.toString("utf8") }));
          child.stderr?.on("data", (b: Buffer) => send({ kind: "data", data: b.toString("utf8") }));
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
            if (r > 0 && cl > 0)
              child.stdin.write(`stty rows ${r} cols ${cl} >/dev/null 2>&1\n`);
          }
        },
        onClose() {
          cleanup();
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
    const body = await c.req.json<{
      workspace?: string;
      id?: string;
      provider?: string;
      model?: string;
      start?: boolean;
    }>();
    if (!body.workspace?.trim()) return c.json({ error: "workspace required" }, 400);
    const ws = path.resolve(body.workspace.replace(/^~/, process.env.HOME ?? "~"));
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
    while (master.agents.has(id) || master.config.agents.some((a) => a.id === id))
      id = `${base.slice(0, 38)}-${n++}`;
    try {
      const agent = await master.addAgent(
        { id, workspace: ws, provider: body.provider, model: body.model },
        { persist: true, fresh: true }, // new incarnation → never reuse old history
      );
      // NOTE: creation no longer auto-starts an LLM loop — the agent sits in
      // "stopped" (a lazy, zero-cost session) until the operator sends the
      // first prompt or presses ▶ start. The web UI relies on this.
      if (body.start === true) agent.start("created via web");
      return c.json({ ok: true, agent: agent.snapshot() });
    } catch (err) {
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
    const body = await c.req.json<{ text?: string; start?: boolean; images?: { url: string; name?: string }[] }>();
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
    const body = await c.req.json<{ promptId?: string }>();
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
      .json<{ provider?: string; model?: string; contextWindowTokens?: number }>()
      .catch(() => null);
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    try {
      const r = await master.setAgentModel(c.req.param("id"), body.provider, body.model, body.contextWindowTokens);
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
    }>();
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
    const limit = Math.min(Number(c.req.query("limit") ?? 200), 5000);
    let events = await readEventsCached(a.log.filePath);
    const branch = c.req.query("branch");
    const session = c.req.query("session");
    if (branch) events = events.filter((e) => e.branch === branch);
    if (session) events = events.filter((e) => e.session === session);
    // cursor pagination for older pages: everything strictly BEFORE this id
    const before = c.req.query("before");
    if (before) {
      const idx = events.findIndex((e) => e.id === before);
      events = idx === -1 ? [] : events.slice(0, idx);
      return c.json({ events: events.slice(-limit), total: events.length });
    }
    return c.json({ events: events.slice(-limit), total: events.length });
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
      if (e.type === "fork") b.forkedFrom = e.data;
      branches.set(e.branch, b);
    }
    return c.json({ branches: [...branches.values()] });
  });

  // ---- metrics / SSE ----
  app.get("/api/metrics", (c) => c.json(master.metrics()));

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

export function serveApp(app: Hono, port: number, host?: string): void {
  const wss = new WebSocketServer({ noServer: true });
  serve({ fetch: app.fetch, port, hostname: host, websocket: { server: wss } }, (info) => {
    const shown = host && host !== "0.0.0.0" && host !== "::" ? `http://${host}:${info.port}` : `http://localhost:${info.port} (all interfaces)`;
    console.log(`[teapot] master listening on ${shown}`);
  });
}
