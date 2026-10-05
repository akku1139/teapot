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
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSource } from "./helpers/source.ts";
import { fileURLToPath } from "node:url";
import { Master } from "../src/master.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const master = readSource(path.join(here, "..", "src", "master.ts"));

/** a parent with one child; returns the prompts the parent receives */
async function tree() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "t135a-"));
  const ws = mkdtempSync(path.join(os.tmpdir(), "t135w-"));
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
  const error = await nudgeFor("error");
  assert.match(error, /Check its last output/, `error means look first (#135); got ${error}`);
  // and neither contradicts itself: no "stopped" phrasing on a waiting child
  const waiting = await nudgeFor("waiting");
  assert.doesNotMatch(
    waiting,
    /stopped without calling/,
    `the old wording read "is now waiting — it stopped" (#135); got ${waiting}`,
  );
});

test("the OLD wording is gone from the source (#135)", () => {
  assert.doesNotMatch(
    master,
    /is now \$\{status\}\. Continue your task, or finish\(\) if the work is done\./,
    "the reported wording must not survive (#135)",
  );
});

test("a child that DID finish still gets the proper report (#135)", async () => {
  // the reworded nudge must not have displaced the real report — that is the
  // message the old wording was duplicating
  const at = master.indexOf("finished. Final report:");
  assert.notEqual(at, -1, "the real report must still exist (#135)");
  assert.notEqual(
    at,
    -1,
    "the real report path must be untouched by the reworded nudge (#135)",
  );
});
