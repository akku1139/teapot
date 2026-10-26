import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { useTempDirs } from "./helpers/tmp.ts";
import { waitFor } from "./helpers/wait-for.ts";

/**
 * An image a tool returned must survive a session restore.
 *
 * MEASURED on v0.37.69 (`github-bug-research-1f48715f` seq 11280): the `tool_result` row held only the
 * TEXT — "the image itself is attached to this message, so you are looking at it" — while the picture
 * existed nowhere. Restoring that session does not merely lose data: it tells the model something
 * FALSE about what it can see, so it answers confidently about an image it was never given.
 *
 * `prompt` rows already carry `images` for the user's attachments; a tool result needed the same.
 */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753" + "de0000000c4944415408d763f8cfc0000003010100" + "18dd8db00000000049454e44ae426082",
  "hex",
);

const ctx = { defaultTimeoutMs: 30_000, maxOutputBytes: 100_000 };

test("a tool image is written to the log, not just described in the text (#images)", async () => {
  await useTempDirs(["imglog-", "imglogd-"], async ([ws, sd]) => {
    await fs.writeFile(path.join(ws!, "red.png"), PNG);
    const agent = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
      chatFn: async (_cfg, messages) => {
        if (!messages.some((m) => m.role === "tool")) {
          return {
            message: {
              role: "assistant",
              content: "reading",
              tool_calls: [
                { id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "red.png" }) } },
              ],
            },
          };
        }
        return { message: { role: "assistant", content: "saw it" } };
      },
      autoContinue: false,
    });
    await agent.init();
    agent.enqueuePrompt("look at red.png", "user");
    agent.start("t");

    let row: { data?: Record<string, unknown> } | undefined;
    let found: unknown;
    await waitFor(
      async () => {
        const evs = await readEvents(agent.log.filePath);
        found = evs.find((e) => e.type === "tool_result" && JSON.stringify(e.data ?? {}).includes("PNG image"));
        row = found as { data?: Record<string, unknown> } | undefined;
        return row !== undefined;
      },
      { what: "the read_file tool_result row" },
    );
    const d = row!.data as { images?: { url: string }[]; result?: string };
    assert.match(String(d.result), /attached to this message/, "the text is there");
    assert.ok(Array.isArray(d.images) && d.images.length > 0, "and so is the image — otherwise restore is a lie");
    // a REFERENCE, not inline base64: the bytes are a file beside chat.jsonl (#blobs)
    assert.match(d.images![0]!.url, /^blobs\/[a-f0-9]{64}\.png$/, "stored by content hash, inside the session");
    await agent.dispose();
  });
});

test("a restored session rebuilds the image part (#images)", async () => {
  await useTempDirs(["imgres-", "imgresd-"], async ([ws, sd]) => {
    await fs.writeFile(path.join(ws!, "red.png"), PNG);
    // first agent: do the read, then die (the session survives)
    const a1 = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
      chatFn: async (_c, messages) =>
        messages.some((m) => m.role === "tool")
          ? { message: { role: "assistant", content: "saw it" } }
          : {
              message: {
                role: "assistant",
                content: "reading",
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "red.png" }) } },
                ],
              },
            },
      autoContinue: false,
    });
    await a1.init();
    a1.enqueuePrompt("look", "user");
    a1.start("t");
    await waitFor(
      async () => (await readEvents(a1.log.filePath)).some((e) => e.type === "tool_result"),
      { what: "the tool result to be logged" },
    );
    await a1.dispose();

    // second agent on the SAME sessionDir: what does the model actually receive?
    let rebuilt: { role: string; content_parts?: { type: string }[] }[] | null = null;
    const a2 = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
      chatFn: async (_c, messages) => {
        rebuilt = messages as never;
        return { message: { role: "assistant", content: "ok" } };
      },
      autoContinue: false,
    });
    await a2.init();
    a2.enqueuePrompt("and now?", "user");
    a2.start("t");
    await waitFor(() => rebuilt !== null, { what: "the restored request" });

    const toolMsg = rebuilt!.find((m) => m.role === "tool");
    assert.ok(toolMsg, "the tool message must be in the restored history");
    assert.ok(
      toolMsg!.content_parts?.some((p) => p.type === "image_url"),
      "the image part must be restored, or the text lies about what the model can see",
    );
    await a2.dispose();
  });
});
