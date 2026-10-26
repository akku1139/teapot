import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { Master } from "../src/master.ts";
import { buildApp, serveApp } from "../src/server/api.ts";
import { freePort } from "./helpers/free-port.ts";
import { readEvents } from "../src/log/events.ts";

function call(port: number, method: string, p: string, body?: unknown) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json" } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: (() => { try { return JSON.parse(buf); } catch { return buf; } })() }));
      },
    );
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

/**
 * `/skill` reported as "from you" — the harness instruction was attributed to the operator.
 *
 * The route hardcoded `source: "user"`, so the only party that knows an instruction came from the
 * harness (the client, which built the text) had no way to say so.
 */
test("POST /prompt records the SOURCE the caller states (#skill)", async () => {
  const dataDir = mkdtempInRootSync("src-");
  const m = new Master(
    { port: 0, dataDir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, providers: {}, agents: [{ id: "a1", workspace: dataDir }] } as never,
    `${dataDir}/config.json`,
  );
  const app = buildApp(m);
  const port = await freePort();
  const server = serveApp(app, port, "127.0.0.1");
  try {
    await m.addAgent({ id: "a1", workspace: dataDir, session: "a1" } as never).catch(() => {});
    // harness source
    const h = await call(port, "POST", "/api/agents/a1/prompt", {
      text: '[harness] Force-load and follow the skill "web-search" now',
      start: false,
      source: "harness",
    });
    assert.equal(h.status, 200, `prompt must be accepted: ${JSON.stringify(h.json)}`);
    // an unknown source must fall back to the operator, not be trusted
    try {
      await call(port, "POST", "/api/agents/a1/prompt", { text: "hello", start: false, source: "root" as never });
    } catch {
      /* the second write is independent; a failure here must not mask the first assertion */
    }

    const a = m.agents.get("a1")!;
    /**
     * Wait for BOTH rows before reading.
     *
     * `enqueuePrompt` appends through `ensureReady()`, so the write lands some time after the HTTP
     * answer — on Windows that gap was long enough that the status request ran between the two
     * appends and the assertions saw only one row (`source: undefined`). Poll for the rows the test
     * is about instead of assuming one round trip is enough.
     */
    const readWithRows = async () => {
      for (let i = 0; i < 40; i++) {
        const evs = await readEvents(a.log.filePath).catch(() => []);
        const prompts = evs.filter((e) => e.type === "prompt");
        const hasHarness = prompts.some((e) => String((e.data as { text?: string }).text ?? "").includes("Force-load"));
        const hasPlain = prompts.some((e) => String((e.data as { text?: string }).text ?? "") === "hello");
        if (hasHarness && hasPlain) return evs;
        await new Promise((r) => setTimeout(r, 50));
      }
      return await readEvents(a.log.filePath);
    };
    const evs = await readWithRows();
    const prompts = evs.filter((e) => e.type === "prompt");
    const harnessRow = prompts.find((e) => String((e.data as { text?: string }).text ?? "").includes("Force-load"));
    assert.equal(
      (harnessRow?.data as { source?: string })?.source,
      "harness",
      "the harness instruction must be logged as harness, or the timeline shows it as the operator's " +
        "own message (#skill)",
    );
    const plain = prompts.find((e) => String((e.data as { text?: string }).text ?? "") === "hello");
    assert.equal(
      (plain?.data as { source?: string })?.source,
      "user",
      "an unrecognised source must be treated as the operator — never trusted as harness (#skill)",
    );
  } finally {
    await server.close();
    await (m as unknown as { shutdown?: () => Promise<void> }).shutdown?.().catch(() => {});
  }
});
