/**
 * #15 — ACP support ("teapot --acp", a thin stdio adapter).
 *
 * ACP is JSON-RPC 2.0 over stdio (agentclientprotocol.com), so an editor can
 * launch a teapot agent as a subprocess. The adapter is deliberately thin: it
 * reuses the existing Master/Agent primitives and never touches the agent loop.
 *
 * These tests drive the adapter over a real stream pair, so the transport,
 * the error contract and the session lifecycle are exercised together.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";
import { AcpAdapter, ACP_PROTOCOL_VERSION } from "../src/acp/adapter.ts";

function mkMaster(dataDir: string): Master {
  return new Master(
    {
      port: 0,
      dataDir,
      llm: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" },
      providers: { p: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" } },
      defaultProvider: "p",
      agents: [],
    } as never,
    "/dev/null",
  );
}

/** an adapter wired to in-memory streams, plus a collector for its replies */
function harness(master: Master, cwd: string) {
  const input = new PassThrough();
  const sink = new PassThrough();
  const sent: any[] = [];
  sink.on("data", (c: Buffer | string) => {
    for (const line of String(c).split("\n")) {
      if (line.trim()) {
        try {
          sent.push(JSON.parse(line));
        } catch {
          /* the adapter only ever writes JSON lines */
        }
      }
    }
  });
  const adapter = new AcpAdapter({ master, input, output: sink as never, defaultCwd: cwd });
  const closed = adapter.listen();
  return {
    adapter,
    sent,
    async send(msg: unknown) {
      input.write(JSON.stringify(msg) + "\n");
    },
    async sendRaw(line: string) {
      input.write(line + "\n");
    },
    /** let pending async handlers settle */
    async settle(ms = 120) {
      await new Promise((r) => setTimeout(r, ms));
    },
    async close() {
      input.end();
      await closed;
    },
  };
}

const rpc = (id: number, method: string, params?: unknown) => ({
  jsonrpc: "2.0" as const,
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

/* ---------- initialize (#15) ---------- */

test("initialize reports the protocol version and only real capabilities (#15)", async () => {
  await useTempDirs(["acp1-", "acp2-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const h = harness(m, ws);
    await h.send(rpc(1, "initialize", { protocolVersion: ACP_PROTOCOL_VERSION }));
    await h.settle();
    const res = h.sent.find((s) => s.id === 1)?.result;
    assert.equal(res?.protocolVersion, ACP_PROTOCOL_VERSION, "must report the ACP version (#15)");
    assert.ok(res?.agentCapabilities, "capabilities are required by the protocol (#15)");
    // terminal/fs are NOT implemented, so they must not be advertised: a client
    // only calls what initialize claims
    assert.equal(res.agentCapabilities.terminal, undefined, "terminal must not be advertised (#15)");
    await h.close();
    await m.stopAllAgents(2_000);
  });
});

/* ---------- JSON-RPC contract (#15) ---------- */

test("an unknown method is a JSON-RPC error, not silence (#15)", async () => {
  await useTempDirs(["acp3-", "acp4-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const h = harness(m, ws);
    await h.send(rpc(7, "no/such/method"));
    await h.settle();
    const err = h.sent.find((s) => s.id === 7)?.error;
    assert.equal(err?.code, -32601, "must be METHOD_NOT_FOUND (#15)");
    assert.equal(h.sent.length, 1, "exactly one reply (#15)");
    await h.close();
    await m.stopAllAgents(2_000);
  });
});

test("a notification is NEVER answered, even for an unknown method (#15)", async () => {
  await useTempDirs(["acp5-", "acp6-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const h = harness(m, ws);
    await h.send({ jsonrpc: "2.0", method: "no/such/method" });
    await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "nope" } });
    await h.settle();
    assert.equal(h.sent.length, 0, "a notification gets no response, success or error (#15)");
    await h.close();
    await m.stopAllAgents(2_000);
  });
});

test("malformed JSON yields a parse error with a null id (#15)", async () => {
  await useTempDirs(["acp7-", "acp8-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const h = harness(m, ws);
    await h.sendRaw("{not json");
    await h.settle();
    const err = h.sent.find((s) => s.error?.code === -32700);
    assert.ok(err, "must report PARSE_ERROR (#15)");
    assert.equal(err.id, null, "an unparseable line has no id to answer (#15)");
    await h.close();
    await m.stopAllAgents(2_000);
  });
});

test("a request without a params object is handled, not crashed on (#15)", async () => {
  await useTempDirs(["acp9-", "acp10-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const h = harness(m, ws);
    await h.send(rpc(1, "initialize"));
    await h.settle();
    assert.ok(h.sent.find((s) => s.id === 1)?.result, "initialize needs no params (#15)");
    await h.close();
    await m.stopAllAgents(2_000);
  });
});

/* ---------- sessions (#15) ---------- */

test("session/new returns a session id (#15)", async () => {
  await useTempDirs(["acp11-", "acp12-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const h = harness(m, ws);
    await h.send(rpc(1, "session/new", { cwd: ws }));
    for (let i = 0; i < 40 && !h.sent.length; i++) await h.settle(100);
    const res = h.sent.find((s) => s.id === 1)?.result;
    assert.ok(res?.sessionId, "must return a sessionId (#15)");
    assert.ok(
      String(res.sessionId).startsWith("acp-"),
      "the id should be recognisably ACP's (#15)",
    );
    await h.close();
    await m.stopAllAgents(2_000);
  });
});

test("a prompt for an unknown session is rejected, not hung (#15)", async () => {
  await useTempDirs(["acp13-", "acp14-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const h = harness(m, ws);
    await h.send(rpc(1, "session/prompt", { sessionId: "nope", prompt: [{ text: "hi" }] }));
    await h.settle(200);
    const err = h.sent.find((s) => s.id === 1)?.error;
    assert.ok(err, "must reject an unknown session (#15)");
    assert.equal(err.code, -32602);
    await h.close();
    await m.stopAllAgents(2_000);
  });
});

test("an empty prompt is rejected (#15)", async () => {
  await useTempDirs(["acp15-", "acp16-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const h = harness(m, ws);
    await h.send(rpc(1, "session/new", { cwd: ws }));
    for (let i = 0; i < 40 && !h.sent.length; i++) await h.settle(100);
    const sid = h.sent.find((s) => s.id === 1)?.result?.sessionId;
    await h.send(rpc(2, "session/prompt", { sessionId: sid, prompt: [] }));
    await h.settle(200);
    assert.ok(h.sent.find((s) => s.id === 2)?.error, "an empty prompt must be rejected (#15)");
    await h.close();
    await m.stopAllAgents(2_000);
  });
});

/* ---------- the CLI flag (#15) ---------- */

test("--acp is documented in --help (#15)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /--acp/, "the flag must exist (#15)");
  assert.match(src, /Agent Client Protocol/, "help must explain it (#15)");
});

test("ACP mode starts BEFORE the HTTP server (#15)", async () => {
  // an editor launching `teapot --acp` must never bind a port
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const acpAt = src.indexOf('process.argv.includes("--acp")');
  const serveAt = src.indexOf("serveApp(app");
  assert.ok(acpAt > 0, "ACP branch missing (#15)");
  assert.ok(serveAt > 0, "serveApp call missing");
  assert.ok(acpAt < serveAt, "ACP mode must be handled before serveApp binds a port (#15)");
  assert.match(src, /acp\.listen\(\)/, "ACP mode must run the adapter (#15)");
});