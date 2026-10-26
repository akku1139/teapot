import { test } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { readFileSync } from "node:fs";
import { Agent } from "../src/agent/agent.ts";
import { EventLog } from "../src/log/events.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

test("onEvent sees the event ALREADY on disk, sampled synchronously (#126)", async () => {
  const dir = mkdtempInRootSync("s126a-");
  const file = path.join(dir, "chat.jsonl");
  const log = new EventLog(file, "a");
  await log.load();
  let ordered = true;
  log.onEvent = (e) => {
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

test("a status change fires the control plane with EVERY WRITE FAILING (#126)", async () => {
  const dir = mkdtempInRootSync("s126b-");
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

