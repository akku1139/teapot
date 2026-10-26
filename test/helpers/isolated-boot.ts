/**
 * Boot the built CLI against a FULLY isolated config + data dir.
 *
 * #143: the boot path WRITES. `Master.start()` → `addAgent()` resolves each
 * agent's session directory, mints one when it cannot find the recorded one, and
 * `recordSession()` writes the result back into the CONFIG named by
 * `resolveConfigPath()`. So a child process given only `TEAPOT_DATA_DIR` still
 * reads the developer's REAL config — whose sessions live under the real data
 * dir — fails to find any of them in the temp dir, mints replacements for all of
 * them, and rewrites the real config. The temp dir is then deleted, leaving that
 * config pointing at sessions that never existed.
 *
 * Measured on this repository's own suite: `pnpm test` orphaned the session
 * pointers of 493 agents, twice, before anyone noticed. CI never saw it because
 * CI has no config file to damage.
 *
 * So `TEAPOT_CONFIG` is not optional here — it is what makes the child harmless.
 * The config written for the child is a COPY with `dataDir` pointing at the temp
 * dir, so the child can still be given a realistic agent list when a test wants
 * one, and a child that mints sessions only ever touches the copy.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface IsolatedBoot {
  /** env for `spawn`, with BOTH the config and the data dir redirected */
  env: Record<string, string>;
  configPath: string;
  dataDir: string;
}

/**
 * Build the env a spawned teapot must run with.
 *
 * @param dataDir  a temp directory owned by the test
 * @param port     the port the child will bind
 * @param seed     optional config body to copy (agents/providers) — its `dataDir`
 *                 is rewritten to `dataDir`, so the child never resolves a session
 *                 under a root it does not own
 */
export function isolatedBootEnv(
  dataDir: string,
  port: number,
  seed?: Record<string, unknown>,
): IsolatedBoot {
  const configPath = path.join(dataDir, "config.json");
  const body = seed && Object.keys(seed).length ? { ...seed, dataDir, port } : { dataDir, port, agents: [] };
  writeFileSync(configPath, JSON.stringify(body, null, 2) + "\n");
  return {
    configPath,
    dataDir,
    env: {
      TEAPOT_CONFIG: configPath, // <-- the part that was missing
      TEAPOT_DATA_DIR: dataDir,
      TEAPOT_PORT: String(port),
    },
  };
}

/** true when a config file exists on disk (a test may assert it was not created) */
export function configExists(p: string): boolean {
  return existsSync(p);
}
