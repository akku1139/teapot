import { test } from "node:test";
import assert from "node:assert/strict";

import { copyText } from "../frontend/lib/clipboard.ts";
import { fakeStaging } from "./helpers/staging.ts";

test("copy works when navigator.clipboard is absent (plain http) (#52)", async () => {
  let exec = 0;
  const got = await copyText("hello", {
    makeTextarea: fakeStaging,
    clipboard: undefined, 
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
    clipboard: {} as never, 
    execCommand: () => (exec++, true),
  });
  assert.equal(got, "copied", "an object without writeText must fall back (#52)");
  assert.equal(exec, 1);
});

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
