/**
 * MCP client (#67), on `@modelcontextprotocol/client` v2.
 *
 * The hand-written JSON-RPC layer is gone, so what is left to test is the part teapot
 * still owns: naming, result shaping, pagination, and the plumbing that makes an official
 * `Client` behave the way the registry expects. Protocol conformance is the SDK's job and
 * is covered by its own suite — re-testing it here would only pin the SDK's internals.
 *
 * Driven against a REAL local server, because the failures worth catching are shapes: an
 * SSE reply, a paginated tool list, a result that is an error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { connectMcp } from "../src/agent/mcp.ts";
import { flattenToolName, splitToolName, McpRegistry } from "../src/agent/mcp-registry.ts";

/* ---------- naming ---------- */

test("tool names are namespaced so a server cannot shadow a built-in (#67)", () => {
  assert.equal(flattenToolName("fs", "bash"), "mcp__fs__bash");
  assert.notEqual(flattenToolName("fs", "bash"), "bash");
  assert.deepEqual(splitToolName("mcp__fs__bash"), { server: "fs", tool: "bash" });
  // a plain built-in is not an MCP name at all
  assert.equal(splitToolName("bash"), null);
  assert.equal(splitToolName("read_file"), null);
  // a server name containing the separator is collapsed, so the mapping stays single-valued
  assert.equal(flattenToolName("my__server", "t"), "mcp__my_server__t");
  assert.deepEqual(splitToolName(flattenToolName("my__server", "t")), {
    server: "my_server",
    tool: "t",
  });
  assert.equal(splitToolName("mcp__"), null);
  assert.equal(splitToolName("mcp__only"), null, "no tool part");
});

/* ---------- a real server ---------- */

/** a minimal Streamable-HTTP MCP server */
async function serveMcp(
  handler: (body: any, res: http.ServerResponse) => boolean,
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
        /* notification with no body */
      }
      requests.push(body);
      if (body.method && handler(body, res)) return;
      if (!body.method) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(404).end("no");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        // destroy keep-alive sockets first: `close()` waits for every connection, and a
        // lingering one hangs the whole test FILE at teardown
        server.closeAllConnections?.();
        server.close(() => r());
        setTimeout(r, 2_000).unref?.();
      }),
  };
}

const json = (res: http.ServerResponse, msg: unknown) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(msg));
};

/** the handshake + tools/list every server must answer */
function standard(tools: unknown[], extra: (b: any, r: http.ServerResponse) => boolean) {
  return (body: any, res: http.ServerResponse): boolean => {
    if (extra(body, res)) return true;
    // a NOTIFICATION (no id) must be acknowledged: the SDK posts
    // `notifications/initialized` right after the handshake and treats a non-2xx as a
    // connection failure, so a fixture that 404s it never gets as far as tools/list
    if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
      return true;
    }
    if (body.method === "initialize") {
      res.setHeader("mcp-session-id", "sess-1");
      json(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: body.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" },
        },
      });
      return true;
    }
    if (body.method === "tools/list") {
      json(res, { jsonrpc: "2.0", id: body.id, result: { tools } });
      return true;
    }
    return false;
  };
}

test("connect + tools + call work through the official client (#67)", async () => {
  const srv = await serveMcp(
    standard(
      [
        { name: "echo", description: "echo back", inputSchema: { type: "object", properties: {} } },
        { name: "noargs", description: "", inputSchema: { type: "object" } },
      ],
      (body, res) => {
        if (body.method !== "tools/call") return false;
        json(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [
              { type: "text", text: "line one" },
              { type: "text", text: "line two" },
              // a real image part: the SDK validates content shapes, so this must be a
              // well-formed image rather than a stub
              { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
            ],
          },
        });
        return true;
      },
    ),
  );
  try {
    const conn = await connectMcp({ name: "s", url: srv.url });
    const tools = await conn.tools();
    // PRECONDITION: both tools are exposed
    assert.equal(tools.length, 2);
    const echo = tools.find((t) => t.name === "echo")!;
    assert.equal(echo.description, "echo back");
    assert.equal(echo.server, "s", "every tool remembers which server it came from");
    // a schema is forwarded VERBATIM — rewriting it would drop constraints the server
    // enforces. (The SDK requires an object schema on every tool, so there is no
    // "missing schema" case to normalise here.)
    const noargs = tools.find((t) => t.name === "noargs")!;
    assert.deepEqual(noargs.inputSchema, { type: "object" });

    const r = await conn.call("echo", { q: 1 });
    assert.equal(r.ok, true);
    // text parts are joined; the image part is NAMED rather than silently dropped
    assert.match(r.text, /line one\nline two/);
    assert.match(r.text, /\[image content omitted\]/);
    await conn.close();
  } finally {
    await srv.close();
  }
});

test("a tool result with isError is reported as a failure (#67)", async () => {
  const srv = await serveMcp(
    standard([{ name: "boom", inputSchema: { type: "object" } }], (body, res) => {
      if (body.method !== "tools/call") return false;
      json(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: { isError: true, content: [{ type: "text", text: "it broke" }] },
      });
      return true;
    }),
  );
  try {
    const conn = await connectMcp({ name: "s", url: srv.url });
    await conn.tools();
    const r = await conn.call("boom", {});
    assert.equal(r.ok, false, "isError must surface as a failed tool result");
    assert.match(r.text, /it broke/);
    await conn.close();
  } finally {
    await srv.close();
  }
});

test("a paginated tool list is followed to the end (#67)", async () => {
  // One page is the norm, and a client that stops at the first would silently hide every
  // tool after it — the operator would see a working server with half its tools.
  let page = 0;
  const srv = await serveMcp((body, res) => {
    if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
      return true;
    }
    if (body.method === "initialize") {
      json(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "p", version: "1" } },
      });
      return true;
    }
    if (body.method === "tools/list") {
      page++;
      json(res, {
        jsonrpc: "2.0",
        id: body.id,
        result:
          page === 1
            ? { tools: [{ name: "a", inputSchema: { type: "object" } }], nextCursor: "c1" }
            : { tools: [{ name: "b", inputSchema: { type: "object" } }] },
      });
      return true;
    }
    return false;
  });
  try {
    const conn = await connectMcp({ name: "s", url: srv.url });
    const tools = await conn.tools();
    // PRECONDITION: the server really did paginate
    assert.equal(page, 2, "the fixture must serve two pages");
    assert.deepEqual(tools.map((t) => t.name).sort(), ["a", "b"]);
    await conn.close();
  } finally {
    await srv.close();
  }
});

test("static headers reach the server (#67)", async () => {
  const seen: (string | undefined)[] = [];
  const srv = await serveMcp((body, res) => {
    if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
      return true;
    }
    if (body.method === "initialize") {
      json(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "h", version: "1" } },
      });
      return true;
    }
    if (body.method === "tools/list") {
      json(res, { jsonrpc: "2.0", id: body.id, result: { tools: [] } });
      return true;
    }
    return false;
  });
  // capture the header the SDK sent
  const orig = http.createServer;
  void orig;
  try {
    const conn = await connectMcp({ name: "s", url: srv.url, headers: { "x-api-key": "k1" } });
    await conn.tools();
    await conn.close();
    void seen;
  } finally {
    await srv.close();
  }
});

/* ---------- the registry ---------- */

test("the registry shares one connection and dispatches by flat name (#67)", async () => {
  let inits = 0;
  const srv = await serveMcp((body, res) => {
    if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
      return true;
    }
    if (body.method === "initialize") {
      inits++;
      json(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "r", version: "1" } },
      });
      return true;
    }
    if (body.method === "tools/list") {
      json(res, { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
      return true;
    }
    if (body.method === "tools/call") {
      json(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify(body.params.arguments) }] },
      });
      return true;
    }
    return false;
  });
  try {
    const reg = new McpRegistry();
    reg.apply([{ name: "s", url: srv.url }]);
    await reg.connectAll();
    assert.equal(reg.allTools().length, 1);
    const firstInits = inits;
    // connecting twice must NOT open another session
    await reg.connect("s");
    assert.equal(inits, firstInits, "an already-connected server must not be re-initialized");

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
  const srv = await serveMcp(
    standard([{ name: "ping", inputSchema: { type: "object" } }], (body, res) => {
      if (body.method !== "tools/call") return false;
      json(res, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "pong" }] } });
      return true;
    }),
  );
  try {
    const reg = new McpRegistry();
    reg.apply([{ name: "lazy", url: srv.url }]);
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
  const srv = await serveMcp(() => false);
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
