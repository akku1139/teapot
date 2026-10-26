#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from "node:fs";

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const port = Number(arg("port", "7789"));
const secs = Number(arg("secs", "300"));

const mb = (kb: number) => (kb / 1024).toFixed(1);

function pidOnPort(p: number): number | null {
  try {
    for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
        const c = line.trim().split(/\s+/);
        if (c.length < 10) continue;
        const localPort = parseInt((c[1] ?? "").split(":")[1] ?? "", 16);
        if (localPort !== p || c[3] !== "0A") continue;
        const inode = c[9];
        for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
          try {
            for (const fd of readdirSync(`/proc/${pid}/fd`)) {
              const link = readFileSync(`/proc/${pid}/fd/${fd}`, "utf8");
              if (link.includes(`socket:[${inode}]`)) return Number(pid);
            }
          } catch {
          }
        }
      }
    }
  } catch {
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

setInterval(async () => {
  const a = await get("/api/agents");
  const m = await get("/api/metrics");
  if (a >= 0) process.stdout.write(`           (GET /api/agents ${(a / 1048576).toFixed(2)}MB, /api/metrics ${m}B)\n`);
}, 30_000).unref();
