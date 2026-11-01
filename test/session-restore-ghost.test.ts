import assert from "node:assert/strict";
import test from "node:test";
import { pickInitialAgent } from "../frontend/lib/session-restore.ts";

const live = { id: "live" };
const ghost = { id: "ghost", workspaceMissing: true };
const base = {
  urlId: null,
  ownerOf: () => undefined,
  isSession: () => false,
  lastId: null,
  hideGhosts: true,
};

test("a ghost never wins the boot selection when ghosts are hidden", () => {
  /**
   * Reported as "Webを開いた時にghostのセッションが開かれることがあるのであまりよくないかも".
   *
   * `hideGhosts` used to be honoured only when the toggle was CLICKED — the boot chain (URL → last open →
   * first agent) ignored it, so a restored or stale route could open a workspace that no longer exists and
   * load its session directory for nothing.
   */
  assert.equal(pickInitialAgent({ ...base, agents: [ghost, live], lastId: "ghost" })?.id, "live");
  assert.equal(pickInitialAgent({ ...base, agents: [ghost, live], urlId: "ghost" })?.id, "live");
  // the fallback is the first agent, and it is a ghost — skip to the first real one
  assert.equal(pickInitialAgent({ ...base, agents: [ghost, live] })?.id, "live");
});

test("an all-ghost install still opens something", () => {
  // dropping every candidate would leave the app with nothing selected, which reads as a dead page.
  // hiding ghosts is a preference about clutter, not a promise to render nothing when they are all you have
  assert.equal(pickInitialAgent({ ...base, agents: [ghost] })?.id, "ghost");
  assert.equal(pickInitialAgent({ ...base, agents: [ghost, { id: "g2", workspaceMissing: true }] })?.id, "ghost");
});

test("no agents at all selects nothing — do not invent one", () => {
  // a fresh install, or a boot where the list has not arrived yet. Selecting an id that is not in the list
  // would create state for an agent that does not exist; the app's empty state is the honest answer.
  assert.equal(pickInitialAgent({ ...base, agents: [] }), undefined);
  assert.equal(pickInitialAgent({ ...base, agents: [], lastId: "gone", urlId: "gone" }), undefined);
});

test("with ghosts shown, the old priority order is untouched", () => {
  const shown = { ...base, hideGhosts: false };
  assert.equal(pickInitialAgent({ ...shown, agents: [live, ghost], lastId: "ghost" })?.id, "ghost");
  // URL session → its owner wins over the last-opened agent
  assert.equal(
    pickInitialAgent({ ...shown, agents: [live, ghost], urlId: "s1", ownerOf: (s) => (s === "s1" ? "ghost" : undefined) })?.id,
    "ghost",
  );
  // a URL id that is an agent (not a session) is honoured when it is not a session of anything
  assert.equal(pickInitialAgent({ ...shown, agents: [live, ghost], urlId: "ghost" })?.id, "ghost");
  // when the URL id IS a session of something, it is not treated as an agent id
  assert.equal(
    pickInitialAgent({ ...shown, agents: [live, ghost], urlId: "ghost", isSession: () => true, lastId: "live" })?.id,
    "live",
  );
});
