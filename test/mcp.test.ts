/**
 * MCP client (#67) — the parts that break against real servers.
 *
 * Everything here is driven through a REAL local HTTP server, because the failures
 * this code exists to survive are all server-side shapes: an SSE reply where the
 * result arrives mid-stream, a session id the server demands on every later request,
 * a 3xx to an HTML login page, a tool list that paginates forever. A mocked `fetch`
 * would let the implementation agree with the mock and still fail in production.
 *
 * The naming tests are here rather than beside the registry because the namespace is
 * the thing that keeps an MCP server from shadowing a built-in tool — `bash` from a
 * server must NOT become the `bash` the agent runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { connectMcp, readRpcResult, McpError } from "../src/agent/mcp.ts";
import { flattenToolName, splitToolName, McpRegistry } from "../src/agent/mcp-registry.ts";

test("names are namespaced so a server cannot shadow a built-in (#67)", () => {
  // the whole point: an MCP tool called `bash` must be reachable, and must not be
  // the `bash` the agent executes locally
  assert.equal(flattenToolName("fs", "bash"), "mcp__fs__bash");
  assert.notEqual(flattenToolName("fs", "bash"), "bash");
  // and the flat name maps back exactly, which is what dispatch relies on
  assert.deepEqual(splitToolName("mcp__fs__bash"), { server: "fs", tool: "bash" });
  // a plain built-in is not an MCP name at all
  assert.equal(splitToolName("bash"), null);
  assert.equal(splitToolName("read_file"), null);
  // a server name containing the separator is collapsed rather than rejected, so
  // the mapping stays single-valued
  const flat = flattenToolName("my__server", "t");
  assert.equal(flat, "mcp__my_server__t");
  assert.deepEqual(splitToolName(flat), { server: "my_server", tool: "t" });
  // malformed names are not mistaken for MCP tools
  assert.equal(splitToolName("mcp__"), null);
  assert.equal(splitToolName("mcp__only"), null, "no tool part");
});

/** a scriptable MCP server over Streamable HTTP */
async function serveMcp(
  handler: (body: any, headers: http.IncomingHttpHeaders, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void>; requests: any[] }> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* a notification with no body is fine */
      }
      requests.push({ headers: req.headers, body });
      handler(body, req.headers, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const jsonReply = (res: http.ServerResponse, msg: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(msg);
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(body);
};

/** the handshake every server must answer, plus a tools/list */
function standardHandler(tools: unknown[], extra: (body: any, res: http.ServerResponse) => boolean) {
  return (body: any, _h: http.IncomingHttpHeaders, res: http.ServerResponse) => {
    if (extra(body, res)) return;
    if (body.method === "initialize") {
      jsonReply(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t" } },
      });
      return;
    }
    if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (body.method === "tools/list") {
      jsonReply(res, { jsonrpc: "2.0", id: body.id, result: { tools } });
      return;
    }
    res.writeHead(404).end("no");
  };
}

test("a session id issued at initialize is sent on every later request (#67)", async () => {
  // Servers that issue `Mcp-Session-Id` reject anything without it. The reference
  // implementation carries it for exactly this reason, and a client that forgets
  // fails only against servers that DO issue one — so it must be exercised with one.
  let seenSession: string | null = null;
  const srv = await serveMcp(
    standardHandler(
      [{ name: "echo", description: "echo back", inputSchema: { type: "object", properties: {} } }],
      (body, res) => {
        if (body.method === "initialize") {
          seenSession = "sess-abc";
          jsonReply(
            res,
            {
              jsonrpc: "2.0",
              id: body.id,
              result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
            },
            { "mcp-session-id": "sess-abc" },
          );
          return true;
        }
        return false;
      },
    ),
  );
  try {
    const conn = await connectMcp({ name: "s", url: srv.url });
    const tools = await conn.tools();
    assert.equal(tools.length, 1);
    // PRECONDITION: the server must actually have issued an id, or this proves nothing
    assert.equal(seenSession, "sess-abc", "precondition: the server issued a session id");
    const listReq = srv.requests.find((r) => r.body?.method === "tools/list");
    assert.ok(listReq, "tools/list must have been sent");
    assert.equal(
      listReq.headers["mcp-session-id"],
      "sess-abc",
      "the issued session id must ride along, or servers that mint one refuse the call",
    );
    await conn.close();
  } finally {
    await srv.close();
  }
});

test("a result delivered mid-SSE-stream is returned without waiting for the close (#67)", async () => {
  // Streamable HTTP allows an event stream reply that stays open. Reading to the end
  // would hang forever; the implementation must stop at the matching id.
  const srv = await serveMcp(
    standardHandler(
      [{ name: "slow", description: "", inputSchema: { type: "object" } }],
      (body, res) => {
        if (body.method !== "tools/call") return false;
        res.writeHead(200, { "content-type": "text/event-stream" });
        // a notification first, which must NOT end the read
        res.write("event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n");
        res.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "hello from the server" }] },
          })}\n\n`,
        );
        // and deliberately leave the stream OPEN — the client must not wait for this
        return true;
      },
    ),
  );
  try {
    const conn = await connectMcp({ name: "s", url: srv.url });
    await conn.tools();
    const r = await conn.call("slow", {});
    assert.equal(r.ok, true);
    assert.match(r.text, /hello from the server/);
    await conn.close();
  } finally {
    await srv.close();
  }
});

test("a redirect is an ERROR, not something to follow (#67)", async () => {
  // An MCP url that redirects is almost always an HTML login page. Following it turns
  // a clear auth problem into "invalid JSON: <!DOCTYPE html>", which names the wrong
  // cause entirely.
  const srv = await serveMcp((_body, _h, res) => {
    res.writeHead(302, { location: "https://login.example.com/" }).end();
  });
  try {
    await assert.rejects(
      () => connectMcp({ name: "s", url: srv.url }),
      (err: Error) => {
        assert.ok(err instanceof McpError);
        assert.match(err.message, /redirected/i);
        assert.match(err.message, /302/, "the status must be named");
        return true;
      },
    );
  } finally {
    await srv.close();
  }
});

test("401 is reported as auth-required so the UI can say what to fix (#67)", async () => {
  const srv = await serveMcp((_b, _h, res) => {
    res.writeHead(401).end("no token");
  });
  try {
    await assert.rejects(
      () => connectMcp({ name: "s", url: srv.url }),
      (err: Error) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.authRequired, true, "a 401 means the operator must fix a header");
        assert.match(err.message, /401/);
        return true;
      },
    );
  } finally {
    await srv.close();
  }
});

test("configured headers are sent on every request (#67)", async () => {
  const srv = await serveMcp(
    standardHandler([{ name: "t", description: "", inputSchema: { type: "object" } }], () => false),
  );
  try {
    const conn = await connectMcp({
      name: "s",
      url: srv.url,
      headers: { authorization: "Bearer tok", "x-api-key": "k1" },
    });
    await conn.tools();
    for (const r of srv.requests) {
      if (!r.body?.method) continue;
      assert.equal(r.headers.authorization, "Bearer tok", `${r.body.method} must carry the header`);
      assert.equal(r.headers["x-api-key"], "k1");
    }
    await conn.close();
  } finally {
    await srv.close();
  }
});

test("pagination is followed, and a repeating cursor is refused (#67)", async () => {
  // A server that returns the same cursor forever would hang a naive loop. The cap and
  // the repeat check are both required: a cap alone spins 50 times, a repeat check
  // alone does not bound a server that keeps inventing new cursors.
  let page = 0;
  const srv = await serveMcp((body, _h, res) => {
    if (body.method === "initialize") {
      jsonReply(res, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } });
      return;
    }
    if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (body.method === "tools/list") {
      page++;
      jsonReply(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [{ name: `t${page}`, description: "", inputSchema: { type: "object" } }],
          // the SAME cursor every time
          nextCursor: "stay-here",
        },
      });
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const conn = await connectMcp({ name: "s", url: srv.url });
    await assert.rejects(
      () => conn.tools(),
      (err: Error) => {
        assert.match(err.message, /same cursor twice|did not finish/);
        return true;
      },
    );
    // PRECONDITION: it must have paginated at least twice before noticing
    assert.ok(page >= 2, `precondition: the cursor must have been followed; got ${page} pages`);
    await conn.close();
  } finally {
    await srv.close();
  }
});

test("a tool without an object inputSchema is rejected, not forwarded (#67)", async () => {
  // Forwarding it would send a malformed function spec to the LLM, and the resulting
  // 400 names the LLM provider rather than the MCP server.
  const srv = await serveMcp(
    standardHandler([{ name: "bad", description: "", inputSchema: "a string" }], () => false),
  );
  try {
    const conn = await connectMcp({ name: "s", url: srv.url });
    await assert.rejects(
      () => conn.tools(),
      (err: Error) => {
        assert.match(err.message, /inputSchema/);
        return true;
      },
    );
  } finally {
    await srv.close();
  }
});

test("a tool result is the concatenated text content, errors flagged (#67)", async () => {
  const srv = await serveMcp(
    standardHandler([{ name: "t", description: "", inputSchema: { type: "object" } }], (body, res) => {
      if (body.method !== "tools/call") return false;
      jsonReply(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          isError: body.params?.arguments?.fail === true,
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
            { type: "image", data: "..." },
          ],
        },
      });
      return true;
    }),
  );
  try {
    const conn = await connectMcp({ name: "s", url: srv.url });
    await conn.tools();
    const ok = await conn.call("t", {});
    assert.equal(ok.ok, true);
    assert.equal(ok.text, "line one\nline two\n[image content omitted]");
    const bad = await conn.call("t", { fail: true });
    assert.equal(bad.ok, false, "isError must surface as a failed tool result");
    await conn.close();
  } finally {
    await srv.close();
  }
});

test("the registry reuses one connection and dispatches by flat name (#67)", async () => {
  const srv = await serveMcp(
    standardHandler([{ name: "echo", description: "", inputSchema: { type: "object" } }], (body, res) => {
      if (body.method !== "tools/call") return false;
      jsonReply(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify(body.params.arguments) }] },
      });
      return true;
    }),
  );
  try {
    const reg = new McpRegistry();
    reg.apply([{ name: "s", url: srv.url }]);
    await reg.connectAll();
    assert.equal(reg.allTools().length, 1);
    const inits = () => srv.requests.filter((r) => r.body?.method === "initialize").length;
    const firstInits = inits();
    // a second connect must NOT open another session
    await reg.connect("s");
    assert.equal(inits(), firstInits, "connecting twice must reuse the live connection");

    const r = await reg.call("mcp__s__echo", { a: 1 });
    assert.ok(r, "a flat MCP name must be dispatched");
    assert.equal(r!.text, JSON.stringify({ a: 1 }), "arguments must reach the server unchanged");
    // a non-MCP name is not the registry's business
    assert.equal(await reg.call("bash", {}), null);
    // an unknown server is reported, not thrown at the caller
    const missing = await reg.call("mcp__nope__x", {});
    assert.equal(missing?.ok, false);
    await reg.closeAll();
  } finally {
    await srv.close();
  }
});

test("a server that is configured but not connected is connected on demand (#67)", async () => {
  // The operator adds a server in settings and keeps working; a tool call from the
  // very next turn must work without a restart.
  const srv = await serveMcp(
    standardHandler([{ name: "ping", description: "", inputSchema: { type: "object" } }], (body, res) => {
      if (body.method !== "tools/call") return false;
      jsonReply(res, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "pong" }] } });
      return true;
    }),
  );
  try {
    const reg = new McpRegistry();
    reg.apply([{ name: "lazy", url: srv.url }]);
    // no connectAll() — the state is "disconnected"
    assert.equal(reg.allTools().length, 0, "precondition: nothing is connected yet");
    const r = await reg.call("mcp__lazy__ping", {});
    assert.equal(r?.ok, true);
    assert.equal(r?.text, "pong");
    await reg.closeAll();
  } finally {
    await srv.close();
  }
});

test("a disabled server is never contacted (#67)", async () => {
  const srv = await serveMcp((_b, _h, res) => res.writeHead(500).end("must not be called"));
  try {
    const reg = new McpRegistry();
    reg.apply([{ name: "off", url: srv.url, enabled: false }]);
    await reg.connectAll();
    assert.equal(srv.requests.length, 0, "a disabled server must not be contacted at all");
    assert.equal(reg.allTools().length, 0);
    await reg.closeAll();
  } finally {
    await srv.close();
  }
});

test("readRpcResult names the unsupported content type instead of a bare parse error (#67)", async () => {
  // A proxy answering HTML with an unexpected content type is the classic case: the
  // message must say what arrived, or the operator cannot tell auth from a wrong URL.
  const res = new Response("<html>nope</html>", { headers: { "content-type": "text/html" } });
  await assert.rejects(
    () => readRpcResult(res, 1),
    (err: Error) => {
      assert.match(err.message, /JSON or text\/event-stream/);
      assert.match(err.message, /text\/html/);
      return true;
    },
  );
});

test("a JSON reply whose id does not match is refused (#67)", async () => {
  // A stale or crossed reply would otherwise be returned as our own result.
  const res = new Response(JSON.stringify({ jsonrpc: "2.0", id: 99, result: {} }), {
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(
    () => readRpcResult(res, 1),
    (err: Error) => {
      assert.match(err.message, /id mismatch/);
      return true;
    },
  );
});

test("an agent RUNS an MCP tool end to end, and a server cannot shadow bash (#67)", async () => {
  // The unit tests above prove the client; this proves the WIRING, which is where the
  // feature actually earns its keep: the tools must appear in the spec list the LLM
  // sees, and a call must be dispatched to the server instead of failing as "unknown
  // tool". The `bash`-shadowing case is the reason for the namespace, so the server
  // offers a tool literally called `bash` and the agent must reach BOTH.
  const { Agent } = await import("../src/agent/agent.ts");
  const { useTempDirs } = await import("./helpers/tmp.ts");
  const srv = await serveMcp(
    standardHandler(
      [
        { name: "bash", description: "NOT the local shell", inputSchema: { type: "object" } },
        { name: "lookup", description: "look something up", inputSchema: { type: "object" } },
      ],
      (body, res) => {
        if (body.method !== "tools/call") return false;
        jsonReply(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: `mcp ran ${body.params.name}` }] },
        });
        return true;
      },
    ),
  );
  const { mcp } = await import("../src/agent/mcp-registry.ts");
  try {
    mcp.apply([{ name: "srv", url: srv.url }]);
    await mcp.connectAll();

    // the spec list must carry BOTH mcp tools, namespaced, and the built-in `bash`
    const { toolSpecs } = await import("../src/agent/tools.ts");
    const names = new Set(toolSpecs().map((t) => t.function.name));
    assert.ok(names.has("bash"), "precondition: the built-in bash exists");
    // which is exactly why the prefix matters: two entries now, neither hiding the other
    const { flattenToolName } = await import("../src/agent/mcp-registry.ts");
    assert.equal(flattenToolName("srv", "bash"), "mcp__srv__bash");
    assert.notEqual(flattenToolName("srv", "bash"), "bash");

    await useTempDirs(["mcpe2e-a-", "mcpe2e-b-"], async ([ws, sessionDir]) => {
      const agent = new Agent({
        id: "t",
        workspace: ws!,
        sessionDir: sessionDir!,
        llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
        chatFn: async () => ({ message: { role: "assistant", content: "ok" } }),
        autoContinue: false,
      } as any);
      await agent.init();
      // dispatch through the SAME entry point the agent's loop uses
      const { executeTool } = await import("../src/agent/tools.ts");
      const r = await executeTool(
        "mcp__srv__lookup",
        JSON.stringify({ q: "x" }),
        (agent as any).toolCtx,
      );
      assert.equal(r.ok, true, `MCP dispatch must succeed: ${r.result}`);
      assert.match(r.result, /mcp ran lookup/);
      // and a built-in name still routes to the BUILT-IN, not to MCP. Asserting on
      // shell OUTPUT would test the shell (Windows has no `sh`, so `echo LOCAL`
      // produced nothing and this failed there for the wrong reason); assert on the
      // routing instead: an MCP server offering `bash` must not be reachable under the
      // bare name, so a bare-name call reaches the local tool and NOT the server.
      const before = srv.requests.filter((r) => r.body?.method === "tools/call").length;
      const local = await executeTool("bash", JSON.stringify({ command: "exit 0" }), (agent as any).toolCtx);
      const after = srv.requests.filter((r) => r.body?.method === "tools/call").length;
      assert.equal(after, before, "a bare built-in name must never be dispatched to MCP");
      assert.ok(
        typeof local.ok === "boolean",
        "the built-in bash must actually run (its ok flag is a boolean either way)",
      );
      await agent.dispose();
    });
    await mcp.closeAll();
  } finally {
    await mcp.closeAll();
    await srv.close();
  }
});
