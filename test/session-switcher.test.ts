/**
 * Past sessions of an agent are unreachable from the UI, and the attempt to
 * reach one by URL silently lands somewhere else.
 *
 * One agent accumulates a session directory per incarnation
 * (`resolveSessionDir(..., {fresh:true})` mints `<id>-<uuid>`), and
 * `GET /api/sessions` already returns every one of them. But `select()` takes an
 * AGENT id and resolves it with `latestSessionOf()` — the newest session that
 * agent happens to own — so `/session/alpha-s1` opens whatever session is
 * currently bound, and then `navigate()` REWRITES the URL to match. The
 * bookmark silently points at a different conversation than the one requested.
 *
 * `popstate` has the same gap: it only calls `select()` when the owning agent
 * differs from the current selection, so Back/Forward between two sessions of
 * the SAME agent does nothing at all.
 *
 * This file pins the resolution rule. The UI-side work that consumes it (a
 * session switcher) is separate; what matters here is that the rule stops
 * discarding an explicitly requested session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

function srcHas(label: string, re: RegExp): void {
  if (!re.test(app)) assert.fail(`${label}\n  expected source to match: ${re}`);
}

/**
 * mirror of the shipped resolution, with the fix: an EXPLICITLY requested
 * session wins, and it is only honoured when the agent really owns it.
 */
export function resolveSession(
  agentId: string,
  sessionsOfAgent: string[], // newest first, as the server returns them
  bound: string | null | undefined,
  requested?: string | null,
): string | null {
  // a deep link / explicit choice is authoritative — but only if this agent
  // actually owns it, so a crafted URL cannot cross into another agent
  if (requested && sessionsOfAgent.includes(requested)) return requested;
  if (bound && sessionsOfAgent.includes(bound)) return bound;
  return sessionsOfAgent[0] ?? null;
}

const sessions = ["alpha-s9", "alpha-s2", "alpha-s1"]; // newest first
const bound = "alpha-s2";

/* ---------- the bug ---------- */

test("an explicitly requested session is honoured (#58)", () => {
  assert.equal(
    resolveSession("alpha", sessions, bound, "alpha-s1"),
    "alpha-s1",
    "a deep link to alpha-s1 must open alpha-s1 (#58)",
  );
});

test("with no request, the bound session still wins (#58)", () => {
  assert.equal(resolveSession("alpha", sessions, bound), "alpha-s2", "the bound session is the default (#58)");
  assert.equal(resolveSession("alpha", sessions, null), "alpha-s9", "no bound → newest (#58)");
  assert.equal(resolveSession("alpha", [], bound), null, "no sessions at all → null (#58)");
});

test("a request for a session the agent does NOT own is refused (#58)", () => {
  assert.equal(
    resolveSession("alpha", sessions, bound, "beta-s1"),
    "alpha-s2",
    "a crafted URL must not cross into another agent's session (#58)",
  );
});

/* ---------- wiring ---------- */

test("select() can be told which session to open (#58)", () => {
  // #75: this matched `select\([^)]*forceSession`, which is satisfied by the
  // function DECLARATION — so it could not tell a parameterised select from a
  // plain one, and would have passed on any file that merely mentioned the name.
  //
  // The signature is now matched exactly, and a CALL SITE that actually passes
  // the session is required too — a parameter nobody supplies is not a feature.
  const decl = app.match(/(?:async\s+)?function\s+select\s*\([^)]*\)/);
  assert.ok(decl, "select() must be declared as a function (#58)");
  assert.match(
    decl[0],
    /forceSession\??\s*:\s*string/,
    `select() must take an optional session parameter (#58); got ${decl[0]}`,
  );
  // and something must actually pass it
  const calls = app.match(/select\([^)]*\)/g) ?? [];
  const passesSession = calls.filter((c) => /,\s*(false|true),?\s*[A-Za-z_$]/.test(c) || /,\s*[A-Za-z_$][\w$]*\s*[,)]/.test(c));
  assert.ok(
    passesSession.length > 0,
    `at least one call site must forward a session (#58); calls seen: ${JSON.stringify(calls.slice(0, 6))}`,
  );
});

test("the deep link passes the URL's session through (#58)", () => {
  const block = app.slice(app.indexOf("if (initial) select(") - 400, app.indexOf("if (initial) select(") + 120);
  srcHas("onMount must forward the requested session, not just the agent (#58)", /select\([^)]*,\s*(false|true),?\s*want|want\s*\)?\s*[,)]/);
  assert.doesNotMatch(
    block,
    /select\(initial\.id,\s*false\)\s*;/,
    "select(initial.id) alone DISCARDS the deep-linked session (#58)",
  );
});

test("popstate must act even when the agent is already selected (#58)", () => {
  const block = app.slice(app.indexOf('window.addEventListener("popstate"'));
  const chunk = block.slice(0, 400);
  assert.doesNotMatch(
    chunk,
    /owner && owner !== selected\(\)/,
    "guarding popstate on `owner !== selected()` makes Back/Forward a no-op between two sessions of the SAME agent (#58)",
  );
});
