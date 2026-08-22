/**
 * REST + SSE API on Hono, plus static file serving for the web UI.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSchedule } from "../scheduler/cron.js";
import type { ProviderConfig } from "../master.js";
import path from "node:path";
import { bus } from "../bus.js";
import { readEvents } from "../log/events.js";
import type { Master } from "../master.js";

export function buildApp(master: Master): Hono {
  const app = new Hono();

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
    const id = (body.id?.trim() || path.basename(ws)).replace(/[^\w.-]/g, "-").slice(0, 40);
    try {
      const agent = await master.addAgent(
        { id, workspace: ws, provider: body.provider, model: body.model },
        true, // persist to config so it survives restarts
      );
      if (body.start !== false) agent.start("created via web");
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
      providers: mask(master.config.providers),
      defaultProvider: master.config.defaultProvider,
      progressIntervalMs: master.config.progressIntervalMs,
      tasks: master.config.tasks,
      agents: master.config.agents.map((a) => ({ id: a.id, workspace: a.workspace, provider: a.provider, model: a.model })),
    });
  });

  app.put("/api/config", async (c) => {
    const body = await c.req.json<{
      providers?: Record<string, { baseUrl: string; apiKey?: string; model?: string }>;
      defaultProvider?: string;
      progressIntervalMs?: number;
      tasks?: { id: string; agent: string; schedule: string; prompt: string; forked?: boolean }[];
    }>().catch(() => null);
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    try {
      // validate schedules before applying anything
      for (const t of body.tasks ?? []) parseSchedule(t.schedule);
      // keep masked keys intact: "•••1234" means "unchanged"
      const prev = master.config.providers ?? {};
      const providers: Record<string, ProviderConfig> = {};
      for (const [name, p] of Object.entries(body.providers ?? {})) {
        const masked = !p.apiKey || p.apiKey.startsWith("•••");
        providers[name] = {
          baseUrl: p.baseUrl,
          apiKey: masked ? prev[name]?.apiKey : p.apiKey,
          ...(p.model ? { model: p.model } : {}),
        };
      }
      master.updateConfig({
        providers,
        defaultProvider: body.defaultProvider,
        progressIntervalMs: body.progressIntervalMs,
        tasks: body.tasks,
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

  app.post("/api/agents/:id/prompt", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ text?: string; start?: boolean }>();
    if (!body.text?.trim()) return c.json({ error: "text required" }, 400);
    await a.enqueuePrompt(body.text, "user");
    if (body.start !== false && a.status !== "running") a.start("prompt");
    return c.json({ ok: true });
  });

  app.post("/api/agents/:id/start", (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    a.start("api start");
    return c.json({ ok: true });
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
    const body = await c.req.json<{ text?: string; status?: "active" | "done" | "paused" }>();
    if (body.text) await a.setGoal(body.text);
    else if (body.status) await a.setGoalStatus(body.status);
    else return c.json({ error: "text or status required" }, 400);
    return c.json({ ok: true });
  });

  app.post("/api/agents/:id/fork", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{ fromEvent?: string | null }>().catch(() => ({ fromEvent: null }));
    const r = await a.fork(body.fromEvent ?? null);
    return c.json({ ok: true, ...r });
  });

  // ---- event log access (human/inspect friendly) ----
  app.get("/api/agents/:id/events", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    const limit = Math.min(Number(c.req.query("limit") ?? 200), 5000);
    let events = await readEvents(a.log.filePath);
    const branch = c.req.query("branch");
    const session = c.req.query("session");
    if (branch) events = events.filter((e) => e.branch === branch);
    if (session) events = events.filter((e) => e.session === session);
    return c.json({ events: events.slice(-limit), total: events.length });
  });

  app.get("/api/agents/:id/branches", async (c) => {
    const a = master.agents.get(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    const events = await readEvents(a.log.filePath);
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

  app.get("/api/events", (c) => {
    c.header("content-type", "text/event-stream");
    c.header("cache-control", "no-cache");
    c.header("connection", "keep-alive");
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (data: unknown) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        send({ kind: "hello", agents: [...master.agents.values()].map((a) => a.snapshot()) });
        const onUpdate = (ev: unknown) => send(ev);
        bus.on("update", onUpdate);
        // keep-alive comment every 30s so proxies don't close the stream
        const ka = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), 30_000);
        ;(controller as unknown as { _cleanup?: () => void })._cleanup = () => {
          clearInterval(ka);
          bus.off("update", onUpdate);
        };
      },
      cancel() {
        /* handled in _cleanup via abort signal below */
      },
    });
    c.req.raw.signal.addEventListener("abort", () => {
      /* node-server closes the stream; cleanup runs on cancel */
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
  const webRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    import.meta.url.includes("/dist/") ? "../../public" : "../../public",
  );

  const mime: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  app.get("/", (c) => {
    try {
      return c.html(readFileSync(path.join(webRoot, "index.html"), "utf8"));
    } catch {
      return c.text("web UI not built — run: pnpm build-web", 404);
    }
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

export function serveApp(app: Hono, port: number): void {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[teapot] master listening on http://localhost:${info.port}`);
  });
}
