/**
 * #108 — "scroll-follow detaches after automatic compaction."
 *
 * ## Cause
 *
 * The compaction banner renders INSIDE the feed (App.tsx:3211), so the pass
 * changes the feed's height twice:
 *
 *   phase start  -> banner APPEARS  -> feed taller by one row
 *   phase done   -> banner REMOVED  -> feed shorter by one row
 *
 * While the summarizer streams, the follow effect at App.tsx:616 keeps the bottom
 * pinned — it keys on `liveText()` / `live().reasoning`, and the `[compact] …`
 * bubble makes both non-empty.
 *
 * On `phase: done` two things happen at once:
 *
 *   1. `setCompacting(null)` removes the banner, and
 *   2. line 522 clears the `[compact] ` live text.
 *
 * So the follow effect's own guard now reads `if (!txt && !rsn) return;` — it
 * bails on the one frame that mattered, and never re-pins. The feed just got
 * SHORTER, so the reader is left above the bottom with follow mode still `true`
 * in the signal. Nothing looks wrong: the caret still points down, the jump
 * button is still there, and no error was logged.
 *
 * A `ResizeObserver` on the feed would catch both directions; the existing
 * per-row `onResize` cannot, because it only fires when the operator opens a
 * `<details>` (App.tsx:4563), and a compaction the operator never touched is
 * exactly the case that breaks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

/* ---------- the banner really does live inside the feed ---------- */

test("the compaction banner is rendered inside the scrollable feed (#108)", () => {
  // if it sat outside the feed it could not change the scroll height at all
  const banner = app.indexOf('<Show when={compacting()}>');
  assert.notEqual(banner, -1, "the banner must exist (#108)");
  const scroll = app.indexOf("onscroll");
  assert.ok(scroll !== -1 && scroll < banner, "the scroll container must precede the banner (#108)");
  // …and the banner is a sibling of the event rows, so it is part of the flow
  const rows = app.indexOf("{chatEvents().length > 0} fallback={");
  assert.ok(rows > banner, "the banner sits with the rows, not after them (#108)");
});

/* ---------- the follow effect bails exactly when it must not ---------- */

test("the follow effect early-returns on empty live text and reasoning (#108)", () => {
  // This is the mechanism. On `phase: done` both are cleared, so the effect that
  // keeps the bottom pinned never runs for that frame.
  // Anchor on the LIVE follow effect, not on the first match — #108's fix adds a
  // second effect that also guards on atBottom(), and searching for the bare
  // guard text finds whichever comes first in the file.
  const effect = app.indexOf("const txt = liveText();");
  assert.notEqual(effect, -1, "the live follow effect must exist (#108)");
  const block = app.slice(effect, effect + 300);
  assert.match(block, /if \(!txt && !rsn\) return;/, "it bails on empty text AND reasoning (#108)");
  assert.match(block, /const rsn = live\(\)\?\.reasoning \?\? "";/, "keyed on live text (#108)");
});

test("finishing a compaction clears BOTH the banner and the live text (#108)", () => {
  // two height changes at once, with the follow effect disarmed by the second
  assert.match(
    app,
    /if \(msg\.phase === "done"\) setCompacting\(null\);/,
    "the banner goes away on done (#108)",
  );
  assert.match(
    app,
    /if \(!compacting\(\)\) setLive\(\(l\) => \(l\?\.text\.startsWith\("\[compact\] "\) \? null : l\)\);/,
    "and the [compact] live text is cleared at the same moment (#108)",
  );
});

/* ---------- the fix ---------- */

test("the feed re-pins after a compaction pass, in both directions (#108)", () => {
  // The fix is an explicit follow-up keyed on `compacting()`, because nothing
  // else runs on that transition.
  const at = app.indexOf("setCompacting(null)");
  assert.notEqual(at, -1, "the done transition must exist (#108)");
  // the re-pin must be a separate effect on the compaction state, not inside the
  // WS handler alone (the banner can also appear from a restored snapshot)
  assert.match(
    app,
    /createEffect\(\(\) => \{[\s\S]{0,400}?compacting\(\)[\s\S]{0,400}?atBottom\(\)[\s\S]{0,300}?scrollBottom\(true\)/,
    "an effect must re-pin when the compaction banner appears or disappears (#108)",
  );
});

test("the re-pin respects a reader who had scrolled away (#108)", () => {
  // anchor on the #108 marker, then take the effect that follows it
  const at = app.indexOf("#108: re-pin the feed");
  assert.notEqual(at, -1, "the fix must be present (#108)");
  const start = app.indexOf("createEffect", at);
  const block = app.slice(start, app.indexOf("});", app.indexOf("scrollBottom(true)", start)) + 4);
  assert.match(
    block,
    /if \(!atBottom\(\)\) return;/,
    "compaction must not yank a reader who is reading history (#108)",
  );
  assert.match(block, /void compacting\(\);/, "and it must key on the banner (#108)");
});