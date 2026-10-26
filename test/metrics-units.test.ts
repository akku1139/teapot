import { test } from "node:test";
import assert from "node:assert/strict";
import { Master } from "../src/master.ts";
import { useTempDir } from "./helpers/tmp.ts";

test("cpuMsTotal is milliseconds, not microseconds (#metrics)", async () => {
  await useTempDir("teapot-metrics-", async (dir) => {
    const m = new Master(
      { port: 0, dataDir: dir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, agents: [] },
      `${dir}/config.json`,
    );
    const until = Date.now() + 60;
    while (Date.now() < until) {
    }
    const cpu = m.metrics().cpuMsTotal;
    assert.ok(Number.isFinite(cpu) && cpu >= 0, `a finite non-negative number, got ${cpu}`);
    assert.ok(
      cpu < 30_000,
      `cpuMsTotal must be MILLIseconds: ${cpu} on a fresh process means the microsecond value is ` +
        `being reported unconverted, which reads as thousands of cores (#metrics)`,
    );
  });
});
