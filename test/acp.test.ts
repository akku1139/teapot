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
import { markPosixOnly } from "./helpers/posix-only.ts";

// #110: POSIX-only — POSIX filesystem paths.
// The Windows CI job skips this file; see test/helpers/posix-only.ts for why
// opting out is explicit rather than by filename.
markPosixOnly("POSIX filesystem paths");

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

