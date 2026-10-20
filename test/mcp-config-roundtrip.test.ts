/**
 * A saved MCP server must come BACK (#67).
 *
 * Reported on v0.29.33: adding an MCP server, saving, then reopening settings showed an
 * empty list. The save had worked — `PUT /api/config` wrote `mcpServers` — but
 * `GET /api/config` never returned the field, so the dialog could only ever open with
 * nothing in it. A round-trip test is the only kind that catches this: each half was
 * individually correct.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

test("an MCP server survives save → reopen (#67)", async () => {
  await useTempDirs(["mcprt-root-"], async ([dataDir]) => {
    const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, "/dev/null");
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

    // THE REPORTED BUG: reopen the settings dialog = GET /api/config
    const got = (await (await app.request("/api/config")).json()) as { mcpServers?: unknown };
    assert.ok(got.mcpServers, "GET /api/config must return the saved MCP servers (#67)");
    assert.deepEqual(got.mcpServers, saved, "and return them UNCHANGED, so editing round-trips");

    // PRECONDITION: the field really is non-empty, so a passing test is not vacuous
    assert.equal((got.mcpServers as unknown[]).length, 2);

    // and the master's own config holds them, which is what a restart reloads
    assert.deepEqual(
      m.config.mcpServers,
      saved,
      "the in-memory config must carry them, or a restart loses the server",
    );
  });
});

test("a rejected MCP server does not silently vanish from the config (#67)", async () => {
  // The schema gate must FAIL the save rather than dropping a bad entry: a server that
  // disappears without an error is indistinguishable from the round-trip bug above.
  await useTempDirs(["mcprt2-root-"], async ([dataDir]) => {
    const m = new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, "/dev/null");
    const app = buildApp(m);
    const bad = await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providers: {}, mcpServers: [{ name: "", url: "" }] }),
    });
    assert.equal(bad.status, 400, "an unusable entry must be refused, not dropped");
    const body = (await bad.json()) as { error?: string };
    assert.match(String(body.error), /MCP|name/i, "and the message must name the problem");

    // nothing was written, so a reopen shows the previous (empty) list rather than a
    // half-applied one
    const got = (await (await app.request("/api/config")).json()) as { mcpServers?: unknown };
    assert.deepEqual(got.mcpServers ?? [], []);
  });
});
