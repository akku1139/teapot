/**
 * #79 — the `/api/ws` event stream had no connection cap and no liveness check.
 *
 * Every connection holds a listener on the global bus and receives EVERY
 * agent's events, so the count is a direct multiplier on fan-out. And a client
 * that stops reading makes `ws.send` buffer without bound — the only thing that
 * used to bound it was `bus.setMaxListeners(1000)`, which silences a warning
 * and bounds nothing.
 *
 * The fix pairs a cap with a reaper, and the reaper REQUIRED a client change:
 * the web UI dropped the server's ping on the floor, so a probe that expects a
 * pong would disconnect every real client. Both halves are pinned here, because
 * either one alone is a regression — the cap alone leaks slots, and the reaper
 * alone disconnects everyone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const api = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
const master = readFileSync(new URL("../src/master.ts", import.meta.url), "utf8");

/* ---------- the cap ---------- */

test("the event stream has a connection cap (#79)", () => {
  assert.match(api, /const MAX_WS_CLIENTS = \d+;/, "a cap must exist (#79)");
  assert.match(
    api,
    /if \(wsClients >= MAX_WS_CLIENTS\)[\s\S]{0,400}?ws\.close\(1013/,
    "and exceeding it must CLOSE the socket, not just warn (#79)",
  );
});

test("a refused connection does not release a slot it never took (#79)", () => {
  // the #70 lesson: a path that returns early must not decrement. Otherwise a
  // stream of refused connections drives the counter to zero and the cap stops
  // admitting anyone.
  assert.match(
    api,
    /let counted = false;/,
    "admission must be tracked per connection (#79)",
  );
  assert.match(
    api,
    /if \(counted\) wsClients = Math\.max\(0, wsClients - 1\);/,
    "only an admitted connection may release its slot (#79)",
  );
});

/* ---------- the liveness reaper, and the client half that makes it safe ---------- */

test("an unanswered ping reaps the client (#79)", () => {
  assert.match(
    api,
    /if \(awaitingPong\)[\s\S]{0,200}?ws\.close\(1011/,
    "a client that stops answering must be reaped (#79)",
  );
  assert.match(api, /awaitingPong = false/, "a pong must clear the flag (#79)");
});

test("the web UI ANSWERS the ping (#79)", () => {
  // The load-bearing half. The UI used to `return` on a ping, which would get
  // every real client disconnected after two intervals once the reaper shipped.
  assert.match(
    app,
    /if \(msg\.kind === "ping"\)[\s\S]{0,300}?send\(JSON\.stringify\(\{ kind: "pong" \}\)\)/,
    "the client MUST pong, or the reaper disconnects everyone (#79)",
  );
  assert.doesNotMatch(
    app,
    /if \(msg\.kind === "ping" \|\| msg\.kind === "pong"\) return;/,
    "dropping the ping on the floor is what the reaper would punish (#79)",
  );
});

test("the pong is sent on the live socket (#79)", () => {
  // `ws` is a module-level `let`, so TypeScript widens it to possibly-undefined
  // inside the handler closure — which is why the handler binds a local const.
  // Pinning that so the reply cannot be silently dropped to satisfy the checker.
  assert.match(app, /const sock = new WebSocket\(/, "the handler must use a local socket (#79)");
  assert.match(app, /sock\.send\(JSON\.stringify\(\{ kind: "pong" \}\)\)/, "sent on `sock` (#79)");
});

test("both websocket handlers are covered (#79)", () => {
  // /api/agents/:id/term is a websocket too and was uncapped
  const termHandler = api.slice(api.indexOf('"/api/agents/:id/term"'));
  assert.ok(termHandler.length > 0, "the terminal websocket must exist (#79)");
  assert.match(
    termHandler,
    /if \(cur >= \d+\)/,
    "the terminal socket keeps its own per-agent cap (#70/#79)",
  );
});

/* ---------- the restart race ---------- */

test("the stop timeout timer is cleared (#79)", () => {
  // an uncleared 30s timer keeps the event loop alive after a stop that took
  // milliseconds
  assert.match(
    master,
    /finally \{\s*if \(timer\) clearTimeout\(timer\);/,
    "the stop-timeout timer must be cleared (#79)",
  );
});

/* ---------- the server must HONOUR the pong (#75 mutation W2) ---------- */

/**
 * The existing tests asserted the CLIENT sends a pong. Nothing asserted the
 * SERVER acts on it — and mutation testing broke
 * `if (m?.kind === "pong") awaitingPong = false;` with all 7 tests green.
 *
 * That is not a cosmetic gap: the pong is what clears the reaper's flag. With it
 * broken, `awaitingPong` stays true, the next interval tick sees an unanswered
 * ping and closes the socket with 1011 — so the reaper disconnects EVERY real
 * client roughly every 30 seconds.
 */
test("the server clears its reaper flag when a pong arrives (#79)", () => {
  const api = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
  assert.match(
    api,
    /if \(m\?\.kind === "pong"\) awaitingPong = false;/,
    "a pong must clear the flag — without this the reaper kills every client (#79)",
  );
});

test("the reaper only fires when a ping went UNANSWERED (#79)", () => {
  const api = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
  const at = api.indexOf("awaitingPong) {");
  assert.notEqual(at, -1, "the reaper branch must exist (#79)");
  const branch = api.slice(at, at + 260);
  assert.match(branch, /ws\.close\(1011/, "and it must close the socket (#79)");
  assert.match(branch, /unresponsive/, "with a reason (#79)");
  // and the flag must be SET by the ping we send, so the check is meaningful
  assert.match(api, /awaitingPong = true;/, "sending a ping must arm the probe (#79)");
});

test("the client pongs AND the server reaps — the pair is what makes it safe (#79)", () => {
  // neither half is sufficient alone: a client that never pongs gets reaped
  // (correct), and a server that ignores the pong reaps everyone (the bug).
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  const api = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
  assert.match(app, /kind: "pong"/, "the client must answer the probe (#79)");
  assert.match(api, /awaitingPong = false/, "and the server must accept the answer (#79)");
});
