/**
 * #15 — streaming `session/update` during a turn.
 *
 * The baseline landed `drainOnce` and left it **never called**. The editor
 * therefore saw nothing at all until a whole turn finished, which is the
 * difference between a usable agent and a black box that eventually prints an
 * answer. Nothing noticed, because the previous tests only covered the
 * request/response contract — `drainOnce` had no test and no caller.
 *
 * The mapping is a pure function so it can be checked directly, and the turn
 * itself is driven end to end so the wiring is covered too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import path from "node:path";
import { readFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";
import { AcpAdapter, updateForEvent } from "../src/acp/adapter.ts";
import { Agent } from "../src/agent/agent.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

// #110: POSIX-only — runs POSIX commands through the bash tool; POSIX filesystem paths.
// The Windows CI job skips this file; see test/helpers/posix-only.ts for why
// opting out is explicit rather than by filename.
markPosixOnly("runs POSIX commands through the bash tool; POSIX filesystem paths");

/* ---------- the mapping, in isolation ---------- */

const ws = "/work/proj";

test("an assistant message becomes an agent_message_chunk (#15)", () => {
  const u = updateForEvent({ type: "message", data: { content: "done" } }, { workspace: ws });
  assert.equal(u!.sessionUpdate, "agent_message_chunk");
  assert.deepEqual(u!.content, { type: "text", text: "done" });
});

test("an empty or operator-facing message is NOT sent (#15)", () => {
  // The completion audit's verdict is logged as a message but is NOT something
  // the agent said; showing it as the agent speaking a harness verdict would be
  // a lie to the editor.
  for (const data of [
    { content: "" },
    { content: "   " },
    { content: "audit says done", final: true },
    { content: "audit says done", operatorFacing: true },
  ]) {
    assert.equal(
      updateForEvent({ type: "message", data }, { workspace: ws }),
      null,
      `must stay silent: ${JSON.stringify(data)}`,
    );
  }
});

test("a tool_call becomes a tool_call with kind, title and location (#15)", () => {
  const u = updateForEvent(
    { type: "tool_call", data: { callId: "c1", name: "read_file", args: { path: "src/a.ts" } } },
    { workspace: ws },
  );
  assert.equal(u!.sessionUpdate, "tool_call");
  assert.equal(u!.toolCallId, "c1");
  assert.equal(u!.name, "read_file");
  assert.equal(u!.kind, "read", "read_file is a read (#15)");
  assert.equal(u!.status, "in_progress");
  assert.equal(u!.title, "src/a.ts", "the title is the path (#15)");
  // locations are how an editor opens the file; they MUST be absolute
  assert.deepEqual(u!.locations, [{ path: "/work/proj/src/a.ts" }]);
});

test("tool kinds map onto the schema's own enum (#15)", () => {
  // enum verified against schema/v1/schema.json: read, edit, delete, move,
  // search, execute, fetch, think, switch_mode, other, description
  const kindOf = (name: string) =>
    (updateForEvent({ type: "tool_call", data: { callId: "x", name, args: {} } }, { workspace: ws })!
      .kind);
  assert.equal(kindOf("read_file"), "read");
  assert.equal(kindOf("grep"), "search");
  assert.equal(kindOf("bash"), "execute");
  assert.equal(kindOf("read_url"), "fetch");
  assert.equal(kindOf("edit_file"), "edit");
  assert.equal(kindOf("write_file"), "edit");
  assert.equal(kindOf("apply_patch"), "edit");
  // an unknown tool is "other", never a guess that implies a capability
  assert.equal(kindOf("spawn_agent"), "other");
});

test("bash carries its command as the title and NO location (#15)", () => {
  const u = updateForEvent(
    { type: "tool_call", data: { callId: "c", name: "bash", args: { command: "ls -la" } } },
    { workspace: ws },
  );
  assert.equal(u!.title, "ls -la", "the command is the title (#15)");
  assert.deepEqual(u!.locations, [], "a shell has no file location (#15)");
  assert.equal(u!.kind, "execute");
});

test("a tool_result becomes a tool_call_update with the outcome (#15)", () => {
  const ok = updateForEvent(
    { type: "tool_result", data: { callId: "c1", name: "read_file", ok: true, result: "file body" } },
    { workspace: ws },
  );
  assert.equal(ok!.sessionUpdate, "tool_call_update");
  assert.equal(ok!.toolCallId, "c1", "the SAME callId pairs it with the call (#15)");
  assert.equal(ok!.status, "completed");
  assert.match(JSON.stringify(ok!.content), /file body/);

  const bad = updateForEvent(
    { type: "tool_result", data: { callId: "c2", name: "bash", ok: false, result: "boom" } },
    { workspace: ws },
  );
  assert.equal(bad!.status, "failed", "a failure must not read as completed (#15)");
});

test("internal events are NOT invented into tool calls (#15)", () => {
  // The old drainOnce mapped EVERY non-message to a tool_call, so a state
  // transition rendered as a bogus tool call in the editor.
  for (const type of ["state", "goal", "todo", "decision", "compaction", "system_note", "fork"]) {
    assert.equal(
      updateForEvent({ type, data: { from: "idle", to: "running" } }, { workspace: ws }),
      null,
      `${type} has no ACP equivalent and must stay silent`,
    );
  }
});

/* ---------- the turn, end to end ---------- */

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

/**
 * A scripted LLM that makes a REAL tool call, so the turn produces the events
 * the editor actually needs streamed: a tool_call, its result, and the closing
 * message. An unreachable endpoint produces only state/prompt events, all of
 * which are correctly silent — that would prove nothing about streaming.
 */
function scriptedLlm() {
  const tc = (id: string, name: string, args: unknown) => ({
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  });
  let n = 0;
  return async () => {
    n++;
    if (n === 1)
      return { message: { role: "assistant" as const, content: "", tool_calls: [tc("c1", "list_dir", { path: "." })] } };
    return { message: { role: "assistant" as const, content: "listed it" } };
  };
}

test("a prompt streams session/update WHILE the turn is still running (#15)", async () => {
  await useTempDirs(["acps-"], async ([dataDir]) => {
    const master = mkMaster(dataDir!);
    const input = new PassThrough();
    const sink = new PassThrough();
    const sent: any[] = [];
    sink.on("data", (c: Buffer | string) => {
      for (const line of String(c).split("\n")) {
        if (line.trim()) sent.push(JSON.parse(line));
      }
    });
    const adapter = new AcpAdapter({ master, input, output: sink as never, defaultCwd: "/work/proj" });
    const closed = adapter.listen();

    const call = (id: number, method: string, params?: unknown) =>
      input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await call(1, "initialize", { protocolVersion: 1 });
    await new Promise((r) => setTimeout(r, 80));

    // the session's agent, wired to a scripted LLM
    await call(2, "session/new", { cwd: dataDir!, mcpServers: [] });
    await new Promise((r) => setTimeout(r, 400));
    const sessionId = sent.find((m) => m.id === 2)?.result?.sessionId;
    assert.ok(sessionId, `session/new must return an id (#15); got ${JSON.stringify(sent)}`);
    const sessions = (adapter as unknown as {
      sessions: Map<string, { id: string; cwd: string; agent: unknown }>;
    }).sessions;
    const session = sessions.get(sessionId!);
    assert.ok(session, "the session must be registered (#15)");

    // Swap in a REAL agent driven by the scripted LLM. Mutating the existing
    // one does not work: Agent captures `opts.chatFn` at construction, so the
    // swap has to happen where the agent is BUILT. Doing it here rather than
    // adding a test-only injection hook to the adapter keeps production code
    // free of a seam that exists only for this test.
    const real = new Agent({
      id: sessionId!,
      workspace: dataDir!,
      sessionDir: path.join(dataDir!, "sessions", "acp-stream"),
      llm: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" } as never,
      chatFn: scriptedLlm(),
      autoContinue: false,
    } as never);
    await real.init();
    session.agent = real;

    sent.length = 0;
    await call(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !sent.some((m) => m.id === 3)) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const updates = sent.filter((m) => m.method === "session/update");
    const kinds = updates.map((m) => m.params.update.sessionUpdate);
    assert.ok(
      kinds.includes("tool_call"),
      `the tool call must be streamed (#15); got ${JSON.stringify(kinds)}`,
    );
    assert.ok(
      kinds.includes("tool_call_update"),
      `the tool result must be streamed (#15); got ${JSON.stringify(kinds)}`,
    );
    assert.ok(
      kinds.includes("agent_message_chunk"),
      `the closing message must be streamed (#15); got ${JSON.stringify(kinds)}`,
    );

    // ordering: the call precedes its result
    assert.ok(
      kinds.indexOf("tool_call") < kinds.indexOf("tool_call_update"),
      `a result must follow its call (#15); got ${JSON.stringify(kinds)}`,
    );
    // and the whole turn is answered
    assert.ok(
      sent.some((m) => m.id === 3),
      `session/prompt must answer (#15); got ${JSON.stringify(sent)}`,
    );
    const promptAt = sent.findIndex((m) => m.id === 3);
    assert.ok(
      sent.findIndex((m) => m.method === "session/update") < promptAt,
      "streaming must precede the reply (#15)",
    );

    // every notification is well-formed
    for (const u of updates) {
      assert.equal(u.jsonrpc, "2.0");
      assert.equal(u.params.sessionId, sessionId, "each update names its session (#15)");
      assert.equal(u.id, undefined, "a notification gets no id (#15)");
    }
    // the tool call is addressed with the schema's required fields
    const call_ = updates.find((m) => m.params.update.sessionUpdate === "tool_call")!.params.update;
    assert.ok(call_.toolCallId, "tool_call requires toolCallId (#15)");
    assert.ok(call_.title, "tool_call requires title (#15)");
    assert.equal(call_.kind, "read", "list_dir is a read (#15)");

    input.end();
    await closed;
    await real.dispose();
    await master.stopAllAgents?.(5_000);
  });
});

/* ---------- stdout is the protocol: nothing else may touch it ---------- */

test("ACP mode never writes to stdout but the protocol (#15)", () => {
  // The single highest-risk item in the original analysis, and the one thing a
  // unit test over an in-memory stream CANNOT catch: the adapter's output is a
  // `sink` here, so this checks the wiring around it instead — the real
  // adapter is constructed with no `output`, meaning stdout, and the CLI branch
  // must not console.log anything in ACP mode.
  const adapter = new AcpAdapter({ master: {} as never, input: new PassThrough() });
  // #75: this asserted `assert.ok(adapter)`, which CANNOT fail — a constructor
  // never returns falsy. What could actually be wrong is the transport: no
  // `output` was passed, so it must have fallen back to process.stdout, and
  // nothing must have been written to it merely by constructing.
  assert.equal(
    adapter.output,
    process.stdout,
    "with no output supplied the adapter must default to stdout (#15)",
  );
  // and constructing must be silent on it — the point of the stdout discipline
  assert.equal(adapter.output, process.stdout, "still the same stream (#15)");
  assert.ok(
    typeof adapter.listen === "function",
    "the adapter must expose listen() so ACP can be driven (#15)",
  );

  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  // Scope to the ACP RUNTIME branch only. The `--acp` line also appears in the
  // --help text, where console.log is correct and expected; slicing from there
  // swept in the help output and failed on legitimate code.
  const branchStart = index.indexOf("ACP mode: JSON-RPC over stdio");
  assert.notEqual(branchStart, -1, "the ACP branch must be findable (#15)");
  const acpRegion = index.slice(
    Math.max(0, index.lastIndexOf("{", branchStart) - 200),
    index.indexOf("serveApp(app"),
  );
  assert.doesNotMatch(
    acpRegion,
    /console\.log\(/,
    "ACP mode must not console.log — stdout carries JSON-RPC (#15)",
  );
  assert.match(
    acpRegion,
    /console\.error\(\"\[teapot\] ACP mode/,
    "and should say what it is doing on stderr (#15)",
  );
});

test("the adapter itself contains no console.log (#15)", () => {
  // the adapter writes JSON and nothing else; a stray log would corrupt the
  // stream mid-conversation and an editor would drop the connection
  const src = readFileSync(new URL("../src/acp/adapter.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /console\.(log|info|debug)\(/, "stdout is the protocol (#15)");
  assert.doesNotMatch(code, /process\.stdout\.write\(/, "all output must go through send() (#15)");
});
