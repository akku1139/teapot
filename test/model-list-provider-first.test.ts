import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchModelList } from "../src/model-meta.ts";

/**
 * The PROVIDER's own catalog decides membership; models.dev only fills in capabilities.
 *
 * MEASURED: Command Code serves 94 models and models.dev lists 72 for it. `reflection/beam:free` is in
 * the provider's list and absent from models.dev — so a models.dev-only list silently hid a model the
 * operator could call, which is the reported bug ("モデル候補一覧に出てこない").
 *
 * But the provider is not enough either: Command Code's `/models` returns only
 * `{context_length, created, id, name, object, owned_by, supported_endpoints}`, so modalities, effort
 * levels and pricing have to come from models.dev. Hence the merge, provider field first.
 */
async function withUpstream(
  body: unknown,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    srv.close();
  }
}

test("a model the provider serves but models.dev omits still appears (#models)", async () => {
  // localhost is not in models.dev, so the provider list is the ONLY source here — which is the point:
  // membership must not depend on the database knowing the provider.
  await withUpstream(
    {
      data: [
        { id: "reflection/beam:free", name: "Beam Free", context_length: 1_048_576, object: "model" },
        { id: "other/model", name: "Other", object: "model" },
      ],
    },
    async (baseUrl) => {
      const list = await fetchModelList(baseUrl);
      assert.deepEqual(
        list.map((m) => m.id).sort(),
        ["other/model", "reflection/beam:free"],
        "every model the provider serves must be offered",
      );
      const beam = list.find((m) => m.id === "reflection/beam:free")!;
      assert.equal(beam.contextLength, 1_048_576, "and carry the provider's own context length");
    },
  );
});

test("the provider's capabilities win when it publishes them (#models)", async () => {
  await withUpstream(
    {
      data: [
        {
          id: "vision/model",
          name: "Vision",
          context_length: 200_000,
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          supported_parameters: ["tools", "reasoning"],
        },
      ],
    },
    async (baseUrl) => {
      const [m] = await fetchModelList(baseUrl);
      assert.deepEqual(m!.modalities?.input, ["text", "image"], "OpenRouter-style fields are used directly");
      assert.equal(m!.reasoning, true, "and `reasoning` in supported_parameters is honoured");
    },
  );
});

test("a provider that answers nothing useful falls back to models.dev (#models)", async () => {
  // an empty `data` must not be reported as "this provider has no models"
  await withUpstream({ data: [] }, async (baseUrl) => {
    const list = await fetchModelList(baseUrl);
    assert.deepEqual(list, [], "unknown provider and empty upstream = no models, not a throw");
  });
});
