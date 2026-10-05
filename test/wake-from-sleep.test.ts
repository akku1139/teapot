/**
 * #139 — "after being offline for a long time (e.g. the PC sleeps) I have to hit
 * the API to get the session content back."
 *
 * ## Why waking did nothing
 *
 * The tab-visibility handler only refetched when `pendingRefresh` was already set,
 * and that flag is set by the HIDDEN-TAB branch of the WS handler. A machine
 * waking from SLEEP is a different case: the tab was never hidden, so no event
 * arrived to set the flag and the handler did nothing at all.
 *
 * Whether the socket recovers is luck:
 *
 *  - the server's 30s liveness reaper closed it → `onclose` → reconnect →
 *    `catchUpAfterReconnect()` fetches the gap. Works.
 *  - the sleep left the TCP connection apparently ALIVE → no close, no reconnect,
 *    and the timeline stays frozen at whatever it held when the lid shut.
 *
 * The second is the reported case, and it is why reloading fixed it: a reload
 * refetches the log from scratch, which is exactly the thing the tab could have
 * done for itself.
 *
 * The fix: returning to visible VERIFIES rather than assumes. The `?after=` cursor
 * makes it proportional — a tab that slept a minute and missed nothing pays one
 * cheap request that returns empty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readSource(path.join(here, "..", "frontend", "App.tsx"));

/** the body assigned to onTabVisible */
function onVisible(): string {
  const at = app.indexOf("onTabVisible = () => {");
  assert.notEqual(at, -1, "onTabVisible must be assigned (#139)");
  return app.slice(at, app.indexOf("\n    };", at));
}

test("waking from sleep fetches what we missed (#139)", () => {
  const b = onVisible();
  assert.match(
    b,
    /void catchUpAfterReconnect\(\)/,
    "returning to visible must ask for the gap, unconditionally (#139)",
  );
});

test("waking fetches on EVERY visible path that has work to recover (#139)", () => {
  // #141: my first two versions of this file asserted the FIX rather than the
  // absence of the BUG — restoring the original gate left them green. This one
  // enumerates the branch's exits and checks each one, which is what a reviewer
  // would do by hand.
  //
  // The branch has exactly three legitimate exits:
  //   hidden          -> no-op (layout is paused)
  //   nothing selected -> no-op (there is no timeline)
  //   everything else  -> MUST have fetched
  const b = onVisible();
  assert.match(b, /visibilityState !== "visible"\) return;/, "hidden must no-op (#139)");

  // the visible portion: after the hidden guard
  const hiddenAt = b.indexOf('visibilityState !== "visible"');
  assert.notEqual(hiddenAt, -1, "the hidden guard must exist (#139)");
  // slice by REGEX, not by an exact string: the #139 mutation inserts a line
  // right after this guard, and an exact-text slice silently swallowed it — which
  // is why restoring the original bug passed twice.
  const hiddenLineEnd = b.indexOf("\n", hiddenAt);
  const visible = b.slice(hiddenLineEnd);

  // Enumerate EVERY `return` in the visible branch and attribute it to its guard.
  //
  // Both forms must be handled: a braced block and a braceless `if (…) return;`.
  // An earlier version of this test matched only the braced form, so the mutation
  // `if (!pendingRefresh) return;` — which is BRACELESS, and is the exact #139 bug —
  // left it green. Verified: it is now caught.
  const returns = [...visible.matchAll(/return;/g)];
  assert.ok(returns.length > 0, "precondition: the visible branch returns somewhere (#139)");
  for (const r of returns) {
    const before = visible.slice(0, r.index);
    // the innermost enclosing guard: the text from the last `if (` before this return
    const lastIf = before.lastIndexOf("if (");
    const cond = lastIf === -1 ? "" : before.slice(lastIf, before.indexOf(")", lastIf) + 1);
    // has a fetch happened between that guard and this return?
    const afterGuard = lastIf === -1 ? before : before.slice(before.indexOf(")", lastIf) + 1);
    const fetched = /runFeedRefresh\(\)|catchUpAfterReconnect\(/.test(afterGuard);
    // these two legitimately do nothing: nothing is hidden, nothing is selected
    const legitimatelyEmpty =
      /visibilityState/.test(cond) || /!id\b|!selected\b/.test(cond);
    assert.ok(
      fetched || legitimatelyEmpty,
      `a return guarded by \`${cond}\` performs no fetch (#139) — waking through that path leaves the timeline stale`,
    );
  }

  // the exact gate the original bug used
  assert.doesNotMatch(
    b,
    /if \(!pendingRefresh\) return;/,
    "this IS the #139 bug — a sleep never sets pendingRefresh (#139)",
  );
  // and the branch must terminate in a fetch
  assert.match(
    visible.trimEnd(),
    /void catchUpAfterReconnect\(\);\s*$/m,
    "the visible branch must end by fetching the gap (#139)",
  );
});

test("it does NOT depend on pendingRefresh having been set (#139)", () => {
  // THE bug. `pendingRefresh` is set only by the hidden-tab branch, which a sleep
  // never triggers — so gating on it made waking a no-op.
  const b = onVisible();
  const gated = /if \(pendingRefresh\) \{[\s\S]{0,400}?return;[\s\S]{0,200}?catchUpAfterReconnect/.test(b);
  const bare = /if \(pendingRefresh\) \{[\s\S]{0,400}?return;\s*\}\s*(?:[\s\S]{0,400}?)?\/\*|if \(pendingRefresh\) \{[\s\S]{0,400}?return;\s*\}\s*$/m.test(b);
  assert.equal(
    gated,
    false,
    "the catch-up must be reachable when pendingRefresh is FALSE (#139)",
  );
  assert.ok(
    !/document\.visibilityState !== "visible"\) return;\s*if \(pendingRefresh\)[\s\S]{0,200}?\n\s*\}\s*void catchUp/.test(b),
    "and the visible check must not short-circuit the rest (#139)",
  );
  // positive form: the catch-up sits AFTER the pendingRefresh branch, at the end
  assert.match(
    b,
    /if \(pendingRefresh\)[\s\S]*?return;[\s\S]*?catchUpAfterReconnect\(\)/,
    "the unconditional catch-up must follow the conditional refresh (#139)",
  );
});

test("with no cursor at all it still recovers (#139)", () => {
  // a session switch while the tab was away leaves nothing to anchor on; that
  // must be a full load, not a silent no-op
  const b = onVisible();
  assert.match(b, /if \(!cursor\)/, "a missing cursor must be handled (#139)");
  const after = b.slice(b.indexOf("if (!cursor)"));
  assert.match(after, /runFeedRefresh\(\)/, "and must fall back to a full refresh (#139)");
});

test("the hidden case still returns immediately (#139)", () => {
  // polling while the tab is hidden is pure waste — layout is paused
  assert.match(onVisible(), /visibilityState !== "visible"\) return;/, "hidden tabs must no-op (#139)");
});

test("the socket's liveness ping exists to make recovery likely (#79)", async () => {
  // context for why the old behaviour was "sometimes works": the server reaps a
  // socket that misses a 30s ping, which fires onclose and so recovers. The gap
  // is the case where the socket looks alive.
  const { readFileSync } = await import("node:fs");
  const api = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
  assert.match(api, /kind: "ping"/, "the server must ping (#79)");
  assert.match(api, /unresponsive/, "and reap a client that misses the pong (#79)");
});
