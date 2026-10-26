import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * A prompt's attached images must render as `src="<url>"`, not `src="[object Object]"`.
 *
 * MEASURED on a real prompt row: `Agent.enqueuePrompt` writes
 * `images: [{ url, name }]` into the log, and the renderer passed each entry straight to `src=` — so
 * the attachment box showed a broken image with the literal text `[object Object]`.
 *
 * The mapping lives here rather than only in the component so it can be driven: the bug was a TYPE
 * mismatch the compiler could not see (the component declared `string[]` and the data was an object
 * array), which is exactly the kind of thing a value-level test catches and `tsc` does not.
 */
const sourcesOf = (images: unknown): string[] =>
  (Array.isArray(images) ? images : [])
    .map((i: unknown) => (typeof i === "string" ? i : (i as { url?: unknown })?.url))
    .filter((u: unknown): u is string => typeof u === "string" && u.length > 0);

test("the logged `{url, name}` shape becomes a usable src (#images)", () => {
  assert.deepEqual(sourcesOf([{ url: "data:image/png;base64,AAA", name: "a.png" }]), ["data:image/png;base64,AAA"]);
  assert.deepEqual(
    sourcesOf([{ url: "u1" }, { url: "u2", name: "b.png" }]),
    ["u1", "u2"],
    "every attachment renders, in order",
  );
});

test("older plain-string entries still work (#images)", () => {
  // the log may hold either shape across versions; neither must break the row
  assert.deepEqual(sourcesOf(["data:image/png;base64,OLD"]), ["data:image/png;base64,OLD"]);
  assert.deepEqual(sourcesOf(["u1", { url: "u2" }]), ["u1", "u2"], "and they can be mixed");
});

test("nothing usable produces no <img> at all (#images)", () => {
  // the reported symptom was an image ELEMENT with a broken src; absence must mean no element
  assert.deepEqual(sourcesOf(undefined), []);
  assert.deepEqual(sourcesOf([]), []);
  assert.deepEqual(sourcesOf([{ name: "no-url.png" }]), [], "an entry with no url is not a src");
  assert.deepEqual(sourcesOf([{ url: "" }]), [], "and neither is an empty one");
  assert.deepEqual(sourcesOf([null, 42]), [], "garbage does not become [object Object]");
});
