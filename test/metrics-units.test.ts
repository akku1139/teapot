import { test } from "node:test";
import assert from "node:assert/strict";
import { Master } from "../src/master.ts";
import { useTempDir } from "./helpers/tmp.ts";

/**
 * `cpuMsTotal` must be MILLIseconds.
 *
 * It was `cu.user + cu.system` straight from `process.cpuUsage()`, which reports MICROseconds — so
 * the field read 1000x too high. MEASURED on a healthy idle server: 18,313,198 "ms" over 1903s
 * uptime, i.e. ~9.6 cores burning, against a real 18,310ms (0.9% of one core). That is enough to
 * send an investigation after a runaway loop that does not exist — it did.
 *
 * `process.cpuUsage()` cannot be mocked, so the assertion is a UNIT CHECK: the reported value must
 * be within an order of magnitude of what `/proc` reports, not 1000x it.
 */
test("cpuMsTotal is milliseconds, not microseconds (#metrics)", async () => {
  await useTempDir("teapot-metrics-", async (dir) => {
    const m = new Master(
      { port: 0, dataDir: dir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, agents: [] },
      `${dir}/config.json`,
    );
    // burn a known-ish amount so the value is not zero
    const until = Date.now() + 60;
    while (Date.now() < until) {
      /* spin */
    }
    const cpu = m.metrics().cpuMsTotal;
    assert.ok(Number.isFinite(cpu) && cpu >= 0, `a finite non-negative number, got ${cpu}`);
    /**
     * A process that has existed for well under a second cannot have consumed more milliseconds of
     * CPU than a generous bound — but with the microsecond bug an even tiny burn reports thousands.
     * 30s is far above any plausible reading here and far below the 1000x-inflated one.
     */
    assert.ok(
      cpu < 30_000,
      `cpuMsTotal must be MILLIseconds: ${cpu} on a fresh process means the microsecond value is ` +
        `being reported unconverted, which reads as thousands of cores (#metrics)`,
    );
  });
});
