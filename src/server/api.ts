/**
 * REST + SSE API on Hono, plus static file serving for the web UI.
 */
import { Hono } from "hono";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { readFileSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSchedule } from "../scheduler/cron.ts";
import type { ProviderConfig } from "../master.ts";
import path from "node:path";
import { bus } from "../bus.ts";
import { readEvents } from "../log/events.ts";
import type { Master } from "../master.ts";

export function buildApp(master: Master): Hono {
  const app = new Hono();

  // Optional bearer auth for LAN exposure — set TEAPOT_API_TOKEN to enable.
  // WebSocket handshakes can't send headers, so they accept ?token= instead.
  const apiToken = process.env.TEAPOT_API_TOKEN || "";
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
          onUpdate = (ev) => send(ev);
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
          if (cur >= 2) {
            send({ kind: "exit", error: "too many terminals for this agent (max 2)" });
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
    const id = (body.id?.trim() || path.basename(ws)).replace(/[^\w.-]/g, "-").slice(0, 40);
    try {
      const agent = await master.addAgent(
        { id, workspace: ws, provider: body.provider, model: body.model },
        { persist: true, fresh: true }, // new incarnation → never reuse old history
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
    const body = await c.req.json<{ text?: string; start?: boolean }>();
    if (!body.text?.trim()) return c.json({ error: "text required" }, 400);
    // returns immediately: the prompt is logged + broadcast now, delivered to
    // the model at the next turn boundary (never blocks on a running agent)
    a.enqueuePrompt(body.text, "user");
    if (body.start !== false && a.status !== "running") a.start("prompt");
    return c.json({ ok: true, queued: a.snapshot().pendingPrompts });
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
      const res = await fetch(`${prov.baseUrl.replace(/\/+$/, "")}/models`, {
        headers: prov.apiKey ? { authorization: `Bearer ${prov.apiKey}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return c.json({ error: `upstream ${res.status}` }, 502);
      const j = (await res.json()) as { data?: { id?: string }[] };
      const models = (j.data ?? []).map((m) => m.id).filter((x): x is string => !!x).sort();
      return c.json({ provider: provName, models });
    } catch (err) {
      return c.json({ error: `model list failed: ${(err as Error).message}` }, 502);
    }
  });

  // switch a running session's model/provider
  app.post("/api/agents/:id/model", async (c) => {
    const body = await c.req.json<{ provider?: string; model?: string }>().catch(() => null);
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    try {
      const r = master.setAgentModel(c.req.param("id"), body.provider, body.model);
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
    const body = await c.req.json<{ text?: string; status?: "active" | "done" | "paused"; notify?: boolean }>();
    if (body.text) {
      await a.setGoal(body.text);
      // goals live behind get_goal(), so a silent save would go unnoticed —
      // queue a harness prompt unless the caller explicitly declines
      if (body.notify !== false)
        a.enqueuePrompt(
          `[harness] The operator set a new goal:\n\n${body.text}\n\nAlign your work with it.`,
          "harness",
        );
    } else if (body.status) await a.setGoalStatus(body.status);
    else return c.json({ error: "text or status required" }, 400);
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

export function serveApp(app: Hono, port: number): void {
  const wss = new WebSocketServer({ noServer: true });
  serve({ fetch: app.fetch, port, websocket: { server: wss } }, (info) => {
    console.log(`[teapot] master listening on http://localhost:${info.port}`);
  });
}
