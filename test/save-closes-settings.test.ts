/**
 * A successful save closes the settings dialog — in EVERY case.
 *
 * Reported: "appearanceを編集してsave settingsをしても設定ウィンドウが閉じないのに、他のとこでは設定
 * ウィンドウが閉じる(多分閉じる方が想定の挙動だよね?)".
 *
 * The cause was the OAuth-notice branch: when a saved MCP server merely NEEDED a grant, that branch
 * showed a hint and skipped `onClose()`, so the same button behaved differently depending on what
 * else happened to be true. The hint is the whole message — keeping the dialog open added nothing
 * and made the outcome section-dependent.
 *
 * A source-level assertion, which is the available option: this is control flow inside a Solid
 * component whose only observable is "did the modal unmount", and the smoke harness stubs no OAuth
 * server. The check is that `onClose()` is NOT inside the `needsAction` branch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

test("the OAuth notice does not keep the settings dialog open (#ui)", async () => {
  const app = await readSource("frontend/components/ConfigModal.tsx");
  const save = app.slice(app.indexOf("const newlyNeeding = needing.filter"), app.indexOf("    } catch (ex) {\n      setErr((ex as Error).message);\n      setSaveState(\"error\")"));
  assert.ok(save.length > 0, "precondition: the save tail must be locatable");

  // the hint is shown…
  assert.match(save, /flashHint\(/, "the operator still needs to be told authorization is required");

  /**
   * …and the close is OUTSIDE that branch. Depth-counting braces is the honest way here: the
   * `if (needsAction) { … }` block must end before `onClose()` appears, or the dialog stays open.
   */
  const branchStart = save.indexOf("if (needsAction) {");
  assert.ok(branchStart >= 0, "precondition: the needsAction branch exists");
  let depth = 0;
  let branchEnd = -1;
  for (let i = branchStart; i < save.length; i++) {
    if (save[i] === "{") depth++;
    else if (save[i] === "}") {
      depth--;
      if (depth === 0) {
        branchEnd = i;
        break;
      }
    }
  }
  const closeAt = save.indexOf("props.onClose()");
  assert.ok(closeAt > branchEnd, "onClose() must run for every successful save, not only some");
  /**
   * …and UNCONDITIONALLY. `if (!needsAction) props.onClose()` also sits past the branch, so position
   * alone does not catch it — the call must not be guarded by the OAuth state at all.
   */
  // the whole enclosing `setTimeout(() => { … })` before the call, not just the previous line
  const windowStart = save.lastIndexOf("setTimeout(", closeAt);
  const before = save.slice(windowStart >= 0 ? windowStart : Math.max(0, closeAt - 300), closeAt);
  assert.doesNotMatch(
    before,
    /if\s*\([^)]*needsAction[^)]*\)/,
    "onClose() must not be conditional on the OAuth notice",
  );
});
