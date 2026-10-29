import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

test("editing a provider's token reaches agents that are already running", async () => {
  /**
   * Rotating an API key in settings must take effect without restarting the server or the agent.
   *
   * A live agent keeps its own `opts.llm`, built from the provider at creation, so writing the new token into
   * `config.providers` alone changes nothing about what the next request sends — it keeps using the key it
   * was born with, and the failure the operator sees is a 401 from a token they just replaced.
   */
  await useTempDirs(["token-root-", "token-ws-"], async ([dataDir, ws]) => {
    const m = new Master(
      {
        port: 0,
        dataDir,
        llm: LLM,
        providers: { p: { baseUrl: "http://x", apiKey: "k-old", model: "m" } },
        defaultProvider: "p",
        agents: [],
      },
      path.join(dataDir, "teapot.config.json"),
    );
    try {
      const a = await m.addAgent({ id: "t", workspace: ws, provider: "p" });
      assert.equal(a.llm.apiKey, "k-old", "precondition: the agent starts on the configured token");

      m.updateConfig({ providers: { p: { baseUrl: "http://x", apiKey: "k-new", model: "m" } } });

      assert.equal(a.llm.apiKey, "k-new", "the running agent must pick up the new token");
      assert.equal(a.llm.model, "m", "and must keep its model");
    } finally {
      await Promise.allSettled([...m.agents.values()].map((x) => x.dispose()));
    }
  });
});

test("a provider edit reaches the default-provider agents, but never overrides an agent's own key", async () => {
  await useTempDirs(["token2-root-", "token2-ws-"], async ([dataDir, ws]) => {
    const m = new Master(
      {
        port: 0,
        dataDir,
        llm: LLM,
        providers: {
          p: { baseUrl: "http://p", apiKey: "p-old", model: "m" },
          q: { baseUrl: "http://q", apiKey: "q-key", model: "m" },
        },
        defaultProvider: "p",
        agents: [],
      },
      path.join(dataDir, "teapot.config.json"),
    );
    try {
      const onDefault = await m.addAgent({ id: "d", workspace: ws } as never, { persist: true, fresh: true });
      const withOwnKey = await m.addAgent(
        { id: "o", workspace: ws, provider: "p", apiKey: "mine" } as never,
        { persist: true, fresh: true },
      );
      assert.equal(onDefault.llm.baseUrl, "http://p");
      assert.equal(withOwnKey.llm.apiKey, "mine");

      m.updateConfig({ defaultProvider: "q" });
      assert.equal(onDefault.llm.baseUrl, "http://q", "an agent on the default provider follows it");
      assert.equal(onDefault.llm.apiKey, "q-key");
      assert.equal(withOwnKey.llm.apiKey, "mine", "an inline key is the operator's, not the provider's");
      assert.equal(withOwnKey.llm.baseUrl, "http://p", "and neither is its baseUrl replaced");
    } finally {
      await Promise.allSettled([...m.agents.values()].map((x) => x.dispose()));
    }
  });
});
