import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

test("an MCP server survives save → reopen (#67)", async () => {
  await useTempDirs(["mcprt-root-"], async ([dataDir]) => {
    const configPath = path.join(dataDir!, "config.json");
    const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, configPath);
    const app = buildApp(m);

    const saved = [
      { name: "files", url: "https://mcp.example/mcp", transport: "http", enabled: true },
      {
        name: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "some-server"],
        enabled: false,
      },
    ];
    const put = await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providers: {},
        mcpServers: saved,
      }),
    });
    assert.equal(put.status, 200);

    const got = (await (await app.request("/api/config")).json()) as { mcpServers?: unknown };
    assert.ok(got.mcpServers, "GET /api/config must return the saved MCP servers (#67)");
    assert.deepEqual(got.mcpServers, saved, "and return them UNCHANGED, so editing round-trips");

    assert.equal((got.mcpServers as unknown[]).length, 2);

    assert.deepEqual(
      m.config.mcpServers,
      saved,
      "the in-memory config must carry them, or a restart loses the server",
    );

    m.saveConfig();
    const onDisk = JSON.parse(await readFile(configPath, "utf8")) as { mcpServers?: unknown };
    assert.deepEqual(onDisk.mcpServers, saved, "the config FILE must carry them too");
  });
});

test("a rejected MCP server does not silently vanish from the config (#67)", async () => {
  await useTempDirs(["mcprt2-root-"], async ([dataDir]) => {
    const configPath = path.join(dataDir!, "config.json");
    const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, configPath);
    const app = buildApp(m);
    const bad = await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providers: {}, mcpServers: [{ name: "", url: "" }] }),
    });
    assert.equal(bad.status, 400, "an unusable entry must be refused, not dropped");
    const body = (await bad.json()) as { error?: string };
    assert.match(String(body.error), /MCP|name/i, "and the message must name the problem");

    const got = (await (await app.request("/api/config")).json()) as { mcpServers?: unknown };
    assert.deepEqual(got.mcpServers ?? [], []);
  });
});
