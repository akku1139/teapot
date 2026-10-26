const { loadConfig, resolveConfigPath, Master } = await import("../src/master.ts");
import path from "node:path";

const realFetch = globalThis.fetch;
let modelFetches = 0;
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
