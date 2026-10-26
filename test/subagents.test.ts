import { test } from "node:test";
import assert from "node:assert/strict";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import { executeTool, type ToolContext } from "../src/agent/tools.ts";
import type { LlmResult } from "../src/agent/llm.ts";
import { useTempDir, useTempDirs } from "./helpers/tmp.ts";
import { dataOf } from "./helpers/event-data.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("runs POSIX commands through the bash tool; POSIX filesystem paths");

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function mkMaster(dataDir: string): Master {
  return new Master(
    {
      port: 0,
      dataDir,
      llm: LLM,
      providers: {},
      agents: [],
    },
    "/dev/null",
  );
}

async function disposeAll(m: Master): Promise<void> {
  await Promise.allSettled([...m.agents.values()].map((a) => a.dispose()));
}

test("spawn depth is capped by config.maxSpawnDepth", async () => {
  await useTempDirs(["depth-root-", "sub-ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    (m as unknown as { config: { maxSpawnDepth: number } }).config.maxSpawnDepth = 1;

    const parent = await m.addAgent({ id: "root", workspace: ws });
    const { id } = await (
      m as unknown as { spawnChildFor(a: unknown, o: unknown): Promise<{ id: string }> }
    ).spawnChildFor(parent, { task: "child task", context: "none" });
    assert.match(id, /^root-sub/);

    const child = m.agents.get(id)!;
    const ctx = (child as unknown as { toolCtx: { subAgents?: unknown } }).toolCtx;
    assert.equal(ctx.subAgents, undefined, "depth-capped agents must not get spawn hooks");

    const r = await m.stopChildrenFor("root");
    assert.deepEqual(r.stopped, [id]);
    await disposeAll(m);
  });
});

test("read-only personas refuse mutating tools", async () => {
  await useTempDir("sub-ws-", async (cwd) => {
    const ctx: ToolContext = {
      cwd,
      defaultTimeoutMs: 5_000,
      maxOutputBytes: 10_000,
      readOnly: true,
    };
    for (const tool of ["write_file", "edit_file", "apply_patch", "bash"]) {
      const args =
        tool === "apply_patch"
          ? { patch: "*** Begin Patch\n*** End Patch" }
          : { path: "x.txt", command: "echo hi", old_text: "a", new_text: "b" };
      const r = await executeTool(tool, JSON.stringify(args), ctx);
      assert.equal(r.ok, false, `${tool} must be blocked`);
      assert.match(r.result, /read-only/);
    }
    const r = await executeTool("list_dir", JSON.stringify({ path: "." }), ctx);
    assert.equal(r.ok, true);
  });
});

test("PUT /api/config rejects malformed patches with actionable errors", async () => {
  await useTempDir("cfg-root-", async (dataDir) => {
    const app = buildApp(mkMaster(dataDir));
    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providers: { "": { baseUrl: "not-a-url" } },
        progressIntervalMs: 5,
        tasks: [{ id: "", agent: "", schedule: "x", prompt: "" }],
      }),
    });
    assert.equal(res.status, 400);
    const j = (await res.json()) as { error: string };
    assert.match(j.error, /provider name required|progress interval|schedule required/);

    const ok = await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxSpawnDepth: 2, progressIntervalMs: 60_000 }),
    });
    assert.equal(ok.status, 200);
  });
});

test("waitChildren returns as soon as ALL listed children settle — not at timeout", async () => {
  await useTempDirs(["wait-root-", "sub-ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const parent = await m.addAgent({ id: "p", workspace: ws });

    const spawn = m as unknown as {
      spawnChildFor(a: unknown, o: unknown): Promise<{ id: string }>;
    };
    const a = await (await spawn.spawnChildFor(parent, { task: "task a", context: "none" })).id;
    const b = await (await spawn.spawnChildFor(parent, { task: "task b", context: "none" })).id;

    const wait = m.waitChildren("p", undefined, 60_000);
    await new Promise((r) => setTimeout(r, 50)); 

    await m.agents.get(a)!.stop("test");
    let settled = false;
    void wait.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(settled, false, "must stay parked while any target is still active");

    await m.agents.get(b)!.stop("test");
    const r = await Promise.race([
      wait,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("did not wake on final settle")), 2_000)),
    ]);
    assert.match(r.note, /all sub-agents settled/);

    const again = await m.waitChildren("p", undefined, 60_000);
    assert.match(again.note, /already settled/);

    await disposeAll(m);
  });
});

test("sub-agent finish forwards the summary PLUS recent conversation context", async () => {
  await useTempDirs(["fin-root-", "fin-ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const parent = await m.addAgent({ id: "p", workspace: ws });
    let child: string;
    {
      const spawn = m as unknown as {
        spawnChildFor(a: unknown, o: unknown): Promise<{ id: string }>;
      };
      child = (await spawn.spawnChildFor(parent, { task: "review things", context: "none" })).id;
      await m.agents.get(child)!.stop("installing mock");
    }
    const cAgent = m.agents.get(child)!;
    let n = 0;
    (cAgent as unknown as { opts: { chatFn?: unknown } }).opts.chatFn = async () => {
      n++;
      if (n === 1)
        return {
          message: {
            role: "assistant",
            content:
              "DETAILED FINDINGS: file src/auth.ts line 42 uses unsalted hash; config/default.json leaks the staging DSN; retry budget is 3 not 5 as documented.",
          },
        };
      return {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "f1",
              type: "function" as const,
              function: {
                name: "finish",
                arguments: JSON.stringify({ goalComplete: true, summary: "review done, see above" }),
              },
            },
          ],
        },
      };
    };
    await cAgent.setGoal("review");
    cAgent.enqueuePrompt("go");
    if (cAgent.status !== "running") cAgent.start("t");

    const { readEvents } = await import("../src/log/events.ts");
    const pAgent = m.agents.get("p")!;
    const deadline = Date.now() + 45_000;
    let reportText = "";
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const events = await readEvents(pAgent.log.filePath);
        const found = events.find(
          (e: any) => e.type === "prompt" && /finished\. Final report/.test(String(dataOf(e).text ?? "")),
        );
        if (found) {
          reportText = String(dataOf(found).text);
          break;
        }
      } catch (err) {
        lastErr = String((err as Error).message);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(reportText, "parent must receive the finish report");
    assert.match(reportText, /review done, see above/); 
    assert.match(reportText, /DETAILED FINDINGS/); 
    assert.match(reportText, /unsalted hash/);
    await disposeAll(m);
  });
});

test("a sub-agent can message its own child, but not a grandchild (#11)", async () => {
  await useTempDirs(["nest-root-", "nest-ws-"], async ([dataDir, ws]) => {
    const m = new Master(
      {
        port: 0,
        dataDir,
        llm: LLM,
        providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } },
        agents: [],
        maxSpawnDepth: 3,
      },
      "/dev/null",
    );
    (m as any).config.defaultProvider = "p";
    const chat = async (): Promise<LlmResult> => ({
      message: { role: "assistant", content: "ok" },
    });
    const root = await m.addAgent(
      { id: "root", workspace: ws, provider: "p", model: "m", chatFn: chat },
      { fresh: true, persist: false },
    );
    await root.load();
    const b = await m.spawnChildFor(root, { task: "B work", context: "none" });
    const childB = m.agents.get(b.id)!;
    const c = await m.spawnChildFor(childB, { task: "C work", context: "none" });
    const grandchild = m.agents.get(c.id)!;

    const msg = (m as any).messageChild.bind(m);

    const before = grandchild.snapshot().pendingPrompts;
    await msg(b.id, c.id, "hi from B");
    assert.equal(
      grandchild.snapshot().pendingPrompts,
      before + 1,
      "a parent messaging its own child must QUEUE the prompt (#11/#141)",
    );

    await msg("root", b.id, "hi from root");

    await assert.rejects(
      () => msg("root", c.id, "hi from root"),
      (err: Error) => {
        assert.match(err.message, /not your sub-agent/);
        assert.match(err.message, new RegExp(`its parent is @${b.id}`));
        assert.match(err.message, /message @/); 
        return true;
      },
    );

    await disposeAll(m);
  });
});

test("messaging an unknown id explains that no such sub-agent exists (#11)", async () => {
  await useTempDirs(["nx-root-", "nx-ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    (m as any).config.defaultProvider = "p";
    (m as any).config.providers.p = { baseUrl: "http://x", apiKey: "k", model: "m" };
    const root = await m.addAgent(
      { id: "root", workspace: ws, provider: "p", model: "m" },
      { fresh: true, persist: false },
    );
    await root.load();
    const msg = (m as any).messageChild.bind(m);
    await assert.rejects(
      () => msg("root", "ghost-agent", "hi"),
      (err: Error) => {
        assert.match(err.message, /not your sub-agent: ghost-agent/);
        assert.match(err.message, /no such sub-agent exists/);
        return true;
      },
    );
    await disposeAll(m);
  });
});

async function runChildEndingWith(
  m: Master,
  ws: string,
  turns: (n: number) => { message: any },
  timeoutMs = 45_000,
): Promise<string> {
  const parent = await m.addAgent({ id: "p", workspace: ws });
  const spawn = m as unknown as {
    spawnChildFor(a: unknown, o: unknown): Promise<{ id: string }>;
  };
  const child = (await spawn.spawnChildFor(parent, { task: "review things", context: "none" })).id;
  await m.agents.get(child)!.stop("installing mock");

  const cAgent = m.agents.get(child)!;
  let n = 0;
  (cAgent as unknown as { opts: { chatFn?: unknown; continueDelayMs?: number } }).opts.chatFn =
    async () => {
      n++;
      return turns(n);
    };
  (cAgent as unknown as { opts: { continueDelayMs?: number } }).opts.continueDelayMs = 10;
  await cAgent.setGoal("review");
  cAgent.enqueuePrompt("go");
  if (cAgent.status !== "running") cAgent.start("t");

  const { readEvents } = await import("../src/log/events.ts");
  const pAgent = m.agents.get("p")!;
  const deadline = Date.now() + timeoutMs;
  let report = "";
  while (Date.now() < deadline) {
    try {
      const events = await readEvents(pAgent.log.filePath);
      const found = events.find(
        (e: any) =>
          e.type === "prompt" && /finished\. Final report/.test(String(e.data?.text ?? "")),
      );
      if (found) {
        report = String(dataOf(found).text);
        break;
      }
    } catch {
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return report;
}

test("a sub-agent that ends with a plain message still reports to the parent (#42)", async () => {
  await useTempDirs(["f42a-", "f42b-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    try {
      const FINDINGS = "FINDINGS: src/auth.ts:42 unsalted hash; staging DSN leaks in config/default.json.";
      const report = await runChildEndingWith(m, ws, (n) =>
        n === 1
          ? { message: { role: "assistant", content: FINDINGS } }
          : { message: { role: "assistant", content: "" } },
      );
      assert.ok(report, "the parent MUST receive the report (#42)");
      assert.match(report, /finished\. Final report/);
      assert.match(report, /FINDINGS/, "the final message must reach the parent verbatim (#42)");
    } finally {
      await disposeAll(m);
    }
  });
});

test("a sub-agent's long final message is not truncated (#42)", async () => {
  await useTempDirs(["f42c-", "f42d-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    try {
      const filler = "x".repeat(4000);
      const tail = "THE_ACTUAL_CONCLUSION_AT_THE_END";
      const report = await runChildEndingWith(m, ws, (n) =>
        n === 1
          ? { message: { role: "assistant", content: `${filler}\n${tail}` } }
          : { message: { role: "assistant", content: "" } },
      );
      assert.ok(report, "parent must receive the report (#42)");
      assert.match(
        report,
        /THE_ACTUAL_CONCLUSION_AT_THE_END/,
        "the tail of a long report must survive (#42)",
      );
    } finally {
      await disposeAll(m);
    }
  });
});

test("a root agent is unaffected by the sub-agent harvest (#42)", async () => {
  await useTempDirs(["f42e-", "f42f-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    try {
      const a = await m.addAgent({ id: "solo", workspace: ws });
      let n = 0;
      (a as unknown as { opts: { chatFn?: unknown } }).opts.chatFn = async () => {
        n++;
        return { message: { role: "assistant", content: n === 1 ? "just talking" : "" } };
      };
      await a.setGoal("do a thing");
      a.enqueuePrompt("hi");
      a.start("t");
      for (let i = 0; i < 200 && a.status === "running"; i++)
        await new Promise((r) => setTimeout(r, 25));
      const { readEvents } = await import("../src/log/events.ts");
      const events = await readEvents(a.log.filePath);
      const finals = events.filter(
        (e: any) => e.type === "message" && e.data?.final === true,
      );
      assert.equal(
        finals.length,
        0,
        "a root agent must not synthesize a finish report (#42)",
      );
    } finally {
      await disposeAll(m);
    }
  });
});
