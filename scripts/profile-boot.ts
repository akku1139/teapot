const { loadConfig, resolveConfigPath, Master } = await import("../src/master.ts");
const events = await import("../src/log/events.ts");

const realLoad = events.EventLog.prototype.load;
let loadMs = 0;
let loadN = 0;
events.EventLog.prototype.load = async function (...a) {
  const t = Date.now();
  try {
    return await realLoad.apply(this, a);
  } finally {
    loadMs += Date.now() - t;
    loadN++;
  }
};

const cfgPath = resolveConfigPath(process.argv[2]);
const config = await loadConfig(cfgPath);
const m = new Master(config, cfgPath);
const t0 = Date.now();
await m.start();
const total = Date.now() - t0;

console.log(`master.start()      : ${total}ms  (agents ${m.agents.size})`);
console.log(`  of which load()   : ${loadMs}ms over ${loadN} logs (${(loadMs / Math.max(1, loadN)).toFixed(1)}ms each)`);
console.log(`  other             : ${total - loadMs}ms`);
process.exit(0);
