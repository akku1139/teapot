/**
 * #155 — session titles.
 *
 * "いろんなチャットアプリが実装してる、CodexやDSHとかも実装してそう / 自動生成とかサブエージェント名
 * とかだとわかりにくい" — the sidebar rendered the raw session id
 * (`teapot-10-16854917`), so with several sessions of one agent there was no way to
 * tell them apart without opening each one.
 *
 * The title comes from the operator's OWN first message rather than a model call:
 * it is already written, costs nothing, and cannot drift (the first message of a
 * session never changes).
 *
 * Asserted on the pure rule, which is what decides every case. The WIRING — that
 * the sidebar prefers the title over the raw id — is asserted separately below,
 * because a helper nothing calls is the #75 failure this repo keeps re-learning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionTitleFrom } from "../src/session-title.ts";
import { readSourceUrl } from "./helpers/source.ts";

test("the title is the first MEANINGFUL line of the operator's prompt", () => {
  assert.equal(
    sessionTitleFrom("teapotのいくつかを修正して\n1. #142\n2. タイムライン"),
    "teapotのいくつかを修正して",
    "a plain opening line is the title",
  );
  assert.equal(
    sessionTitleFrom("## Fix the sidebar\n\nmore detail"),
    "Fix the sidebar",
    "heading markers are stripped, not shown",
  );
  assert.equal(
    sessionTitleFrom("- first bullet\n- second"),
    "first bullet",
    "a list marker is not part of the subject",
  );
});

test("a fenced block is CONTENT, not the subject (#155)", () => {
  // measured: taking the first line inside a fence titled a session "log", which
  // says nothing. The operator pastes a log and then writes what they want.
  assert.equal(
    sessionTitleFrom("```\nlog line one\nlog line two\n```\n\n#155 を進めて"),
    "155 を進めて",
    "the prose after the fence is the title",
  );
  // and an UNTERMINATED fence must not fall through to its own body either
  assert.equal(sessionTitleFrom("```\nsecret\nmore"), null, "an open fence hides its body");
});

test("a line with no subject is skipped for the next one (#155)", () => {
  assert.equal(
    sessionTitleFrom("https://github.com/akku1139/teapot/issues/155\n\nセッション名を自動生成"),
    "セッション名を自動生成",
    "a bare URL is not a title",
  );
  assert.equal(sessionTitleFrom("2.\n3.\nactual subject"), "actual subject", "bare list numbers are skipped");
});

test("no usable text yields null rather than an empty string (#155)", () => {
  // null lets the caller fall back to the id; "" would render a blank row
  assert.equal(sessionTitleFrom(""), null);
  assert.equal(sessionTitleFrom("   \n\n  "), null);
  assert.equal(sessionTitleFrom(undefined), null);
  assert.equal(sessionTitleFrom(null), null);
  assert.equal(sessionTitleFrom(123 as never), null, "a non-string must not throw");
});

test("a long line is clipped on a word boundary with an ellipsis (#155)", () => {
  const long = "word ".repeat(40).trim();
  const t = sessionTitleFrom(long);
  assert.ok(t, "a long line still yields a title");
  assert.ok(t!.length <= 61, `must fit a sidebar row, got ${t!.length}`);
  assert.ok(t!.endsWith("…"), `a clipped title must show that it was cut: ${t}`);
  assert.ok(!/\s…$/.test(t!), "the ellipsis must not sit after a stray space");
});

test("the sidebar PREFERS the title over the raw id (#155)", () => {
  // The wiring is the part that silently does nothing (#75). A title that is
  // computed and never rendered leaves the operator reading `teapot-10-16854917`.
  const app = readSourceUrl(new URL("../frontend/App.tsx", import.meta.url));
  assert.match(
    app,
    /sessionTitle/,
    "the sidebar must render a resolved title, not only row.a.id",
  );
  // the row must still fall back to the id when no title exists, or a fresh
  // session would render an empty row
  const row = app.slice(app.indexOf("class={\"agent-item\""), app.indexOf("class={\"agent-item\"") + 4000);
  assert.match(row, /row\.a\.id|titleOf|sessionTitle/, "the row must have a title-or-id fallback (#155)");
});

test("the server derives a title from a session's log, and SKIPS sub-agent sessions (#155)", async () => {
  // The frontend can only show a title the server actually provides, and the server
  // is the only place that can read a log for a session whose agent is not restored
  // (boot leaves every agent stopped). So the derivation is pinned here, against
  // real log files, rather than only on the pure rule.
  const { Master, loadConfig } = await import("../src/master.ts");
  const { mkdtempInRootSync } = await import("./helpers/tmp-root.ts");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");

  // sessionsRoot() is <dataDir>/sessions, so the fixture must live there
  const dataDir = mkdtempInRootSync("titles-");
  const root = path.join(dataDir, "sessions");
  fs.mkdirSync(root, { recursive: true });
  const write = (name: string, events: unknown[]) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "session.json"),
      JSON.stringify({ v: 1, agentId: "top" }),
    );
    fs.writeFileSync(
      path.join(dir, "chat.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    return dir;
  };
  const ev = (type: string, data: unknown, agent = "top") => ({
    v: 1, id: "e1", seq: 1, ts: "2026-01-01T00:00:00Z", agent, session: "s", branch: "br0", parent: null, type, data,
  });

  write("top-a", [ev("state", {}), ev("prompt", { source: "user", text: "## Fix the sidebar\nmore" })]);
  // a sub-agent session: its ONLY prompt is the harness spawn directive, which is
  // not a human subject — it must yield NO title so the sidebar keeps its id label
  write("top-b", [ev("prompt", { source: "harness", text: "[harness] You are sub-agent x" })]);
  write("top-c", [ev("state", {})]); // no prompt at all

  // no start(): allSessions only reads
  const cfg = loadConfig(path.join(os.homedir(), ".config/teapot-coding-agent/config.json"));
  const m = new Master({ ...cfg, dataDir, agents: [] }, path.join(dataDir, "cfg.json")) as unknown as {
    allSessions(): { id: string; agentId: string; title?: string }[];
  };
  const sessions = m.allSessions();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  assert.equal(byId.get("top-a")?.title, "Fix the sidebar", "a user prompt yields a title");
  assert.equal(byId.get("top-b")?.title, undefined, "a harness-only (sub-agent) session has no title");
  assert.equal(byId.get("top-c")?.title, undefined, "a log with no prompt has no title");
});
