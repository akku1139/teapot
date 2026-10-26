/**
 * A config path that can be written but never read back.
 *
 * Tests construct `new Master(config, configPath)` and most do not care where the config
 * is written, only that saving does not fail. `/dev/null` served that purpose on POSIX and
 * was copied into 30 test files — but it does not exist on Windows, so `writeFileSync`
 * throws, `saveConfig` swallows it, and a route returns a bare 400. That surfaced as
 * "MCP server survives save → reopen: actual 400, expected 200", which reads like a
 * schema rejection and cost a CI cycle to trace.
 *
 * `os.devNull` is the portable spelling: `/dev/null` on POSIX, `NUL` on Windows.
 */
import { devNull } from "node:os";

/** `/dev/null` on POSIX, `NUL` on Windows — the portable "discard writes" target. */
export const DEV_NULL = devNull;

/**
 * A writable path for a test that does not care where the config lands.
 *
 * Prefer a real path inside the test's temp dir when the test reads the file (round-trip,
 * persistence, atomic-write behaviour). Use this only when the config is incidental.
 */
export function throwawayConfigPath(): string {
  return DEV_NULL;
}
