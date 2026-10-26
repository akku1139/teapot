/**
 * BEHAVIOURAL tests for the API surface, replacing shape-only assertions.
 *
 * #110 shipped `test/api-malformed-json.test.ts`, which asserts that the SOURCE
 * contains `if (!body) return c.json({ error: "invalid JSON" }, 400);`. One of its
 * tests is even named "the behaviour itself" — and it never issues a request.
 *
 * That is the #75 failure mode exactly: the mechanics of the implementation are
 * verified, the rule is not. Proven by mutation, with a clean build:
 *
 *   `if (!body) return c.json({ error: "invalid JSON" }, 400)` → 200
 *     1127 pass, 0 fail        <- an unparseable body is ACCEPTED, unobserved
 *
 *   `if (!body.text?.trim() && !body.images?.length)` → unreachable
 *     1127 pass, 0 fail        <- an empty prompt is ACCEPTED, unobserved
 *
 *   `if (body.notify !== false)` → `if (true)`   (goal and todo routes)
 *     1127 pass, 0 fail        <- `notify: false` is ignored, unobserved
 *
 * Three real behaviours, no coverage. These tests make actual requests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function mkApp(dataDir: string) {
  // #126: NOT "/dev/null" — on Windows that resolves to D:\dev\null and is read
  const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
  return { app: buildApp(m), master: m };
}

const JSON_HEADERS = { "content-type": "application/json" };

/** POST a body that is deliberately not JSON */
const post = (app: ReturnType<typeof mkApp>["app"], url: string, raw: string) =>
  app.request(url, { method: "POST", headers: JSON_HEADERS, body: raw });

/* ---------- malformed bodies ---------- */

test("an unparseable body is a 400 with a message, not a 200 (#110)", async () => {
  await useTempDirs(["b110a-"], async ([dataDir]) => {
    const { app } = mkApp(dataDir!);
    const r = await post(app, "/api/agents", "{not json at all");
    assert.equal(r.status, 400, `an unparseable body must be rejected (#110); got ${r.status}`);
    const j = (await r.json()) as { error?: string };
    assert.equal(j.error, "invalid JSON", "and must say why (#110)");
  });
});

test("an unparseable body is rejected on every body-taking route (#110)", async () => {
  await useTempDirs(["b110b-", "b110w-"], async ([dataDir, ws]) => {
    const { app } = mkApp(dataDir!);
    const created = await app.request("/api/agents", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspace: ws, id: "a1", start: false }),
    });
    assert.equal(created.status, 200, "precondition: the agent exists (#110)");

    for (const url of [
      "/api/agents/a1/prompt",
      "/api/agents/a1/todo",
      "/api/agents/a1/goal",
      "/api/agents/a1/edit-prompt",
    ]) {
      const r = await post(app, url, "{broken");
      assert.equal(r.status, 400, `${url} must answer 400 on a malformed body (#110); got ${r.status}`);
    }
  });
});

/* ---------- field validation ---------- */

test("an empty prompt is rejected (#110)", async () => {
  await useTempDirs(["b110c-", "b110x-"], async ([dataDir, ws]) => {
    const { app } = mkApp(dataDir!);
    await app.request("/api/agents", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspace: ws, id: "a1", start: false }),
    });
    const r = await app.request("/api/agents/a1/prompt", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: "   " }),
    });
    assert.equal(r.status, 400, `whitespace-only text must be rejected (#110); got ${r.status}`);
    assert.match(String(((await r.json()) as { error: string }).error), /text or images/);
  });
});

test("a prompt with neither text nor images is rejected (#110)", async () => {
  await useTempDirs(["b110d-", "b110y-"], async ([dataDir, ws]) => {
    const { app } = mkApp(dataDir!);
    await app.request("/api/agents", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspace: ws, id: "a1", start: false }),
    });
    const r = await app.request("/api/agents/a1/prompt", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400, `an empty object must be rejected (#110); got ${r.status}`);
  });
});

test("an agent with no workspace is rejected (#110)", async () => {
  await useTempDirs(["b110e-"], async ([dataDir]) => {
    const { app } = mkApp(dataDir!);
    const r = await app.request("/api/agents", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: "nows" }),
    });
    assert.equal(r.status, 400, `a missing workspace must be rejected (#110); got ${r.status}`);
    assert.match(String(((await r.json()) as { error: string }).error), /workspace required/);
  });
});

test("an unknown agent is a 404 naming the id (#126)", async () => {
  await useTempDirs(["b110f-"], async ([dataDir]) => {
    const { app } = mkApp(dataDir!);
    const r = await app.request("/api/agents/nope/prompt", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(r.status, 404);
    // #126: the message must NAME what was missing and which id — 24 routes used
    // to answer a bare "not found"
    assert.match(String(((await r.json()) as { error: string }).error), /agent not found: nope/);
  });
});

/* ---------- notify:false, the flag nobody tested ---------- */

test("a goal save with notify:false queues NO harness prompt (#123)", async () => {
  await useTempDirs(["b110g-", "b110z-"], async ([dataDir, ws]) => {
    const { app, master } = mkApp(dataDir!);
    await app.request("/api/agents", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspace: ws, id: "a1", start: false }),
    });
    const agent = master.agents.get("a1")!;
    const prompts: string[] = [];
    const orig = agent.enqueuePrompt.bind(agent);
    agent.enqueuePrompt = (t: string, s?: string, i?: unknown) => {
      prompts.push(String(t));
      return orig(t, s, i as never);
    };

    const r = await app.request("/api/agents/a1/goal", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: "ship it", notify: false }),
    });
    assert.equal(r.status, 200, "precondition: the save succeeded");
    assert.deepEqual(
      prompts.filter((p) => p.includes("[harness]")),
      [],
      "notify:false must queue NOTHING — the operator declined the notification",
    );
    agent.stop("done");
  });
});

test("a goal save with notify:true DOES queue one (#123)", async () => {
  await useTempDirs(["b110h-", "b110w2-"], async ([dataDir, ws]) => {
    const { app, master } = mkApp(dataDir!);
    await app.request("/api/agents", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspace: ws, id: "a1", start: false }),
    });
    const agent = master.agents.get("a1")!;
    const prompts: string[] = [];
    const orig = agent.enqueuePrompt.bind(agent);
    agent.enqueuePrompt = (t: string, s?: string, i?: unknown) => {
      prompts.push(String(t));
      return orig(t, s, i as never);
    };

    await app.request("/api/agents/a1/goal", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: "ship it", notify: true }),
    });
    assert.equal(
      prompts.filter((p) => p.includes("[harness]")).length,
      1,
      "notify:true must queue exactly one harness prompt (#123)",
    );
    agent.stop("done");
  });
});

test("a todo save with notify:false queues NO harness prompt (#123)", async () => {
  await useTempDirs(["b110i-", "b110v-"], async ([dataDir, ws]) => {
    const { app, master } = mkApp(dataDir!);
    await app.request("/api/agents", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspace: ws, id: "a1", start: false }),
    });
    const agent = master.agents.get("a1")!;
    const prompts: string[] = [];
    const orig = agent.enqueuePrompt.bind(agent);
    agent.enqueuePrompt = (t: string, s?: string, i?: unknown) => {
      prompts.push(String(t));
      return orig(t, s, i as never);
    };

    await app.request("/api/agents/a1/todo", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: "- one", notify: false }),
    });
    assert.deepEqual(
      prompts.filter((p) => p.includes("[harness]")),
      [],
      "notify:false on a TODO save must queue nothing",
    );
    agent.stop("done");
  });
});

test("an EMPTY todo with notify:true queues nothing (#123)", async () => {
  await useTempDirs(["b110j-", "b110u-"], async ([dataDir, ws]) => {
    const { app, master } = mkApp(dataDir!);
    await app.request("/api/agents", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspace: ws, id: "a1", start: false }),
    });
    const agent = master.agents.get("a1")!;
    const prompts: string[] = [];
    const orig = agent.enqueuePrompt.bind(agent);
    agent.enqueuePrompt = (t: string, s?: string, i?: unknown) => {
      prompts.push(String(t));
      return orig(t, s, i as never);
    };

    await app.request("/api/agents/a1/todo", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text: "   " }), // notify defaults to TRUE
    });
    assert.deepEqual(
      prompts.filter((p) => p.includes("[harness]")),
      [],
      "clearing the list must not nag the agent with an empty task list",
    );
    agent.stop("done");
  });
});