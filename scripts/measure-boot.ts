// Measure teapot's boot against an ISOLATED sandbox config/data dir.
//
// Never point this at the real data dir: `Master.start()` writes manifests and
// can rewrite session pointers in config.json (that mistake orphaned 493
// sessions once). The sandbox is a full copy, so every write lands there.
//
// The import is RELATIVE: an absolute path to this checkout was committed once and
// type-checked nowhere (scripts were not checked at all), so it only broke when CI ran
// `typecheck:scripts` on a machine where that path does not exist.
const { loadConfig, resolveConfigPath, Master } = await import("../src/master.ts");
import path from "node:path";

// count real outbound /models lookups: the negative-cache fix is about NOT
// repeating a failing request per agent, which is deterministic (unlike wall time)
const realFetch = globalThis.fetch;
let modelFetches = 0;
// typed as the real fetch signature: a bare rest parameter cannot be forwarded to
// `realFetch` (TS2556 — a spread argument needs a tuple type or a rest parameter)
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("/models")) modelFetches++;
  return realFetch(input, init);
}) as typeof fetch;

const cfgPath = resolveConfigPath(process.argv[2]);
const t0 = Date.now();
const config = await loadConfig(cfgPath);
const tLoad = Date.now() - t0;

const recorded = new Set(config.agents.map((a) => a.session).filter(Boolean));

const m = new Master(config, cfgPath);
const t1 = Date.now();
await m.start();
const tStart = Date.now() - t1;

let minted = 0;
for (const a of m.agents.values()) {
  if (!recorded.has(path.basename(path.dirname(a.log.filePath)))) minted++;
}

console.log(`loadConfig                  : ${tLoad}ms`);
console.log(`master.start()              : ${tStart}ms   <- agents: ${m.agents.size}`);
console.log(`TOTAL boot                  : ${tLoad + tStart}ms`);
console.log(`sessions MINTED on this boot: ${minted}   (0 = non-destructive)`);
console.log(`/models network requests    : ${modelFetches}   (one per DISTINCT endpoint = cache working)`);
process.exit(0);
