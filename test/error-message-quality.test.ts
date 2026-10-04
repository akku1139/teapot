/**
 * #126 — error messages that did not help.
 *
 * Ranked by MEASURED frequency across every session log on this machine, not by
 * taste. The three fixed here are the top offenders that were still present.
 *
 * ## 1. `old_text is required` — hit 22 times in the logs
 *
 * The single most common `edit_file` failure said only that a field was missing,
 * while the tool's own schema already documents the better form. `master.ts:979`
 * had already solved this shape of problem for "not your sub-agent" by naming the
 * real cause and what to do instead; `edit_file` never got the same treatment.
 *
 * ## 2. 24 hand-copied `c.json({ error: "not found" }, 404)`
 *
 * A typo in an agent id, a deleted session and a bad route all produced the same
 * three words, none carrying the id that was looked up — which is the first
 * thing anyone debugging needs, and is already in hand at every one of those
 * sites.
 *
 * ## 3. A filesystem path leaked to the client
 *
 * `safeJoin` throws `"path escapes workspace: /home/user/secret/project/…"`, and
 * the route returned that verbatim, handing the caller the server's directory
 * layout. The rejection is correct; the disclosure was not.
 *
 * ## What was deliberately NOT changed
 *
 * "invalid JSON arguments" appeared 10 times in the logs but no longer exists in
 * the source — #17 replaced it with a repair layer for the five argument shapes
 * models actually get wrong. Widening it again would undo that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tools = readFileSync(new URL("../src/agent/tools.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
const master = readFileSync(new URL("../src/master.ts", import.meta.url), "utf8");

/* ---------- 1. edit_file says what to do instead ---------- */

test("edit_file's missing-old_text error names the alternative (#126)", () => {
  assert.match(
    tools,
    /if \(!oldText\)\s*return \{\s*ok: false,\s*result:/,
    "the guard must return a real message, not a bare string (#126)",
  );
  const i = tools.indexOf("if (!oldText)");
  const body = tools.slice(i, i + 700);
  assert.doesNotMatch(
    body,
    /result:\s*"old_text is required"\s*\}/,
    "the bare form must be gone — it fired 22 times in the logs (#126)",
  );
  assert.match(
    body,
    /line_ids/,
    "the message must name `read_file(line_ids:\"hash\")`, which the schema already offers (#126)",
  );
  assert.match(
    body,
    /line-number prefixes|N\| /,
    "and warn about the `N| ` prefixes, the other half of the mistake (#126)",
  );
});

/* ---------- 2. 404s name the resource and the id ---------- */

test("there is one notFound helper, not 24 copies (#126)", () => {
  assert.match(
    api,
    /const notFound = \(c: Context, what: string, id: string\)/,
    "the helper must exist (#126)",
  );
  assert.match(
    api,
    /\$\{what\} not found: \$\{id \|\| "\(no id given\)"\}/,
    "and must carry BOTH the resource and the id (#126)",
  );
});

test("every agent lookup uses it (#126)", () => {
  const bare = [...api.matchAll(/c\.json\(\{ error: "not found" \}, 404\)/g)];
  // the only remaining literal is inside the helper's own doc comment
  const inCode = bare.filter((m) => {
    const line = api.slice(0, m.index).split("\n").length;
    const text = api.split("\n")[line - 1] ?? "";
    return !text.trim().startsWith("*");
  });
  assert.deepEqual(
    inCode.map((m) => api.slice(0, m.index).split("\n").length),
    [],
    `every 404 must name what was missing (#126); ${inCode.length} bare copies remain`,
  );
  assert.ok(
    [...api.matchAll(/notFound\(c, "agent", /g)].length >= 20,
    "the agent sites must all be converted (#126)",
  );
});

test("the sessions route distinguishes 'no such agent' from 'not yours' (#126)", () => {
  // that route refuses a session belonging to ANOTHER agent, which is a different
  // mistake from a bad id and deserves a different message
  assert.match(
    api,
    /notFound\(c, "session \(or it belongs to another agent\)", sessionId\)/,
    "the cross-agent refusal must not read as a missing id (#126)",
  );
});

/* ---------- 3. no absolute path leaves the server ---------- */

test("a workspace-escape rejection does not leak the absolute path (#126)", () => {
  const i = api.indexOf("abs = safeJoin(a.workspace, rel)");
  assert.notEqual(i, -1, "the safeJoin call must exist (#126)");
  const block = api.slice(i, i + 700);
  assert.doesNotMatch(
    block,
    /error: \(err as Error\)\.message/,
    "safeJoin's message embeds the RESOLVED path — returning it verbatim discloses the server layout (#126)",
  );
  assert.match(
    block,
    /path is outside the workspace: \$\{rel\}/,
    "and the path AS GIVEN must be echoed back instead (#126)",
  );
});

test("the rejection is still a 400, not softened into a success (#126)", () => {
  const i = api.indexOf("abs = safeJoin(a.workspace, rel)");
  assert.match(api.slice(i, i + 700), /\}, 400\);/, "the status must stay 400 (#126)");
});

/* ---------- the pattern to follow is already in the codebase ---------- */

test("the fix follows the pattern master.ts already uses (#126)", () => {
  // "not your sub-agent" was turned from a confusing refusal into a
  // re-addressable one by naming the real owner. edit_file now does the same.
  assert.match(
    master,
    /not your sub-agent: \$\{childId\}\.\$\{detail\}/,
    "the precedent must still hold (#126)",
  );
  assert.match(master, /message @\$\{actual\} instead/, "which names what to do (#126)");
});