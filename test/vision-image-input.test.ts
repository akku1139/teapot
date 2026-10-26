import { test } from "node:test";
import assert from "node:assert/strict";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };
const JSON_HEADERS = { "content-type": "application/json" };

async function withAgent(
  fn: (
    post: (body: unknown) => Promise<Response> | Response,
    prompts: () => { text: string; images?: { url: string }[] }[],
  ) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempInRootSync("v125d-");
  const ws = mkdtempInRootSync("v125w-");
  const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, `${dataDir}/config.json`);
  const app = buildApp(m);
  const agent = await m.addAgent({ id: "a1", workspace: ws }, { persist: false });
  const seen: { text: string; images?: { url: string }[] }[] = [];
  const orig = agent.enqueuePrompt.bind(agent);
  agent.enqueuePrompt = (text: string, source?: string, images?: { url: string; name?: string }[]) => {
    seen.push({ text: String(text), images: images as { url: string }[] | undefined });
    return orig(text, source, images as never);
  };
  try {
    await fn(
      (body: unknown) =>
        app.request("/api/agents/a1/prompt", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        }),
      () => seen,
    );
  } finally {
    for (const a of [...m.agents.values()]) a.stop("done");
    for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
  }
}

test("a data: image URL reaches the agent (#125)", async () => {
  await withAgent(async (post, prompts) => {
    const r = await post({ text: "look", images: [{ url: "data:image/png;base64,AAAA", name: "a.png" }] });
    assert.equal(r.status, 200);
    assert.equal(prompts().length, 1, "precondition: the prompt was queued (#125)");
    assert.deepEqual(
      prompts()[0]!.images?.map((i) => i.url),
      ["data:image/png;base64,AAAA"],
      "a data: image must survive the filter (#125)",
    );
  });
});

test("an http(s) image URL reaches the agent (#125)", async () => {
  await withAgent(async (post, prompts) => {
    await post({ text: "look", images: [{ url: "https://example.com/x.png" }] });
    assert.deepEqual(prompts()[0]?.images?.map((i) => i.url), ["https://example.com/x.png"]);
  });
});

test("a FILESYSTEM PATH is silently dropped (#125)", async () => {
  await withAgent(async (post, prompts) => {
    const r = await post({
      text: "look at this",
      images: [
        { url: "/home/user/work/shot.png" },
        { url: "file:///home/user/work/shot.png" },
        { url: "./shot.png" },
      ],
    });
    assert.equal(r.status, 200, "the request still succeeds (#125)");
    assert.equal(prompts().length, 1, "precondition: the prompt was queued (#125)");
    assert.deepEqual(
      prompts()[0]!.images ?? [],
      [],
      "every path-shaped image is filtered out, so an agent cannot be shown a file on disk (#125)",
    );
    assert.equal(prompts()[0]!.text, "look at this", "and only the text is delivered (#125)");
  });
});

test("the drop is silent — the operator is told nothing (#125)", async () => {
  await withAgent(async (post) => {
    const r = await post({ text: "look", images: [{ url: "/workspace/shot.png" }] });
    assert.equal(r.status, 200, "a dropped image must not be an error (#125)");
    const body = (await r.json()) as { ok?: boolean; error?: string };
    assert.equal(body.ok, true);
    assert.equal(body.error, undefined, `no warning is returned for a discarded image (#125); got ${body.error}`);
  });
});

