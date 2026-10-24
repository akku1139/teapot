#!/usr/bin/env node
/**
 * Read-only watcher for a RUNNING teapot server. Prints RSS/heap/HWM plus live activity once a
 * second, so a manual test has numbers instead of impressions.
 *
 *   node scripts/watch-live.ts [--port 7789] [--secs 300]
 *
 * READ-ONLY, and deliberately so:
 *
 *   - it never imports `Master`. `Master.start()` WRITES (it resolves session dirs, writes
 *     `session.json` manifests and rewrites session pointers in `config.json`) — running a probe
 *     inside a live data dir once reassigned 493 agents and orphaned 377MB of history. This script
 *     only reads `/proc` and two GET endpoints.
 *   - it never kills anything. It reports a pid; deciding what to do with it is the operator's.
 *   - `--port` here is a READ target, not a place to boot. Nothing binds.
 *
 * `/proc/<pid>/status` gives `VmRSS`, `VmHWM` (the PEAK, which is the number that matters for a
 * burst) and `Threads`; `/proc/<pid>/stat` gives CPU in CLOCK TICKS (100/s) — not milliseconds,
 * which is the unit confusion that once made this repo report a 1000x runaway loop.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const port = Number(arg("port", "7789"));
const secs = Number(arg("secs", "300"));

const mb = (kb: number) => (kb / 1024).toFixed(1);

/** the pid listening on `port`, read from /proc/net/tcp — no ss, no pgrep, no signal */
function pidOnPort(p: number): number | null {
  try {
    for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
        const c = line.trim().split(/\s+/);
        if (c.length < 10) continue;
        const localPort = parseInt((c[1] ?? "").split(":")[1] ?? "", 16);
        // 0A = LISTEN
        if (localPort !== p || c[3] !== "0A") continue;
        const inode = c[9];
        for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
          try {
            for (const fd of readdirSync(`/proc/${pid}/fd`)) {
              const link = readFileSync(`/proc/${pid}/fd/${fd}`, "utf8");
              if (link.includes(`socket:[${inode}]`)) return Number(pid);
            }
          } catch {
            /* process vanished or fd unreadable */
          }
        }
      }
    }
  } catch {
    /* no /proc/net/tcp on this platform */
  }
  return null;
}

interface Sample {
  rss: number;
  hwm: number;
  threads: number;
  cpuTicks: number;
}

function sample(pid: number): Sample | null {
  try {
    const st = readFileSync(`/proc/${pid}/status`, "utf8");
    const get = (k: string) => Number(st.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1] ?? 0);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // field 14 (utime) and 15 (stime), 1-indexed after the comm field's closing paren
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      rss: get("VmRSS"),
      hwm: get("VmHWM"),
      threads: get("Threads"),
      cpuTicks: Number(after[11] ?? 0) + Number(after[12] ?? 0),
    };
  } catch {
    return null;
  }
}

/** one GET, counted, with its size — the point is HOW MANY the UI makes, not what they say */
async function get(path: string): Promise<number> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    const t = await r.text();
    return t.length;
  } catch {
    return -1;
  }
}

const pid0 = pidOnPort(port);
if (!pid0) {
  console.error(`no listener on :${port} — is teapot running? (nothing was changed)`);
  process.exit(1);
}
console.log(`watching teapot on :${port} (pid ${pid0}) for ${secs}s — read-only, nothing is written`);
console.log("time      rss     hwm    threads   cpu%   note");
console.log("--------------------------------------------------------");

let prev = sample(pid0);
let peakRss = prev?.rss ?? 0;
const started = Date.now();
const timer = setInterval(async () => {
  const pid = pidOnPort(port);
  if (!pid) {
    console.log("server is gone (stopped or replaced in place by an update)");
    clearInterval(timer);
    process.exit(0);
  }
  const s = sample(pid);
  if (!s) return;
  peakRss = Math.max(peakRss, s.rss);
  // ticks are 1/100 s, so the delta over one second IS a percentage of one core
  const cpu = prev ? Math.max(0, s.cpuTicks - prev.cpuTicks) : 0;
  const note =
    s.threads !== prev?.threads ? `threads ${prev?.threads}→${s.threads}` : "";
  console.log(
    `${new Date().toISOString().slice(11, 19)}  ${mb(s.rss).padStart(6)}  ${mb(s.hwm).padStart(6)}  ${String(s.threads).padStart(7)}  ${String(cpu).padStart(5)}   ${note}`,
  );
  prev = s;
  if (Date.now() - started > secs * 1000) {
    console.log(`\npeak RSS during watch: ${mb(peakRss)}MB   (VmHWM ${mb(s.hwm)}MB)`);
    clearInterval(timer);
    process.exit(0);
  }
}, 1000);

// a GET every 30s proves the API still answers and how big the response is; it is NOT a poll of the
// app's behaviour (the app itself no longer polls — that is what was measured)
setInterval(async () => {
  const a = await get("/api/agents");
  const m = await get("/api/metrics");
  if (a >= 0) process.stdout.write(`           (GET /api/agents ${(a / 1048576).toFixed(2)}MB, /api/metrics ${m}B)\n`);
}, 30_000).unref();
