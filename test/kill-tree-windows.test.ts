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
import { killTree, describeKill, canKillProcessGroup } from "../src/agent/kill.ts";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// #110: this file deliberately does NOT call markPosixOnly. The Windows CI job
// exists BECAUSE of it — these are the win32/posix reporting branches, and
// skipping the whole file on Windows would delete the only coverage of the
// platform being tested.
//
// The individual cases that spawn a platform binary, or drive the bash tool, skip
// themselves with `{ skip: isWindows }` / `{ skip: !isWindows }`. Marking the file
// would have been exactly the "a real platform failure hides" outcome the marker
// exists to prevent.
//
// #190 — keep two kinds of test apart, because only one of them can run here:
//
//   - an INJECTED TreeRunner tests the DECISION: do we ask `taskkill /T /F` for the
//     tree, and do we report the result honestly? Platform-independent, runs on
//     Linux, and that is all it proves.
//   - what Windows actually DOES needs Windows, so it lives in a `{ skip: !isWindows }`
//     case and is answered by the Windows CI job. An injected runner returning
//     status 0 "passes" on Linux, where taskkill does not exist — so the injected
//     tests alone would let a broken win32 path ship green. Neither kind replaces
//     the other.
const isWindows = process.platform === "win32";

// #110: POSIX-only — spawns a POSIX binary; runs POSIX commands through the bash tool.
// The Windows CI job skips this file; see test/helpers/posix-only.ts for why
// opting out is explicit rather than by filename.

/* ---------- the platform distinction ---------- */

test("only POSIX can kill a whole process group (#110)", () => {
  assert.equal(canKillProcessGroup("linux"), true, "POSIX has process groups (#110)");
  assert.equal(canKillProcessGroup("darwin"), true, "macOS too (#110)");
  assert.equal(canKillProcessGroup("win32"), false, "Windows does NOT (#110)");
});

/* ---------- the reporting, which is the actual fix ---------- */

test("a kill that could not run is reported, not assumed (#110)", () => {
  const out = killTree(null, "linux");
  assert.equal(out.killed, false, "no handle means nothing was killed (#110)");
  assert.equal(out.reason, "no-pid", "and the reason is explicit (#110)");
  assert.match(describeKill(out), /no process handle/i, "described for the operator (#110)");
});

test("win32 asks taskkill for the whole tree, and may now claim it (#190)", () => {
  /**
   * `process.kill(pid)` on Windows terminates only the process you name — the shell. Everything it started
   * keeps running, and because a survivor holds the child's stdio open, the caller that waits for `close`
   * waits forever (#190: "timeout時間超過って" and the stop button not helping).
   *
   * `taskkill /T` is the only way to get the tree, so it must be what we ask for — and when it succeeds the
   * whole-tree claim becomes TRUE, where #110 correctly demanded `wholeTree: false` before it existed. The
   * runner is injected so this is checkable off Windows.
   */
  const calls: string[][] = [];
  const out = killTree({ pid: 4321 }, "win32", (file, args) => {
    calls.push([file, ...args]);
    return { status: 0 };
  });
  assert.deepEqual(calls, [["taskkill", "/pid", "4321", "/T", "/F"]], "the tree must be requested (#190)");
  assert.equal(out.killed, true);
  assert.equal(out.wholeTree, true, "taskkill walked the tree, so the claim is honest (#190)");
  assert.match(describeKill(out), /whole process tree/i, "and it says so (#190)");
});

test("win32 falls back to the direct child when taskkill cannot run (#110/#190)", () => {
  // a real pid on win32 must still kill what it can, and must NOT claim the tree if taskkill did not run
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const out = killTree(child, "win32", () => ({ status: null }));
  assert.equal(out.killed, true, `the direct child must still die (#110): ${JSON.stringify(out)}`);
  assert.equal(out.wholeTree, false, "no tree kill happened, so do not claim one (#190)");
  assert.match(describeKill(out), /children may still be running/i, "and warn (#190)");
});

/* ---------- the timeout path, driven end to end ---------- */

test("a timeout says whether anything was actually killed (#110)", { skip: isWindows }, async () => {
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
    } as never) as InstanceType<typeof Agent>;
    await a.init();
    a.enqueuePrompt("go", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 1500));
    const events = await readEvents(`${sd}/chat.jsonl`);
    await a.dispose();
    // the stray escaped the process group on purpose, so nothing else will reap it — kill its exact pid
    try {
      process.kill(Number(readFileSync(path.join(ws!, "stray.pid"), "utf8").trim()), "SIGKILL");
    } catch {
      /* already gone, or never started */
    }
    const result = String(
      (events.find((e) => e.type === "tool_result")?.data as { result?: string })?.result ?? "",
    );
    assert.match(result, /TIMEOUT after 300ms/, `the timeout must be reported (#110): ${result.slice(0, 120)}`);
    assert.match(
      result,
      /killed \(whole process tree\)|already exited|no process handle|could not be/i,
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
  assert.match(describeKill(full), /whole process tree/i, "a full kill says so (#110/#190)");
});

/* ---------- against a real process, on the platform we can test ---------- */

test("killing a real child on POSIX reports a whole-tree kill (#110)", { skip: isWindows }, async () => {
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

test("killing an already-dead pid reports already-gone, not success (#110)", { skip: isWindows }, async () => {
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

test("a timeout settles even when a child survives the kill and holds the pipes (#190)", { skip: isWindows }, async () => {
  /**
   * The reported symptom: "timeout時間超過って" — the command showed as over its limit but the tool row never
   * finished, and stop did not help; only restarting teapot did.
   *
   * `runShell` settled on the child's `close` event, and `close` waits for the stdio pipes to close. A
   * grandchild that survives the kill still holds those pipes, so `close` never fires and the tool call
   * never returns — the timeout fires into a void. MEASURED on Linux with a child that leaves the process
   * group: `exit` at 501ms, `close` still not fired 2.5s later. On Windows this is the normal case, because
   * `process.kill` cannot end anything but the shell.
   *
   * `setsid` reproduces the Windows shape on POSIX: the surviving `sleep` is outside the process group, so
   * the group kill cannot reach it.
   */
  const { useTempDirs } = await import("./helpers/tmp.ts");
  const { Agent } = await import("../src/agent/agent.ts");
  const { readEvents } = await import("../src/log/events.ts");
  const { waitFor } = await import("./helpers/wait-for.ts");
  await useTempDirs(["k190a-", "k190b-"], async ([ws, sd]) => {
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
              function: {
                name: "bash",
                // the stray outlives the poll budget below, or the hang would "resolve" eventually and
                // prove nothing: it writes its pid so the test can end it exactly
                arguments: JSON.stringify({
                  command: 'setsid bash -c "echo $$ > stray.pid; sleep 30" & sleep 30',
                  timeout_ms: 300,
                }),
              },
            },
          ],
        },
      }),
      autoContinue: false,
    } as never) as InstanceType<typeof Agent>;
    await a.init();
    a.enqueuePrompt("go", "user");
    a.start("t");
    /**
     * The whole point: poll for the tool to RETURN. Before the fix it only returned when the stray child
     * eventually exited on its own — the timeout itself did nothing. The stray sleeps 30s, so a 5s budget
     * cannot be satisfied by it finishing.
     */
    await waitFor(async () => (await readEvents(`${sd}/chat.jsonl`)).some((e) => e.type === "tool_result"), {
      what: "the bash tool to return after its timeout (a surviving child held the pipes)",
      timeoutMs: 5_000,
    });
    const events = await readEvents(`${sd}/chat.jsonl`);
    await a.dispose();
    const result = String(
      (events.find((e) => e.type === "tool_result")?.data as { result?: string })?.result ?? "",
    );
    assert.match(result, /TIMEOUT after 300ms/, `the timeout must be reported (#190): ${result.slice(0, 160)}`);
  });
});

test("on Windows, a real process tree really dies (#190)", { skip: !isWindows }, async () => {
  /**
   * The injected-runner tests above prove we ASK taskkill for the tree. They cannot prove Windows obeys —
   * that needs Windows, and the Windows CI job exists for exactly this. Without this case the taskkill path
   * has no coverage where it runs (the injected runner also "succeeds" on Linux, where taskkill is absent).
   *
   * `process.kill(pid)` alone would leave the grandchild alive, which is the reported failure: the tool call
   * never returns because the survivor holds the stdio pipes.
   */
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { mkdtempInRootSync } = await import("./helpers/tmp-root.ts");
  const pidFile = path.join(mkdtempInRootSync("k190-"), "grandchild.pid");
  // parent node spawns a grandchild that records its own pid, then both sleep
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      setTimeout(() => {}, 30000);
      `,
    ],
    { stdio: "ignore" },
  );

  // poll for the grandchild's pid rather than sleeping (a fixed wait here is the very flake this repo bans)
  const deadline = Date.now() + 15_000;
  let grandchild = 0;
  while (Date.now() < deadline && !grandchild) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      grandchild = Number(readFileSync(pidFile, "utf8").trim()) || 0;
    } catch {
      /* not written yet */
    }
  }
  assert.ok(grandchild > 0, "precondition: the grandchild was started and recorded its pid");

  const out = killTree(parent, "win32");
  assert.equal(out.killed, true, `killTree must kill (#190): ${JSON.stringify(out)}`);
  assert.equal(out.wholeTree, true, "and it must cover the tree, not just the shell (#190)");

  const gone = Date.now() + 15_000;
  let alive = true;
  while (Date.now() < gone && alive) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      process.kill(grandchild, 0);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "the grandchild must be dead too — `process.kill` alone leaves it running (#190)");
});
