/**
 * Smoke-test the built web bundle: load it inside happy-dom and make sure
 * module init + first render survive (catches TDZ/order crashes like the
 * "xe before initialization" regression).
 * Usage: node scripts/smoke-web.mjs [publicDir]
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const req = createRequire(path.join(process.cwd(), "package.json"));
const { Window } = req("happy-dom");

const pub = process.argv[2] ?? path.join("public", "assets");
const assetDir = pub;
const asset = fs
  .readdirSync(assetDir)
  .filter((f) => f.startsWith("index-") && f.endsWith(".js"))
  .sort()
  .at(-1);
if (!asset) {
  console.error("no index-*.js found in", assetDir);
  process.exit(1);
}

const w = new Window({ url: "http://localhost:7788/session/test" });
w.document.body.innerHTML = `<div id="root"></div>`;
const setGlobal = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  } catch {
    /* pre-existing non-configurable global — leave it */
  }
};
setGlobal("window", w);
setGlobal("document", w.document);
setGlobal("localStorage", {
  store: {},
  getItem(k) { return this.store[k] ?? null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
});
setGlobal("navigator", w.navigator);
setGlobal("location", w.location);
setGlobal("history", w.history);
setGlobal("CustomEvent", w.CustomEvent);
setGlobal("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 16));

let failed = false;
try {
  await import(pathToFileURL(path.join(assetDir, asset)).href);
  console.log("bundle imported:", asset);
} catch (e) {
  failed = true;
  console.error("IMPORT FAIL:", e.constructor.name, e.message);
}

// give deferred Solid effects a tick to blow up too, if they're going to
await new Promise((r) => setTimeout(r, 120));
if (!failed) console.log("first render survived");
process.exit(failed ? 1 : 0);
