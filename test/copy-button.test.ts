/**
 * #52 — "the Copy buttons on the timeline don't work", reported with:
 *
 *   TypeError: Cannot read properties of undefined (reading 'writeText')
 *
 * `navigator.clipboard` is only exposed in a SECURE context. teapot serves the
 * UI over plain `http://127.0.0.1:7788` by default, so the property is ABSENT
 * there — `navigator.clipboard.writeText(text)` threw synchronously, before any
 * promise existed, so the `.catch()` fallback written underneath it never ran.
 * Every Copy button was dead in the default setup and the execCommand path was
 * unreachable dead code.
 *
 * A second variant matters just as much: some environments (older browsers,
 * embedded webviews, happy-dom) expose a `clipboard` object whose `writeText`
 * is missing or rejects. Treating "the API exists" as "copying works" leaves
 * those silently broken too.
 *
 * The report also asks for visible feedback on success, which the button had but
 * only as a transient glyph with no pending state — worth pinning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * #75: this used to be a MIRROR of the shipped copy strategy, so the suite
 * exercised the mirror while the app ran something else. Deleting the entire
 * `execCommand("copy")` fallback from App.tsx left this file green 11/11 — the #52
 * fix could be half-removed invisibly.
 *
 * `copyText` now lives in `frontend/clipboard.ts` and both App.tsx and this file
 * import it, so the tests drive the code that runs.
 */
import { copyText } from "../frontend/lib/clipboard.ts";
import { fakeStaging } from "./helpers/staging.ts";

/* ---------- the crash itself ---------- */

test("copy works when navigator.clipboard is absent (plain http) (#52)", async () => {
  let exec = 0;
  const got = await copyText("hello", {
    makeTextarea: fakeStaging,
    clipboard: undefined, // ← the reported TypeError case
    execCommand: () => (exec++, true),
  });
  assert.equal(got, "copied", "copy must still work without the clipboard API (#52)");
  assert.equal(exec, 1, "the legacy fallback must actually be reached (#52)");
});

test("copy works when navigator.clipboard is explicitly null (#52)", async () => {
  let exec = 0;
  const got = await copyText("hello", {
    makeTextarea: fakeStaging, clipboard: null, execCommand: () => (exec++, true) });
  assert.equal(got, "copied");
  assert.equal(exec, 1, "a null clipboard must not be treated as usable (#52)");
});

test("copy works when writeText is missing from the clipboard object (#52)", async () => {
  let exec = 0;
  const got = await copyText("hello", {
    makeTextarea: fakeStaging,
    clipboard: {} as never, // present but useless — happy-dom, some webviews
    execCommand: () => (exec++, true),
  });
  assert.equal(got, "copied", "an object without writeText must fall back (#52)");
  assert.equal(exec, 1);
});

/* ---------- the paths that should still work ---------- */

test("copy uses the clipboard API when it is genuinely available (#52)", async () => {
  const written: string[] = [];
  let exec = 0;
  const got = await copyText("payload", {
    makeTextarea: fakeStaging,
    clipboard: { writeText: async (t) => { written.push(t); } },
    execCommand: () => (exec++, true),
  });
  assert.equal(got, "copied");
  assert.deepEqual(written, ["payload"], "the modern path must be preferred (#52)");
  assert.equal(exec, 0, "no legacy fallback needed when the API works (#52)");
});

test("a REJECTING clipboard still falls back to the legacy path (#52)", async () => {
  let exec = 0;
  const got = await copyText("payload", {
    makeTextarea: fakeStaging,
    clipboard: { writeText: async () => { throw new Error("denied"); } },
    execCommand: () => (exec++, true),
  });
  assert.equal(got, "copied", "permission denial must not lose the copy (#52)");
  assert.equal(exec, 1);
});

test("an empty string is refused rather than silently copied (#52)", async () => {
  let exec = 0;
  const got = await copyText("", {
    makeTextarea: fakeStaging, clipboard: undefined, execCommand: () => (exec++, true) });
  assert.equal(got, "unsupported");
  assert.equal(exec, 0, "nothing to copy must not invoke the clipboard (#52)");
});

test("a THROWING execCommand reports failure rather than escaping (#52)", async () => {
  const got = await copyText("x", {
    makeTextarea: fakeStaging,
    clipboard: undefined,
    execCommand: () => {
      throw new Error("blocked by policy");
    },
  });
  assert.equal(got, "failed", "a throwing execCommand must not escape the handler (#52)");
});

test("both paths failing reports a real failure (#52)", async () => {
  const got = await copyText("x", {
    makeTextarea: fakeStaging,
    clipboard: { writeText: async () => { throw new Error("no"); } },
    execCommand: () => false,
  });
  assert.equal(got, "failed", "a genuine failure must be reported, not swallowed (#52)");
});

/* ---------- the legacy path must not leak DOM ---------- */

test("the staging textarea is removed even when execCommand throws (#52)", async () => {
  const ta = fakeStaging();
  await copyText("x", {
    makeTextarea: () => ta,
    clipboard: undefined,
    execCommand: () => {
      throw new Error("blocked by policy");
    },
  });
  assert.equal(ta.removed, 1, "a throw must not leak the invisible staging element (#52)");
});
