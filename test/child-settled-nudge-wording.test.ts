/**
 * #135 — `[harness] @tyb2-5-sub-musb is now idle. Continue your task, or finish()
 * if the work is done.` is, on reflection, meaningless.
 *
 * ## Why it was wrong, not merely unclear
 *
 * Two distinct errors:
 *
 *  1. **It was addressed to the wrong agent.** "Continue your task, or finish()" is
 *     an instruction to the PARENT — but the parent did not spawn this child to
 *     make progress on its OWN goal, and when the child DID call `finish()` the
 *     parent already receives a proper `Sub-agent X finished. Final report: …`
 *     (`finished. Final report:` in master.ts). So the nudge restated as an
 * instruction what the report
 *     already stated as fact, and invited the parent to `finish()` its own goal
 *     over a child's status change.
 *
 *  2. **It contradicted what actually happens.** Reaching this nudge means the
 *     child has settled WITHOUT calling `finish()` — so there is no report, and
 *     "continue your task" is addressed to a child nobody is about to resume.
 *
 * The replacement says what happened, and what to do about it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { Master } from "../src/master.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

/** a parent with one child; returns the prompts the parent receives */
async function tree() {
  const dataDir = mkdtempInRootSync("t135a-");
  const ws = mkdtempInRootSync("t135w-");
  const m = new Master(
    { port: 0, dataDir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, providers: {}, agents: [] },
    path.join(dataDir, "config.json"),
  );
  const parent = await m.addAgent({ id: "p1", workspace: ws }, { persist: true });
  await m.spawnChildFor(parent, { task: "investigate X", context: "none" });
  const kid = m.agents.get("p1-sub")!;
  const got: string[] = [];
  const orig = parent.enqueuePrompt.bind(parent);
  parent.enqueuePrompt = (t: string, s?: string, i?: unknown) => {
    got.push(String(t));
    return orig(t, s, i as never);
  };
  const stop = async () => {
    for (const a of [...m.agents.values()]) a.stop("done");
    for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
  };
  return { m, parent, kid, got, stop };
}

/**
 * The nudge the parent sees when the child settles in `status`.
 *
 * A FRESH tree per status: `setStatus` is a no-op when the status is unchanged,
 * so asking one tree for `idle` then `stopped` would silently re-report `idle` —
 * which is exactly what happened the first time this was written.
 */
async function nudgeFor(status: string): Promise<string> {
  const { m, kid, got, stop } = await tree();
  try {
    (m as unknown as { reportedRunning: Set<string> }).reportedRunning.add("p1-sub");
    // Force a real transition. The child starts `stopped`, and `setStatus` is a
    // no-op when the status is unchanged — so parking it on `idle` first (which
    // my first attempt did for every status except `stopped`) meant asking for
    // `idle` afterwards changed nothing and the nudge still read `idle`.
    //
    // `running` is the one value no settled status equals, so it is always a real
    // transition. It is also the state that ARMS the #130 gate, which is what we
    // want anyway.
    const set = (kid as unknown as { setStatus(s: string, r?: string): void }).setStatus.bind(kid);
    set("running", "precondition");
    await new Promise((r) => setTimeout(r, 30));
    got.length = 0; // drop anything the precondition transition produced
    set(status, "test");
    await new Promise((r) => setTimeout(r, 150));
    // got[0] is the SPAWN DIRECTIVE; the settled-nudge is the LAST message
    return got.at(-1) ?? "";
  } finally {
    await stop();
  }
}

test("the nudge no longer tells the PARENT to finish() (#135)", async () => {
  const nudge = await nudgeFor("idle");
  assert.ok(nudge.length > 0, "precondition: the parent is told something (#135)");
  assert.doesNotMatch(
    nudge,
    /Continue your task/,
    `#135: that instruction is addressed to the parent, which is not what the message is about — got ${nudge}`,
  );
  assert.doesNotMatch(
    nudge,
    /or finish\(\) if the work is done/,
    `and it invited the parent to finish() its OWN goal over a child's status (#135) — got ${nudge}`,
  );
});

test("it says the child did NOT call finish() (#135)", async () => {
  const nudge = await nudgeFor("idle");
  // reaching this nudge means the child settled WITHOUT finish(), which is the
  // one fact the parent most needs and the old wording hid
  assert.match(
    nudge,
    /without having called finish\(\)/,
    `the absence of a report is the point (#135); got ${nudge}`,
  );
  assert.match(nudge, /has not reported a result/, "and says so plainly (#135)");
});

test("it is prefixed and names the sub-agent (#135)", async () => {
  const nudge = await nudgeFor("idle");
  assert.ok(nudge.startsWith("[harness] "), "must be identifiable as harness text (#135)");
  assert.match(nudge, /Sub-agent @p1-sub/, "and name the child (#135)");
});

test("each status gets advice that fits it (#135)", async () => {
  const stopped = await nudgeFor("stopped");
  assert.match(stopped, /stopped mid-task/, `stopped means resume-or-respawn (#135); got ${stopped}`);
  // an `error` child is announced by its own error event instead (#245) — see the check below

  // and neither contradicts itself: no "stopped" phrasing on a waiting child
  const waiting = await nudgeFor("waiting");
  assert.doesNotMatch(
    waiting,
    /stopped without calling/,
    `the old wording read "is now waiting — it stopped" (#135); got ${waiting}`,
  );
});


/**
 * An `error` child is announced ONCE (#245).
 *
 * "サブエージェントがエラー落ちしたときの親への通知がびみょい" — the parent received BOTH "Sub-agent X hit an error: AiError: …"
 * (from the child's error event) and the generic "is now error without having called finish()" note. The second adds
 * nothing: the error text is the useful part, and the generic note is for statuses that have no event of their own.
 */
test("a child that died with an error does not also get the generic settled note (#245)", async () => {
  const nudge = await nudgeFor("error");
  assert.doesNotMatch(
    nudge,
    /without having called finish\(\)/,
    `the error event is the notification; the generic note only repeats it (#245) — got ${nudge}`,
  );
});

test("stopped and idle still get it, because nothing else announces them (#245)", async () => {
  for (const status of ["idle", "stopped"]) {
    const nudge = await nudgeFor(status);
    assert.match(nudge, /without having called finish\(\)/, `${status} has no event of its own; got ${nudge}`);
  }
});

/**
 * A child that DID call `finish()` must not also be announced as "idle without having called finish()".
 *
 * MEASURED (#259): `finish` logs its final message and then the loop ends, so the parent received
 * "Sub-agent X finished. Final report: …" and, one status change later, "[harness] Sub-agent @X is now idle without having
 * called finish(), so it has not reported a result." The parent cannot act on a contradiction: it has the report.
 *
 * The neighbouring case matters just as much — a child that RESUMES, works, and stops silently is exactly who the note is
 * for, so finishing once must not silence it forever.
 */
test("a finished child is not reported as having never finished, but a resumed one still is", async () => {
  const { kid, got, stop } = await tree();
  try {
    // what the agent calls when its own status changes; the parent's callback is wired in addAgent
    const st = (s: string) => kid.onControlStatusChange?.("p1-sub", s as never);
    st("running");
    // the child's own finish: the final message arrives while it is still running
    kid.log.onEvent?.({ type: "message", agent: "p1-sub", data: { role: "assistant", final: true, content: "done" } } as never);
    st("idle");
    assert.ok(!got.some((t) => /without having called finish/.test(t)), "a report was delivered, so the note must not fire");

    // resumed, then stopped silently — the note is for THIS case
    got.length = 0;
    st("running");
    st("stopped");
    assert.match(got.join("\n"), /without having called finish/, "a resumed child that stops silently is still reported");
  } finally {
    await stop();
  }
});
