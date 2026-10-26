/**
 * First run opens SETTINGS on providers — there is no wizard any more.
 *
 * The wizard replaced the entire layout and blocked everything until a provider was configured.
 * Asked to replace it with a nudge: "初回起動(AIプロバイダ未登録の場合初回起動と判定)は設定ウィンドウを
 * 開いてprovidersを表示するように … 別に登録するまで閉じられないとかじゃなくて、あくまでもUIが開かれた
 * 時に開いて誘導するだけ".
 *
 * Two things have to hold, and they are both checkable without a browser:
 *   - the SERVER's definition of first run is "no provider registered", not "no config file";
 *   - the CLIENT renders normally and opens the panel, rather than swapping the layout out.
 */
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
  /**
   * A config file can exist with no usable provider — edited by hand, or every provider removed.
   * The old definition (`!configFileExists`) did not fire there, so the wizard did not appear and
   * the app simply could not do anything. The question the UI needs answered is "can this thing
   * talk to a model yet?".
   */
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
