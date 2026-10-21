#!/usr/bin/env node
/**
 * Wait for a just-published version's TARBALL to appear, then install it globally.
 *
 * ## Why this exists
 *
 * `npm publish` returning success does NOT mean the package is installable. The metadata and
 * the `latest` dist-tag update within seconds, but the tarball itself is served from a
 * different CDN path and lags — MEASURED at 5 to 20 minutes on this registry. A
 * `npm i -g pkg@x.y.z` issued too early fails with a 404 that looks like a broken release.
 *
 * Verifying that used to be a foreground `sleep` loop in the middle of a session, which
 * stalls everything else. It is one slow, dumb wait, so it belongs in a background job:
 *
 *     bash(background=true, command="node scripts/wait-npm-version.ts 0.29.48")
 *
 * ## What it checks
 *
 * 1. the tarball URL answers 200 (the real gate — dist-tags lie);
 * 2. `npm cache clean --force`, because a cached 404 is sticky;
 * 3. `npm i -g`, then the INSTALLED package.json version, which is the only proof that the
 *    thing on disk is the thing that was published.
 *
 * Exit 0 = installed and verified. Exit 1 = timed out (the report says what it saw).
 */
import { execFileSync } from "node:child_process";

const PKG = "teapot-coding-agent";
const version = process.argv[2];
/** how long to keep polling: the measured worst case is ~20 min, so allow headroom */
const TIMEOUT_MS = Number(process.env.WAIT_TIMEOUT_MS ?? 40 * 60_000);
const INTERVAL_MS = Number(process.env.WAIT_INTERVAL_MS ?? 20_000);

if (!version) {
  console.error("usage: node scripts/wait-npm-version.ts <version>");
  process.exit(2);
}

const tarball = `https://registry.npmjs.org/${PKG}/-/${PKG}-${version}.tgz`;

const log = (msg: string) => console.log(`[wait-npm ${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function head(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    return res.status;
  } catch (err) {
    // a network blip is not "not published yet", but it is also not fatal — keep polling
    log(`HEAD failed: ${(err as Error).message}`);
    return 0;
  }
}

/** the version actually installed, or "" when the package is not installed */
function installedVersion(): string {
  try {
    const out = execFileSync("npm", ["ls", "-g", "--json", PKG], { encoding: "utf8" });
    return JSON.parse(out).dependencies?.[PKG]?.version ?? "";
  } catch {
    return "";
  }
}

const deadline = Date.now() + TIMEOUT_MS;
let attempt = 0;
let sawMetadata = false;

while (Date.now() < deadline) {
  attempt++;
  // Informational only: the dist-tag flips BEFORE the tarball exists, which is the trap this
  // script exists to avoid. Reported so the log shows the two are not the same event.
  if (!sawMetadata) {
    const meta = await head(`https://registry.npmjs.org/${PKG}/${version}`);
    if (meta === 200) {
      sawMetadata = true;
      log(`metadata for ${version} is live; waiting for the tarball (this is the slow part)`);
    }
  }

  const status = await head(tarball);
  if (status === 200) {
    log(`tarball is live after ${attempt} attempt(s) — installing`);
    try {
      execFileSync("npm", ["cache", "clean", "--force"], { stdio: "ignore" });
      execFileSync("npm", ["i", "-g", `${PKG}@${version}`], { stdio: "inherit" });
    } catch (err) {
      // the tarball can 200 slightly before every CDN edge has it; keep trying
      log(`install failed, will retry: ${(err as Error).message.split("\n")[0]}`);
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
      continue;
    }
    const got = installedVersion();
    if (got === version) {
      log(`OK: ${PKG}@${got} is installed and verified`);
      process.exit(0);
    }
    log(`install reported success but the installed version is ${JSON.stringify(got)} — retrying`);
  } else {
    log(`attempt ${attempt}: tarball ${status}/200 — not published through the CDN yet`);
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

log(`TIMEOUT after ${Math.round(TIMEOUT_MS / 60000)}m: ${tarball} never returned 200`);
process.exit(1);
