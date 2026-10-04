/**
 * #126 — three corrections to the #54 write-before-notify fix.
 *
 * The fix itself was right. These are the problems it introduced or failed to
 * catch, all confirmed by measurement rather than argument.
 *
 * ## 1. The regression test could not prove what it claimed
 *
 * The original test sampled the log with ASYNC `readFile` inside the observer:
 *
 *     log.onEvent = async (e) => { const txt = await readFile(file, …); … }
 *
 * `await` yields, so the write can land *during* the yield and the OLD
 * implementation would still pass. Measured against the old code:
 *
 *     async observer : 1 of 4 tests fail   <- barely detects the bug
 *     sync observer  : 5 of 5 tests fail   <- actually detects it
 *
 * `readFileSync` samples at the instant `onEvent` runs, which is the property
 * under test. This is the same "verify the thing you changed" mistake the Windows
 * CI caught in a regex.
 *
 * ## 2. `onEvent` became async — and it carried CONTROL FLOW
 *
 * The change was not only a timing adjustment. `wait_children` wakeups ran
 * through `EventLog.onEvent`, so after the fix they waited on the WRITE:
 *
 *     child settles -> log.append(state) -> write -> onEvent -> onChildEvent
 *     -> wakeParentWaiters
 *
 * Measured with every write failing (`ENOSPC`):
 *
 *     onEvent fired: 0     => the parent never wakes
 *
 * So disk latency or failure became control flow. `setStatus` now fires
 * `onControlStatusChange` FIRST and independently — a status change is control
 * flow, not an observation of one.
 *
 * ## 3. A comment asserted a contract that no longer held
 *
 * `agent.ts` still said "log.append fires onEvent synchronously". That became
 * false with the previous commit, and it was load-bearing: the note explained why
 * the status field is updated BEFORE the append.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { Agent } from "../src/agent/agent.ts";
import { EventLog } from "../src/log/events.ts";

/* ---------- 1. the ordering test must be synchronous ---------- */

test("onEvent sees the event ALREADY on disk, sampled synchronously (#126)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "s126a-"));
  const file = path.join(dir, "chat.jsonl");
  const log = new EventLog(file, "a");
  await log.load();
  let ordered = true;
  log.onEvent = (e) => {
    // SYNCHRONOUS: no await may sit between onEvent and the read, or the write
    // can complete during the yield and the old code would still pass
    if (!readFileSync(file, "utf8").includes(e.id)) ordered = false;
  };
  await log.append("message", "s", "br0", { role: "assistant", content: "x" });
  await new Promise((r) => setTimeout(r, 150));
  try {
    assert.equal(ordered, true, "onEvent must fire after persistence (#126)");
  } finally {
    await log.close();
  }
});

test("the ordering test would FAIL against the old notify-first code (#126)", async () => {
  // the property above is only meaningful if it can detect the regression, so
  // assert that directly rather than trusting it
  const src = readFileSync(new URL("../src/log/events.ts", import.meta.url), "utf8");
  const at = src.indexOf("notify once the write is handed to the OS");
  assert.notEqual(at, -1, "the write-then-notify path must exist (#126)");
  const write = src.indexOf("this.stream.write(");
  assert.ok(
    write < at,
    "the notification must be queued AFTER the write is issued (#126)",
  );
  assert.doesNotMatch(
    src.slice(0, at),
    /onEvent\?\./,
    "and nothing may notify before that point — that was the bug (#126)",
  );
});

/* ---------- 2. control flow must not depend on persistence ---------- */

test("a status change fires the control plane with EVERY WRITE FAILING (#126)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "s126b-"));
  const a = new Agent({
    id: "child",
    workspace: dir,
    sessionDir: dir,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  let control = 0;
  a.onControlStatusChange = () => {
    control++;
  };
  // a full disk / revoked handle: the event plane cannot deliver, and a parent's
  // wait_children must still be woken
  (a.log as unknown as { stream: unknown }).stream = {
    write(_d: unknown, _e: unknown, cb: (e: Error) => void) {
      cb(new Error("ENOSPC: no space left on device"));
    },
    on() {},
  };
  (a as unknown as { setStatus(s: string, r?: string): void }).setStatus("idle", "test");
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(
    control > 0,
    `a parent's wait_children must wake on the status change itself (#126); fired ${control}`,
  );
  await a.dispose().catch(() => {});
});

test("the control plane is declared separately from the event pipeline (#126)", async () => {
  const agent = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
  assert.match(
    agent,
    /onControlStatusChange:\s*\(\(agentId: string, status: AgentStatus\) => void\) \| null = null;/,
    "the control plane must be its own channel (#126)",
  );
  // and it fires BEFORE the log append, because control flow is not durability
  const at = agent.indexOf("this.onControlStatusChange?.(this.opts.id, s);");
  assert.notEqual(at, -1, "setStatus must fire it (#126)");
  const append = agent.indexOf('this.log.append("state"');
  assert.ok(at < append, "and BEFORE the log append (#126)");
});

test("the master wakes parents from the control plane (#126)", async () => {
  const master = readFileSync(new URL("../src/master.ts", import.meta.url), "utf8");
  assert.match(
    master,
    /agent\.onControlStatusChange = \(agentId, status\) => \{/,
    "master must subscribe to the control plane (#126)",
  );
  const at = master.indexOf("agent.onControlStatusChange");
  const block = master.slice(at, at + 700);
  assert.match(
    block,
    /this\.wakeParentWaiters\(ac\.parent\);/,
    "and wake a parked parent from it (#126)",
  );
});

test("the stale synchronous-onEvent comment is gone (#126)", async () => {
  const agent = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    agent,
    /log\.append fires onEvent synchronously/,
    "onEvent is no longer synchronous — the comment must not claim it is (#126)",
  );
});
/* ---------- #126: source anchors must survive a CRLF checkout ---------- */

test("readSource makes an anchor behave identically on LF and CRLF (#126)", async () => {
  // The Windows CI failed on a test that searched for a literal "\n": git checks
  // out CRLF there, so the anchor missed and the test failed while passing on
  // Linux — the third time this shape has broken a test in this project.
  //
  // Rather than fix each test (there were ten with the same pattern), every
  // source-reading test goes through this helper, and this asserts the property
  // that makes them safe.
  const { readSource } = await import("./helpers/source.ts");
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "s126c-"));
  const lf = "title={\n  row.a.parent\n}\n";
  const lfPath = path.join(dir, "lf.ts");
  const crlfPath = path.join(dir, "crlf.ts");
  writeFileSync(lfPath, lf);
  writeFileSync(crlfPath, lf.replace(/\n/g, "\r\n"));
  const fromLf = readSource(lfPath);
  const fromCrlf = readSource(crlfPath);
  assert.equal(fromLf, fromCrlf, "readSource must normalise line endings (#126)");
  assert.ok(
    fromCrlf.includes("row.a.parent\n"),
    "a CRLF checkout must still match an LF anchor (#126)",
  );
});

test("no test file anchors on a raw newline inside a search string (#126)", async () => {
  // the structural guard, so the pattern cannot come back one file at a time
  const { readdirSync, readFileSync } = await import("node:fs");
  const { readSource } = await import("./helpers/source.ts");
  // #126: `.pathname` on a file: URL yields "/D:/a/…" on Windows — the leading
  // slash makes it a POSIX-absolute path that does not resolve. The same mistake
  // `windows-tilde-expansion.test.ts` made, which is why that test could never
  // have passed on the runner it was written for.
  const { fileURLToPath } = await import("node:url");
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const offenders: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".test.ts")) continue;
    const src = readSource(path.join(dir, f));
    for (const m of src.matchAll(/(?:indexOf|lastIndexOf)\(\s*"[^"]*\\n/g)) {
      offenders.push(f);
      break;
    }
  }
  // Anchoring on "\n" is fine ONLY if the text came through readSource, which
  // normalises CRLF. So the check is not "does it anchor" but "does it anchor on
  // RAW file text".
  const unsafe: string[] = [];
  for (const f of offenders) {
    const src = readSource(path.join(dir, f));
    const raw = readFileSync(path.join(dir, f), "utf8");
    if (raw !== src) continue;                       // already normalised
    if (/readSource/.test(raw)) continue;            // routed, anchor is safe
    unsafe.push(f);
  }
  assert.deepEqual(
    unsafe,
    [],
    `these anchor on a raw newline without readSource, so they fail on a CRLF checkout (#126): ${unsafe.join(", ")}`,
  );
});
