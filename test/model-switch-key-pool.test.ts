import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";
import type { LlmConfig } from "../src/agent/llm.ts";

const LLM = { baseUrl: "http://127.0.0.1:9", apiKey: "k", model: "cfg-model" };

test("applying a provider switch preserves the provider's key pool", async () => {
  await useTempDirs(["ms-root-", "ms-ws-"], async ([dataDir, ws]) => {
    const master = new Master(
      {
        port: 0,
        dataDir,
        llm: LLM,
        providers: {
          p: {
            baseUrl: "http://127.0.0.1:9",
            apiKeys: ["k1", "k2"],
            model: "prov-model",
          },
        },
        defaultProvider: "p",
        agents: [],
      },
      `${dataDir}/config.json`,
    );
    const agent = await master.addAgent({ id: "alpha", workspace: ws }, { fresh: true });
    assert.equal(agent.llm.model, "prov-model");

    await master.setAgentModel("alpha", "p", "switched-model");
    const llm = agent.llm as LlmConfig;
    assert.equal(llm.model, "switched-model");
    assert.deepEqual(
      llm.keyPool?.keys,
      ["k1", "k2"],
      "the applied provider switch must carry the key pool, or a 429 cannot rotate",
    );
    assert.equal(llm.apiKey, "k1", "the pool's current key is used, not the raw first key");

    await master.setAgentModel("alpha", "p");
    assert.equal(
      (agent.llm as LlmConfig).model,
      "prov-model",
      "no model argument: the provider default applies, not the previous agent model",
    );
    const pool = (agent.llm as LlmConfig).keyPool;
    assert.deepEqual(pool?.keys, ["k1", "k2"]);

    await master.setAgentModel("alpha", undefined, "model-only");
    const llmOnly = agent.llm as LlmConfig;
    assert.equal(llmOnly.model, "model-only");
    assert.deepEqual(
      llmOnly.keyPool?.keys,
      ["k1", "k2"],
      "a model-only switch must keep the pool that was already in use",
    );

    await agent.dispose();
  });
});
