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
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

/**
 * Mirror of the shipped copy strategy, extracted so each environment is under
 * test rather than just described.
 */
export async function copyText(
  text: string,
  env: {
    clipboard?: { writeText?: (t: string) => Promise<void> } | null;
    execCommand: (c: string) => boolean;
  },
): Promise<"copied" | "unsupported" | "failed"> {
  if (!text) return "unsupported";
  // the fix: feature-DETECT the method, never assume the object is there
  const writeText = env.clipboard?.writeText;
  if (typeof writeText === "function") {
    try {
      await writeText.call(env.clipboard, text);
      return "copied";
    } catch {
      /* fall through to the legacy path — permission denied, insecure frame */
    }
  }
  // legacy path, used when the API is missing OR refused
  try {
    return env.execCommand("copy") ? "copied" : "failed";
  } catch {
    return "failed";
  }
}

function srcHas(label: string, re: RegExp): void {
  if (!re.test(app)) assert.fail(`${label}\n  expected source to match: ${re}`);
}

/* ---------- the crash itself ---------- */

test("copy works when navigator.clipboard is absent (plain http) (#52)", async () => {
  let exec = 0;
  const got = await copyText("hello", {
    clipboard: undefined, // ← the reported TypeError case
    execCommand: () => (exec++, true),
  });
  assert.equal(got, "copied", "copy must still work without the clipboard API (#52)");
  assert.equal(exec, 1, "the legacy fallback must actually be reached (#52)");
});

test("copy works when navigator.clipboard is explicitly null (#52)", async () => {
  let exec = 0;
  const got = await copyText("hello", { clipboard: null, execCommand: () => (exec++, true) });
  assert.equal(got, "copied");
  assert.equal(exec, 1, "a null clipboard must not be treated as usable (#52)");
});

test("copy works when writeText is missing from the clipboard object (#52)", async () => {
  let exec = 0;
  const got = await copyText("hello", {
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
    clipboard: { writeText: async () => { throw new Error("denied"); } },
    execCommand: () => (exec++, true),
  });
  assert.equal(got, "copied", "permission denial must not lose the copy (#52)");
  assert.equal(exec, 1);
});

test("an empty string is refused rather than silently copied (#52)", async () => {
  let exec = 0;
  const got = await copyText("", { clipboard: undefined, execCommand: () => (exec++, true) });
  assert.equal(got, "unsupported");
  assert.equal(exec, 0, "nothing to copy must not invoke the clipboard (#52)");
});

test("both paths failing reports a real failure (#52)", async () => {
  const got = await copyText("x", {
    clipboard: { writeText: async () => { throw new Error("no"); } },
    execCommand: () => false,
  });
  assert.equal(got, "failed", "a genuine failure must be reported, not swallowed (#52)");
});

/* ---------- wiring: the shipped code must match the mirror ---------- */

test("the shipped handler feature-detects before calling writeText (#52)", () => {
  // the crash: `navigator.clipboard.writeText(...)` with no guard at all
  srcHas(
    "the handler must check clipboard exists / writeText is callable (#52)",
    /clipboard\?\.writeText/,
  );
  srcHas("and must verify it is actually a function before calling (#52)", /typeof\s+writeText\s*===\s*["']function["']/);
  // and must not chain straight off a possibly-undefined object. Scoped to
  // CODE lines only: the fix's comment quotes the old chain verbatim to
  // explain why it was wrong, and matching that would be nonsense.
  const code = app
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(
    code,
    /\bnavigator\.clipboard\s*\n?\s*\.writeText\(/,
    "the unguarded navigator.clipboard.writeText(...) chain is the reported crash (#52)",
  );
});

test("the legacy execCommand fallback is reachable (#52)", () => {
  srcHas("the execCommand fallback must exist (#52)", /execCommand\("copy"\)/);
});
