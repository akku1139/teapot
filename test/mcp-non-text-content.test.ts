import assert from "node:assert/strict";
import test from "node:test";
import { resultText } from "../src/agent/mcp.ts";

test("an MCP image becomes a data URL the model can actually see (#203)", () => {
  /**
   * "MCPクライアントでテキスト以外のサポートちゃんと実装できてるのかな / 画像とか". It was not: every non-text block
   * was replaced with "[image content omitted]", so a server answering with a chart or a screenshot gave the model
   * nothing.
   */
  const out = resultText({
    content: [
      { type: "text", text: "here is the chart" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
  });
  assert.equal(out.ok, true);
  assert.equal(out.images.length, 1);
  assert.match(out.images[0]!.url, /^data:image\/png;base64,aGVsbG8=$/);
  assert.match(out.images[0]!.name, /\.png$/, "the name keeps the extension the MIME implies");
  assert.match(out.text, /here is the chart/);
  assert.match(out.text, /\[image: image\/png, \d+KB\]/, "the text still says an image was there");
});

test("only the first image is attached, and the rest are counted", () => {
  // one attachment is what the tool-result plumbing carries; silently dropping the others would be worse
  const out = resultText({
    content: [
      { type: "image", data: "YQ==", mimeType: "image/jpeg" },
      { type: "image", data: "Yg==", mimeType: "image/jpeg" },
      { type: "image", data: "Yw==", mimeType: "image/jpeg" },
    ],
  });
  assert.equal(out.images.length, 1, "exactly one data URL");
  assert.match(out.text, /\+2 more image\(s\)/);
});

test("embedded resources, audio and unknown blocks are described, not dropped", () => {
  const textRes = resultText({ content: [{ type: "resource", resource: { uri: "file://a.txt", text: "contents" } }] });
  assert.match(textRes.text, /contents/);
  const blob = resultText({ content: [{ type: "resource", resource: { uri: "file://b.pdf", blob: "eA==", mimeType: "application/pdf" } }] });
  assert.match(blob.text, /resource application\/pdf/);
  assert.match(blob.text, /file:\/\/b\.pdf/);
  const audio = resultText({ content: [{ type: "audio", data: "eA==", mimeType: "audio/wav" }] });
  assert.match(audio.text, /audio: audio\/wav/);
  assert.match(audio.text, /not readable/i, "and says the model cannot consume it, rather than implying it can");
  const unknown = resultText({ content: [{ type: "video", data: "eA==" } as never] });
  assert.match(unknown.text, /\[video content/);
});

test("text-only results and errors are unchanged", () => {
  assert.deepEqual(resultText({ content: [{ type: "text", text: "ok" }] }).images, []);
  assert.equal(resultText({ content: [{ type: "text", text: "ok" }] }).text, "ok");
  assert.equal(resultText({ content: [], isError: true }).ok, false);
  assert.equal(resultText({ content: [] }).text, "(no content)");
});
