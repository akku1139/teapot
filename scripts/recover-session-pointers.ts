#!/usr/bin/env node
/**
 * Recover the session pointers damaged by an accidental in-place `addAgent()` run.
 *
 * WHAT WENT WRONG (so this is never repeated):
 * `Master.addAgent()` resolves a session dir AND WRITES IT BACK to config.json.
 * Running it against the operator's REAL config + data dir therefore reassigned
 * every agent to a freshly minted, EMPTY session dir, orphaning the real ones.
 * The logs were never modified — only the pointers and the manifests were.
 *
 * SIGNALS, strongest first:
 *  1. each chat.jsonl's own `agent` field — authoritative, untouched
 *  2. the directory name `<agentId>-<8 hex>` — matched signal 1 in 513/513 dirs
 *  3. mtime, when an agent has several log-bearing incarnations: the one it was
 *     LAST WORKING in is the one config named
 *
 * Dry run by default; `--apply` writes.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const APPLY = process.argv.includes("--apply");
const HOME = os.homedir();
const ROOT = path.join(HOME, ".local", "share", "teapot-coding-agent", "sessions");
const CFG = path.join(HOME, ".config", "teapot-coding-agent", "config.json");

const cfg = JSON.parse(fs.readFileSync(CFG, "utf8"));
const dirs = fs.readdirSync(ROOT);

function inspect(d) {
  const log = path.join(ROOT, d, "chat.jsonl");
  let bytes = 0;
  let mtime = 0;
  let logOwner = null;
  try {
    const st = fs.statSync(log);
    bytes = st.size;
    mtime = st.mtimeMs;
  } catch {
    /* no log */
  }
  if (bytes > 0) {
    try {
      const first = fs.readFileSync(log, "utf8").split("\n").find((l) => l.trim());
      if (first) logOwner = JSON.parse(first).agent ?? null;
    } catch {
      /* unparsable head */
    }
  }
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(ROOT, d, "session.json"), "utf8")).agentId ?? null;
  } catch {
    /* missing/unreadable */
  }
  return { bytes, mtime, logOwner, manifest };
}

const info = new Map<string, ReturnType<typeof inspect>>(dirs.map((d) => [d, inspect(d)]));
/**
 * `info.get` with a real failure instead of `undefined`.
 *
 * Every key here comes from `dirs`, which `info` was built from, so a miss is impossible
 * by construction — but `Map.get` types as possibly-undefined and dereferencing it would
 * crash this recovery script halfway through rewriting session pointers. Throwing names
 * the directory instead.
 */
const stat = (d: string): ReturnType<typeof inspect> => {
  const v = info.get(d);
  if (!v) throw new Error(`internal: no stats for session dir ${d}`);
  return v;
};

const choices: {
  id: string;
  from: string | undefined;
  to: string;
  bytes: number;
  candidates: number;
}[] = [];
const problems: string[] = [];
for (const a of cfg.agents) {
  const re = new RegExp("^" + a.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-[0-9a-f]{8}$");
  const mine = dirs.filter((d) => re.test(d));
  const withLog = mine.filter((d) => stat(d).bytes > 0);
  if (!withLog.length) {
    problems.push(`${a.id}: no log-bearing dir among ${mine.length} candidate(s)`);
    continue;
  }
  const best = withLog.slice().sort((x, y) => stat(y).mtime - stat(x).mtime)[0];
  choices.push({
    id: a.id,
    from: a.session,
    to: best,
    bytes: stat(best).bytes,
    candidates: withLog.length,
  });
}

const claim = new Map<string, string>();
for (const c of choices) {
  if (claim.has(c.to)) problems.push(`dir ${c.to} claimed by BOTH ${claim.get(c.to)} and ${c.id}`);
  claim.set(c.to, c.id);
}

const changed = choices.filter((c) => c.from !== c.to);
const mfx = dirs.filter((d) => stat(d).manifest === "x").length;

console.log(`agents in config        : ${cfg.agents.length}`);
console.log(`session dirs on disk    : ${dirs.length}`);
console.log(`recovered (log found)   : ${choices.length}`);
console.log(`pointer actually changes: ${changed.length}`);
console.log(`manifests corrupted "x" : ${mfx}`);
console.log(`problems                : ${problems.length}`);
for (const p of problems.slice(0, 10)) console.log("   ! " + p);
console.log("\nmulti-candidate dirs (newest activity wins):");
for (const c of choices.filter((x) => x.candidates > 1)) {
  console.log(`  ${c.id} -> ${c.to} (${(c.bytes / 1000).toFixed(0)}kB) of ${c.candidates} candidates`);
}
console.log("\nsample mapping:");
for (const c of choices.slice(0, 5)) console.log(`  ${c.id.padEnd(34)} ${c.from ?? "(none)"} -> ${c.to}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.");
  process.exit(problems.length ? 2 : 0);
}

// 1. every manifest whose owner label is wrong/missing, from the LOG where it
//    exists (authoritative) and from the directory name otherwise
let fixedManifests = 0;
for (const d of dirs) {
  const i = stat(d);
  const owner = i.logOwner ?? d.replace(/-[0-9a-f]{8}$/, "");
  if (!owner) continue;
  if (i.manifest === owner) continue;
  fs.writeFileSync(path.join(ROOT, d, "session.json"), `${JSON.stringify({ v: 1, agentId: owner }, null, 2)}\n`);
  fixedManifests++;
}

// 2. point each agent back at its real session
// typed from the config itself, so a future field on an agent entry is visible here
const byId = new Map<string, (typeof cfg.agents)[number]>(cfg.agents.map((a) => [a.id, a]));
let fixedPointers = 0;
for (const c of choices) {
  const a = byId.get(c.id);
  if (!a || a.session === c.to) continue;
  a.session = c.to;
  fixedPointers++;
}
// atomic: a half-written config is worse than none (the #144 lesson)
const tmp = `${CFG}.recover-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
fs.renameSync(tmp, CFG);

console.log(`\nAPPLIED: ${fixedPointers} session pointers, ${fixedManifests} manifests.`);
console.log(`config written: ${CFG}`);
