/**
 * Mark this test file as POSIX-only, so the Windows CI job skips it (#110).
 *
 * ## Why a marker rather than a filename
 *
 * The alternative is globbing `*-posix.test.ts`, which makes a test
 * Windows-invisible by being RENAMED — so a genuine platform failure hides with
 * no diff to review. A hand-written allowlist rots the other way: a new
 * POSIX-only test is silently run on Windows until someone notices it fail.
 *
 * With a marker the default is "run it". Opting out is one visible line, greppable
 * across the repo, and `scripts/run-portable-tests.mjs` reports every skip in its
 * output so a skipped file is always visible in the CI log.
 *
 * ## When to use it
 *
 * Only when the test genuinely cannot pass on Windows — i.e. it needs a POSIX
 * shell, POSIX paths, POSIX permissions, or a process-group kill. Do NOT use it
 * to quiet a failure that should be fixed; that is how real Windows bugs get
 * filed as "expected".
 *
 * ## The honest alternative
 *
 * If a test fails on Windows for a reason that SHOULD be fixed (like #110's kill
 * reporting), it is a bug, not a POSIX-only test. Fix it or keep it running.
 */
export function markPosixOnly(reason: string): void {
  // the marker is a comment + a symbol so the runner can find it by text search
  // and so `pnpm test` on Linux is unaffected
  void reason;
}
