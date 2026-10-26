import { test } from "node:test";
import assert from "node:assert/strict";
import { blobUrl, blobName } from "../frontend/lib/blob-url.ts";

/**
 * A logged `blobs/<hash>` reference is a STORED path, not a browser path.
 *
 * MEASURED on v0.37.73: `<img src="blobs/3220fc….png">` resolved against `/session/blobs/…`, the
 * server 404'd, and every attachment and tool image on the timeline rendered broken
 * (`naturalWidth: 0`). Moving bytes out of `chat.jsonl` is right; leaving the reference in `src=` is
 * what broke the display.
 */
const HASH = "3220fc7838ccdab0a3a21b5d8498275c7abe6930abbb059e9fdb4939bba8c2fd";

test("a blobs reference becomes an agent-scoped API URL (#blobs)", () => {
  assert.equal(blobUrl("a1", `blobs/${HASH}.png`), `/api/agents/a1/blobs/${HASH}.png`);
});

test("anything already loadable is untouched (#blobs)", () => {
  // remote images and older inline data URLs must keep rendering
  assert.equal(blobUrl("a1", "https://x/y.png"), "https://x/y.png");
  const inline = "data:image/png;base64,AAAA";
  assert.equal(blobUrl("a1", inline), inline);
});

test("with no agent the reference is not mangled into a wrong URL (#blobs)", () => {
  // better a 404 than a URL pointing at some OTHER agent's bytes
  assert.equal(blobUrl(undefined, `blobs/${HASH}.png`), `blobs/${HASH}.png`);
});

test("blobName refuses anything that is not a bare stored name (#blobs)", () => {
  assert.equal(blobName(`blobs/${HASH}.png`), `${HASH}.png`);
  assert.equal(blobName("blobs/../../etc/passwd"), null);
  assert.equal(blobName("blobs/sub/dir.png"), null);
  assert.equal(blobName("https://x/y.png"), null);
});
