#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const PKG = "teapot-coding-agent";
const version = process.argv[2];
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
    log(`HEAD failed: ${(err as Error).message}`);
    return 0;
  }
}

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
