/**
 * REST + SSE API on Hono, plus static file serving for the web UI.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { bus } from "../bus.js";
import { readEvents } from "../log/events.js";
import type { Master } from "../master.js";

export function buildApp(master: Master): Hono {
  const app = new Hono();

  // ---- agents ----
  app.get("/api/agents", (c) => c.json({ agents: [...master.agents.values()].map((a) => a.snapshot()) }));

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

  // ---- web ui (static, no bundler needed) ----
  const webRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    import.meta.url.includes("/dist/") ? "../web" : "../../src/web",
  );

  const mime: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
  };
  for (const file of ["index.html", "app.js", "style.css", "md.js"]) {
    const url = file === "index.html" ? "/" : `/${file}`;
    app.get(url, (c) => {
      try {
        const ext = path.extname(file);
        return c.body(readFileSync(path.join(webRoot, file), "utf8"), 200, {
          "content-type": mime[ext] ?? "text/plain",
        });
      } catch {
        return c.text(`web UI missing (${file})`, 404);
      }
    });
  }

  return app;
}

export function serveApp(app: Hono, port: number): void {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[teapot] master listening on http://localhost:${info.port}`);
  });
}
