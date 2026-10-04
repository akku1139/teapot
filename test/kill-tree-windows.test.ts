/**
 * #110 (item 2) — a timeout or abort reported success even when nothing was killed.
 *
 * ## The defect, which is not really about Windows
 *
 * Both kill sites wrapped a POSIX **process-group** kill
 * (`process.kill(-pid, "SIGKILL")`) in an empty `catch` commented "already gone".
 *
 * That comment is the bug. On Windows a group kill throws **always** — Node's own
 * docs say so — so the empty catch is not the exceptional path there, it is the
 * normal one. And because the catch was empty, nothing downstream could tell:
 *
 *   - on timeout, `killReason` was set to `TIMEOUT after …ms` regardless of
 *     whether anything died, so the tool reported a timeout for a process that
 *     was **still running**;
 *   - on harness abort, the same — shutdown left the child alive;
 *   - `bash({action:"kill"})` answered "killed" and dropped the job from the map
 *     while the process kept running, now **untrackable**.
 *
 * A timeout that claims success is worse than a crash, because nothing afterwards
 * looks wrong.
 *
 * ## Why these are unit tests
 *
 * The kill behaviour is platform-dependent and this box is not Windows, so the
 * tests drive the helper with an explicit `platform` argument. That is the part
 * that is platform-INDEPENDENT and actually defective — the silent swallow — so
 * it is fully testable here. What cannot be tested without Windows is whether the
 * process really dies; that is asserted by the helper's own return value, which
 * the tests do check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { killTree, describeKill, canKillProcessGroup } from "../src/agent/kill.ts";
import { spawn } from "node:child_process";
import { markPosixOnly } from "./helpers/posix-only.ts";

// #110: POSIX-only — spawns a POSIX binary; runs POSIX commands through the bash tool.
// The Windows CI job skips this file; see test/helpers/posix-only.ts for why
// opting out is explicit rather than by filename.
markPosixOnly("spawns a POSIX binary; runs POSIX commands through the bash tool");

/* ---------- the platform distinction ---------- */

test("only POSIX can kill a whole process group (#110)", () => {
  assert.equal(canKillProcessGroup("linux"), true, "POSIX has process groups (#110)");
  assert.equal(canKillProcessGroup("darwin"), true, "macOS too (#110)");
  assert.equal(canKillProcessGroup("win32"), false, "Windows does NOT (#110)");
});

test("no code path calls process.kill with a negative pid (#110)", () => {
  // the negative pid is what throws on Windows; it must now live in ONE place
  const tools = readFileSync(new URL("../src/agent/tools.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    tools,
    /process\.kill\(-/,
    "the raw group kill must not remain at the call sites (#110)",
  );
  const kill = readFileSync(new URL("../src/agent/kill.ts", import.meta.url), "utf8");
  assert.match(kill, /process\.kill\(-child\.pid/, "it belongs in the helper (#110)");
});

test("an empty catch no longer hides a failed kill (#110)", () => {
  const tools = readFileSync(new URL("../src/agent/tools.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    tools,
    /catch \{\s*\/\*\s*already gone\s*\*\/\s*\}/,
    "the swallow that hid every Windows failure must be gone (#110)",
  );
});

/* ---------- the reporting, which is the actual fix ---------- */

test("a kill that could not run is reported, not assumed (#110)", () => {
  const out = killTree(null, "linux");
  assert.equal(out.killed, false, "no handle means nothing was killed (#110)");
  assert.equal(out.reason, "no-pid", "and the reason is explicit (#110)");
  assert.match(describeKill(out), /no process handle/i, "described for the operator (#110)");
});

test("win32 never claims the whole tree died (#110)", () => {
  // pid 0 is falsy, so it short-circuits at the no-pid guard and never REACHES the
  // platform branch — which is why an earlier version of this test passed even
  // with the win32 branch deleted. Drive a real pid instead.
  const real = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const out = killTree(real, "win32");
  assert.equal(out.wholeTree, false, "win32 must NEVER claim a whole-tree kill (#110)");
  assert.match(
    describeKill(out),
    /may still be running|no process handle|could not be/i,
    `unexpected description: ${describeKill(out)} (#110)`,
  );
});

test("win32 falls back to the direct child when there is no group (#110)", () => {
  // the branch that the pid-0 test missed: a REAL pid on win32 must still kill
  // what it can, and report that the tree is not covered
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const out = killTree(child, "win32");
  assert.equal(out.killed, true, `the direct child must still die (#110): ${JSON.stringify(out)}`);
  assert.equal(out.wholeTree, false, "and the tree must be reported as uncovered (#110)");
});

/* ---------- the timeout path, driven end to end ---------- */

test("a timeout says whether anything was actually killed (#110)", async () => {
  // The mutation that must fail: reporting "TIMEOUT after …ms" with no statement
  // about the kill. That is the original bug — a timeout that claims success
  // while the process runs on.
  const { useTempDirs } = await import("./helpers/tmp.ts");
  const { Agent } = await import("../src/agent/agent.ts");
  const { readEvents } = await import("../src/log/events.ts");
  await useTempDirs(["k110a-", "k110b-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({
        message: {
          role: "assistant" as const,
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function" as const,
              function: { name: "bash", arguments: JSON.stringify({ command: "sleep 30", timeout_ms: 300 }) },
            },
          ],
        },
      }),
      autoContinue: false,
    } as never) as Agent;
    await a.init();
    a.enqueuePrompt("go", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 1500));
    const events = await readEvents(`${sd}/chat.jsonl`);
    await a.dispose();
    const result = String(
      (events.find((e) => e.type === "tool_result")?.data as { result?: string })?.result ?? "",
    );
    assert.match(result, /TIMEOUT after 300ms/, `the timeout must be reported (#110): ${result.slice(0, 120)}`);
    assert.match(
      result,
      /killed \(whole process group\)|already exited|no process handle|could not be/i,
      `the timeout must say WHAT happened to the process (#110): ${result.slice(0, 160)}`,
    );
  });
});

test("the description distinguishes a partial kill (#110)", () => {
  const partial = { killed: true, wholeTree: false } as const;
  const full = { killed: true, wholeTree: true } as const;
  assert.notEqual(
    describeKill(partial),
    describeKill(full),
    "a partial kill must read differently from a full one (#110)",
  );
  assert.match(describeKill(partial), /may still be running/i, "and must warn (#110)");
  assert.match(describeKill(full), /whole process group/i, "a full kill says so (#110)");
});

/* ---------- against a real process, on the platform we can test ---------- */

test("killing a real child on POSIX reports a whole-tree kill (#110)", async () => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 120));
  const out = killTree(child, "linux");
  assert.equal(out.killed, true, `the real kill should succeed (#110): ${JSON.stringify(out)}`);
  assert.equal(out.wholeTree, true, "POSIX kills the group (#110)");
  await new Promise((r) => setTimeout(r, 120));
  // the child must actually be gone
  let alive = true;
  try {
    process.kill(child.pid!, 0); // signal 0 = existence probe
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "the process must really be dead (#110)");
});

test("killing an already-dead pid reports already-gone, not success (#110)", async () => {
  const child = spawn("true", [], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 400));
  const out = killTree(child, "linux");
  assert.equal(out.killed, false, "a dead pid must not read as a successful kill (#110)");
  assert.ok(
    out.reason === "already-gone" || out.wholeTree === true,
    `unexpected outcome: ${JSON.stringify(out)} (#110)`,
  );
});

test("the helper never throws, even for a nonsense pid (#110)", () => {
  // callers are timeouts and abort handlers; a throw there would replace the real
  // message with a secondary failure
  for (const platform of ["linux", "win32"] as const) {
    assert.doesNotThrow(
      () => killTree({ pid: 2 ** 30 }, platform),
      `killTree must not throw on ${platform} (#110)`,
    );
  }
});