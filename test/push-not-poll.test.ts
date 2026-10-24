import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

/**
 * Server-wide state is PUSHED over the socket; HTTP is the recovery path.
 *
 * Reported: "/api/metrics,tasks,agents,skills,events がかなり高頻度で発行されてる … フロントエンドの
 * 全状態はWebSocketでライブ配信されるべきで、APIコールはあくまでもバックアップ(長時間PCがスリープ
 * した後に復帰)であるべき。少なくともポーリングするものではない".
 *
 * MEASURED before: a connected tab issued `/api/metrics` and `/api/tasks` every 30s forever, and the
 * counts kept climbing while nothing changed (2x → 3x over 24s, every other endpoint flat).
 * MEASURED after: the resource-timing total is FIXED at 20 for the whole session — the 30s pair is
 * gone — while the runtime panel still updates, because the values now arrive on the socket.
 *
 * The recovery path is what makes removing the poll safe: a tab waking from sleep missed no push it
 * could apply (a push it did not receive never happened), so `visibilitychange` must re-read both.
 */
test("the app does not poll metrics or tasks (#push)", () => {
  const app = readSource("frontend/App.tsx");
  const polls = [...app.matchAll(/setInterval\([^)]*\)/g)].filter((m) =>
    /refreshMetrics|loadTasks/.test(m[0]),
  );
  assert.deepEqual(
    polls.map((m) => m[0]),
    [],
    "a timer that re-asks a question the server already answers is the shape a push socket " +
      "replaces — measured as a per-tab 30s poll that could not notice the answer had not changed " +
      "(#push)",
  );
});

test("the socket carries metrics and tasks (#push)", () => {
  const app = readSource("frontend/App.tsx");
  assert.match(app, /msg\.kind === "metrics"/, "metrics must be applied from the socket (#push)");
  assert.match(app, /msg\.kind === "tasks"/, "and so must tasks (#push)");
  // the server side must emit them, or the client waits forever for a message nobody sends
  const master = readSource("src/master.ts");
  assert.match(master, /kind: "metrics"/, "the master must emit metrics (#push)");
  const bus = readSource("src/bus.ts");
  assert.match(bus, /kind: "metrics"/, "the bus type must name it (#push)");
  assert.match(bus, /kind: "tasks"/, "and tasks (#push)");
});

test("waking a tab re-reads them over HTTP (#push)", () => {
  // the REST path is the RECOVERY path — without this, a tab that slept through a push never learns
  const app = readSource("frontend/App.tsx");
  const at = app.indexOf("onTabVisible = () => {");
  assert.ok(at > 0, "the visibility handler must exist");
  const body = app.slice(at, at + 2600);
  assert.match(body, /refreshMetrics\(\)/, "a waking tab must re-read metrics (#push)");
  assert.match(body, /loadTasks\(\)/, "and tasks (#push)");
});
