/**
 * The effective `bash` timeout cap, mirroring the SERVER's default.
 *
 * These numbers are duplicated rather than imported, and that is a deliberate trade: importing them
 * from `src/agent/tools.ts` pulled the whole agent module graph into the browser bundle — MEASURED,
 * the entry chunk went 549KB → 613KB to read two integers. A test asserts the values still agree
 * (`test/bash-timeout-parity.test.ts`), so the duplication cannot drift silently.
 *
 * Why it matters at all: the row rendered no cap whenever the model omitted `timeout_ms`, while the
 * server was running the command under a real 120s default — reported as "タイムライン上にタイムアウト時間が
 * 表示されない". A cap nobody can see is indistinguishable from no cap, and that is exactly when it
 * kills something.
 */

/** how long a `bash` command may run when `timeout_ms` is not given — must equal the server's */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;

/** the hard ceiling — must equal the server's */
export const BASH_MAX_TIMEOUT_MS = 600_000;

/** the cap a `bash` call actually runs under, from its args — the same clamp the server applies */
export const effectiveBashTimeout = (timeoutMs: unknown): number => {
  const n = Number(timeoutMs);
  return Math.min(Number.isFinite(n) && n > 0 ? n : BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS);
};
