/**
 * A TCP port that is free right now.
 *
 * #141: `node --test` runs test FILES in parallel, so a test that picks a port
 * from a fixed range (`8900 + random(90)`) can collide with another file in the
 * same millisecond. The loser fails at LOAD, before any assertion runs — which is
 * why the CI failure carried no diagnostic at all, just
 * `✖ test/cli-boot-and-host.test.ts (1774ms)`.
 *
 * Asking the OS is the reliable form: bind to port 0, read back what it assigned,
 * then close. There is a residual race with a process that binds in the same
 * instant, but it is far smaller than a shared fixed range — and unlike a fixed
 * port it cannot poison an unrelated test on a re-run.
 */
import { createServer } from "node:net";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** true if something is listening on `port` */
export async function portInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createServer();
    sock.once("error", () => resolve(true));
    sock.listen(port, host, () => sock.close(() => resolve(false)));
  });
}
