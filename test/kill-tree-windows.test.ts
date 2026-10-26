import { test } from "node:test";
import assert from "node:assert/strict";
import { killTree, describeKill, canKillProcessGroup } from "../src/agent/kill.ts";
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

test("only POSIX can kill a whole process group (#110)", () => {
  assert.equal(canKillProcessGroup("linux"), true, "POSIX has process groups (#110)");
  assert.equal(canKillProcessGroup("darwin"), true, "macOS too (#110)");
  assert.equal(canKillProcessGroup("win32"), false, "Windows does NOT (#110)");
});

test("a kill that could not run is reported, not assumed (#110)", () => {
  const out = killTree(null, "linux");
  assert.equal(out.killed, false, "no handle means nothing was killed (#110)");
  assert.equal(out.reason, "no-pid", "and the reason is explicit (#110)");
  assert.match(describeKill(out), /no process handle/i, "described for the operator (#110)");
});

test("win32 never claims the whole tree died (#110)", { skip: !isWindows }, () => {
  const real = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const out = killTree(real, "win32");
  assert.equal(out.wholeTree, false, "win32 must NEVER claim a whole-tree kill (#110)");
  assert.match(
    describeKill(out),
    /may still be running|no process handle|could not be/i,
    `unexpected description: ${describeKill(out)} (#110)`,
  );
});

test("win32 falls back to the direct child when there is no group (#110)", { skip: !isWindows }, () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const out = killTree(child, "win32");
  assert.equal(out.killed, true, `the direct child must still die (#110): ${JSON.stringify(out)}`);
  assert.equal(out.wholeTree, false, "and the tree must be reported as uncovered (#110)");
});

test("a timeout says whether anything was actually killed (#110)", { skip: isWindows }, async () => {
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

test("killing a real child on POSIX reports a whole-tree kill (#110)", { skip: isWindows }, async () => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 120));
  const out = killTree(child, "linux");
  assert.equal(out.killed, true, `the real kill should succeed (#110): ${JSON.stringify(out)}`);
  assert.equal(out.wholeTree, true, "POSIX kills the group (#110)");
  await new Promise((r) => setTimeout(r, 120));
  let alive = true;
  try {
    process.kill(child.pid!, 0); 
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
  for (const platform of ["linux", "win32"] as const) {
    assert.doesNotThrow(
      () => killTree({ pid: 2 ** 30 }, platform),
      `killTree must not throw on ${platform} (#110)`,
    );
  }
});