/**
 * Is the built web bundle newer than the sources it was built from?
 *
 * #75: `web-bundle.test.ts` skipped whenever `public/assets` had no bundle, and
 * `public/` is gitignored — so a bare local `pnpm test` silently skipped it. CI
 * runs `pnpm build` BEFORE `pnpm test`, which hid the problem: locally the suite
 * reported all-green while proving nothing about current UI code.
 *
 * Proof: injecting a render `ReferenceError` into `MessageRow` left the test
 * passing, and only a rebuild made it fail.
 *
 * So staleness is an explicit, reported state rather than a quiet skip. This is
 * a comparison, not a dependency graph: the bundle is fresh when it is at least
 * as new as the NEWEST file under `frontend/` (plus the vite config and
 * index.html). Any source newer than the bundle means the bundle was built from
 * different code. A 1s tolerance absorbs filesystem timestamp granularity.
 */
import fs from "node:fs";
import path from "node:path";

/** every input that can change the bundle's contents */
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
  /** the newest bundle, when there is one */
  bundle?: string;
  bundleMtime?: number;
  /** the source that is newer than the bundle, when stale */
  newestSource?: string;
  sourceMtime?: number;
}

/** Compare the newest bundle against the newest input — any newer input means stale. */
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
    /* no assets dir at all */
  }
  if (!bundle) return { state: "missing" };

  const inputs = bundleInputs(root);
  // The bundle is stale if ANY input is newer than it — so compare against the
  // NEWEST input, not the oldest. (Comparing against the oldest input is always
  // fresh, because the oldest source predates any build done afterwards: that
  // was the first version of this and it silently never fired.)
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

/** A message that says what to do, rather than "skipped". */
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
