/**
 * Poll for a condition instead of waiting a fixed duration.
 *
 * A fixed `setTimeout` asserts that a SLOW machine is fast enough. The same test then passes locally
 * and fails on Windows CI, where the reported failure is a timeout even though the behaviour it
 * checks is fine. MEASURED: `the suppression is recorded in the log (#95)` slept 300ms and read the
 * log once; ubuntu and publish passed, windows failed on that assertion alone.
 *
 * Usage:
 *
 *   await waitFor(async () => (await readEvents(log)).some((e) => e.type === "tool_result"), {
 *     what: "the tool result to be logged",
 *   });
 *
 * A `what` names the condition in the failure message, so a genuine regression reads as
 * "timed out waiting for <thing>" rather than as a bare assertion.
 */
export interface WaitForOptions {
  /** named in the failure message; say what was being waited for */
  what: string;
  /** total budget, default 5000ms */
  timeoutMs?: number;
  /** how often to re-check, default 25ms */
  intervalMs?: number;
}

export async function waitFor(cond: () => boolean | Promise<boolean>, opts: WaitForOptions): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${opts.what}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * The same, for the common case of "poll a log until a matching event appears", returning it.
 *
 * Reading the log repeatedly is how these tests observe the agent without reaching into private
 * state, so the loop is worth naming once.
 */
export async function waitForEvent<T>(
  read: () => T[] | Promise<T[]>,
  match: (e: T) => boolean,
  opts: WaitForOptions,
): Promise<T> {
  let found: T | undefined;
  await waitFor(async () => {
    found = (await read()).find(match);
    return found !== undefined;
  }, opts);
  return found!;
}
