import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { buildApp } from "../src/server/api.ts";
import { Master } from "../src/master.ts";

const appWith = async (dataDir: string, config: Record<string, unknown>) => {
  const cfgPath = path.join(dataDir, "config.json");
  writeFileSync(cfgPath, JSON.stringify(config));
  const master = new Master(
    { port: 0, dataDir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, providers: {}, agents: [], ...config } as never,
    cfgPath,
  );
  return { app: buildApp(master), master };
};

test("first run means NO PROVIDER, not no config file (#setup)", async () => {
  const dir = mkdtempInRootSync("setup-a-");
  const { app } = await appWith(dir, { providers: {}, agents: [] });
  const res = await app.request("/api/config");
  const body = (await res.json()) as { needsSetup?: boolean; providers?: unknown };
  assert.equal(body.needsSetup, true, "a config file with no providers is still a first run");

  const dir2 = mkdtempInRootSync("setup-b-");
  const { app: app2 } = await appWith(dir2, {
    providers: { local: { baseUrl: "http://localhost:11434/v1" } },
    agents: [],
  });
  const body2 = (await (await app2.request("/api/config")).json()) as { needsSetup?: boolean };
  assert.equal(
    body2.needsSetup,
    false,
    "a provider with NO apiKey counts as registered — a local endpoint legitimately has none",
  );
});
