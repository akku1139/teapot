/**
 * #125 — "can an agent receive image files, as vision input, off the filesystem?
 * I think it was implemented, but how is it?"
 *
 * Answer, measured rather than recalled: **half of it.**
 *
 *   operator → agent : YES, already implemented
 *   agent  → an image : NO
 *
 * ## What exists
 *
 * The composer accepts a paste or a 📎 attach, and
 * `POST /api/agents/:id/prompt` takes `images: [{url, name}]`. The prompt queue
 * turns them into OpenAI content parts, text first (see
 * `test/agent.test.ts` "image attachments flow into multimodal content parts and
 * survive replay", which drives the real loop).
 *
 * ## What does not
 *
 * **A filesystem path is silently DROPPED.** The `/prompt` image filter keeps
 * only `data:image/…` under ~9MB and `http(s)://`; anything else — including a
 * path and a `file://` URL — is filtered out with no error, so the prompt is sent
 * as text alone and the operator is told nothing.
 *
 * And `read_file` is text-only, so an AGENT cannot look at an image in its own
 * workspace at all. It can `ls` one, and that is the end of it.
 *
 * This file drives the REAL route: the filter is a behaviour of `POST
 * /prompt`, so it is observed by the prompt that reaches the agent, not by
 * matching the source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };
const JSON_HEADERS = { "content-type": "application/json" };

/** a real Master + app + one agent; returns a poster and the agent's prompts */
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
  // the gap the question is really about: an image sitting in the workspace
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
    // the route passes `undefined` rather than an empty list when nothing survives
    assert.deepEqual(
      prompts()[0]!.images ?? [],
      [],
      "every path-shaped image is filtered out, so an agent cannot be shown a file on disk (#125)",
    );
    assert.equal(prompts()[0]!.text, "look at this", "and only the text is delivered (#125)");
  });
});

test("the drop is silent — the operator is told nothing (#125)", async () => {
  // the worse half: the prompt is delivered as text alone with no indication
  await withAgent(async (post) => {
    const r = await post({ text: "look", images: [{ url: "/workspace/shot.png" }] });
    assert.equal(r.status, 200, "a dropped image must not be an error (#125)");
    const body = (await r.json()) as { ok?: boolean; error?: string };
    assert.equal(body.ok, true);
    assert.equal(body.error, undefined, `no warning is returned for a discarded image (#125); got ${body.error}`);
  });
});

/*
 * "no tool returns image BYTES" has no cheap behavioural assertion: `read_file`
 * reads whatever bytes are in the file and returns them as text, which is not a
 * refusal this test could pin, and the absence of an `image_url` part in the
 * tool layer is not observable from the tool's result.
 */
