import fs from "node:fs";
import path from "node:path";

export function bundleInputs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?|css|html)$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(root, "frontend"));
  for (const extra of ["vite.config.ts", "index.html"]) {
    const p = path.join(root, extra);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

export interface Freshness {
  state: "fresh" | "missing" | "stale";
  bundle?: string;
  bundleMtime?: number;
  newestSource?: string;
  sourceMtime?: number;
}

export function bundleFreshness(root: string): Freshness {
  const assetsDir = path.join(root, "public", "assets");
  let bundle: string | undefined;
  let bundleMtime = 0;
  try {
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.startsWith("index-") || !f.endsWith(".js")) continue;
      const p = path.join(assetsDir, f);
      const m = fs.statSync(p).mtimeMs;
      if (m > bundleMtime) {
        bundleMtime = m;
        bundle = p;
      }
    }
  } catch {
  }
  if (!bundle) return { state: "missing" };

  const inputs = bundleInputs(root);
  let newestPath: string | undefined;
  let newestMtime = 0;
  for (const p of inputs) {
    let m: number;
    try {
      m = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (m > newestMtime) {
      newestMtime = m;
      newestPath = p;
    }
  }
  if (newestPath !== undefined && newestMtime > bundleMtime + 1000) {
    return { state: "stale", bundle, bundleMtime, newestSource: newestPath, sourceMtime: newestMtime };
  }
  return { state: "fresh", bundle, bundleMtime };
}

export function freshnessMessage(f: Freshness): string {
  const rel = (p?: string) => (p ? p.replace(/^.*?(frontend|public|scripts)\//, "$1/") : "?");
  switch (f.state) {
    case "missing":
      return (
        "no built web bundle — `pnpm build` produces public/assets/. " +
        "Without it the web bundle tests cannot run, so this suite proves NOTHING " +
        "about current UI code (#75). Build, or accept that the UI is untested."
      );
    case "stale":
      return (
        `the built bundle is OLDER than ${rel(f.newestSource)} — it was built from ` +
        "different source (#75). A stale bundle passes its own smoke tests while " +
        "testing code you have since changed. Run `pnpm build`."
      );
    default:
      return "bundle is fresh";
  }
}
