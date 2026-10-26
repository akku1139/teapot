/**
 * THE APP SHELL MUST NEVER BE CACHED, AND THE HASHED ASSETS ALWAYS MUST.
 *
 * Reported while two rounds of UI fixes appeared not to apply: "もしかしてブラウザのキャッシュが効いてて
 * アップデートされたフロントエンドが完全に適用されてない?".
 *
 * MEASURED against the running server: neither `index.html` nor `/assets/*` sent a `cache-control`
 * header AT ALL. With no header a browser applies heuristic freshness (~10% of the age since
 * `Last-Modified`), and the shell is exactly the file that must not be stale — it is what NAMES the
 * hashed bundle, so a cached shell keeps loading the previous `index-<hash>.js` after an update.
 *
 * The two halves need OPPOSITE policies:
 *   - shell  → `no-cache` (revalidate every time) with an ETag, so revalidation is a 304
 *   - assets → `immutable` for a year, because the name changes with the content
 *
 * Asserted on the served HEADERS, because the bug was an absent header: a test on the code would
 * have passed for the old version too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import { useTempDir } from "./helpers/tmp.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function mkApp(dir: string) {
  const master = new Master(
    { port: 0, dataDir: dir, llm: LLM, providers: {}, agents: [] },
    `${dir}/config.json`,
  );
  return buildApp(master);
}

test("the app shell tells the browser to REVALIDATE (#cache)", async () => {
  await useTempDir("teapot-cache-", async (dir) => {
    const app = mkApp(dir);
    const res = await app.request("/");
    // the suite may run without a built bundle; the policy is what matters, so skip only if the
    // route itself reports "not built" — that is a missing artifact, not a cache regression
    if (res.status === 404) {
      assert.match(await res.text(), /web UI not built/);
      return;
    }
    const cc = res.headers.get("cache-control");
    assert.equal(
      cc,
      "no-cache",
      `the shell must revalidate on every load — a heuristically cached index.html keeps pointing ` +
        `at the PREVIOUS bundle after an update (#cache); got ${String(cc)}`,
    );
    assert.ok(
      res.headers.get("etag"),
      "no-cache is only cheap with a validator; without an ETag every load re-downloads the shell " +
        "instead of getting a 304 (#cache)",
    );
  });
});

test("a revalidated shell answers 304, not the whole document (#cache)", async () => {
  await useTempDir("teapot-cache-304-", async (dir) => {
    const app = mkApp(dir);
    const first = await app.request("/");
    if (first.status === 404) return; // no bundle built in this environment
    const etag = first.headers.get("etag");
    assert.ok(etag, "the shell needs an ETag before a 304 is possible");
    const second = await app.request("/", { headers: { "if-none-match": etag! } });
    assert.equal(
      second.status,
      304,
      "a matching If-None-Match must answer 304; re-downloading the shell every load is the cost " +
        "that makes people drop the no-cache rule again (#cache)",
    );
    assert.equal(await second.text(), "", "a 304 carries no body");
  });
});

test("a deep link gets the same shell policy as / (#cache)", async () => {
  await useTempDir("teapot-cache-spa-", async (dir) => {
    const app = mkApp(dir);
    const res = await app.request("/session/anything");
    if (res.status === 404) return; // no bundle built
    assert.equal(
      res.headers.get("cache-control"),
      "no-cache",
      "/session/* serves the SAME file as /, so it needs the same policy or a deep link becomes " +
        "the path that pins a stale frontend (#cache)",
    );
    assert.ok(res.headers.get("etag"), "the deep-link shell needs the validator too");
  });
});

test("a hashed asset is immutable, not revalidated (#cache)", async () => {
  await useTempDir("teapot-cache-asset-", async (dir) => {
    const app = mkApp(dir);
    // the built bundle is what carries the hash; without a build there is nothing to assert on
    const shell = await app.request("/");
    if (shell.status === 404) return;
    const html = await shell.text();
    const m = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
    assert.ok(
      m,
      "the built shell must reference a HASHED bundle — an unhashed name is what makes caching " +
        "an asset unsafe in the first place (#cache)",
    );
    const asset = await app.request(m![0]);
    assert.equal(asset.status, 200, `the referenced asset must be served: ${m![0]}`);
    const cc = asset.headers.get("cache-control");
    assert.match(
      String(cc),
      /immutable/,
      `a content-hashed asset should be cached for a year, not revalidated on every load; got ` +
        `${String(cc)} (#cache)`,
    );
  });
});
