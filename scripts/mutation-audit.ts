// Mutation-audit the test suite: break production code, see which tests notice.
//
// This is the only honest measure of "does the suite catch bugs". A passing suite
// says nothing about that — #40 shipped three "fixes" with green tests, because
// the tests asserted on helper functions and source strings rather than on the
// wiring. A mutation that no test catches is a place where a real regression
// would also slip through.
//
// Each mutation is reverted immediately, and the whole run is read-only apart from
// that (it restores from git, not from a copy).
//
// Usage: node scripts/mutation-audit.mjs [--only <substring>]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * name, file, find, replace
 *
 * Chosen for CRITICAL paths — where a silent bug costs data or corrupts the
 * timeline — not for easy coverage.
 */
const MUTATIONS = [
  {
    name: "session gate: accept every frame's session",
    file: "frontend/session-scope.ts",
    find: "return frameSession === shown;",
    replace: "return true;",
  },
  {
    name: "session gate: reject the fallback view",
    file: "frontend/session-scope.ts",
    find: "if (agentId && shown === agentId) return true; // fallback view — refusing this is #54",
    replace: "",
  },
  {
    name: "timeline: do not sort (delivery position lost)",
    file: "frontend/timeline-order.ts",
    find: "if (!echoes.length) return [...visible].sort((a, b) => a.seq - b.seq);",
    replace: "if (!echoes.length) return visible;",
  },
  {
    name: "live buffer: keep a covered buffer",
    file: "frontend/live-buffer.ts",
    find: "if (!isLiveStatus(status)) return true;",
    replace: "",
  },
  {
    name: "scroll: treat growth as a scroll away",
    file: "frontend/scroll-follow.ts",
    find: "return now.top < prev.top;",
    replace: "return now.gap > prev.gap;",
  },
  {
    name: "composer: write the value during a composition",
    file: "frontend/composer-ime.ts",
    find: "return !composing;",
    replace: "return true;",
  },
  {
    name: "model switch: carry the old provider's model across",
    file: "frontend/model-selection.ts",
    find: "if (fallback) return fallback;",
    replace: "",
  },
  {
    name: "session manifest: trust a wrong owner",
    file: "src/master.ts",
    find: "const mineByManifest = owner === null || owner === agentId;",
    replace: "const mineByManifest = true;",
  },
  {
    name: "nested: wait only on direct children",
    file: "src/master.ts",
    // a REAL behavioural change: drop the descendant expansion too, or the
    // `named` line alone is compensated and the mutation proves nothing
    find: "const named = ids && ids.length ? ids : this.descendantsOf(parentId);\n    const targets = [...new Set(named.flatMap((id) => [id, ...this.descendantsOf(id)]))].filter((id) =>\n      this.agents.has(id),\n    );",
    replace: "const targets = this.childrenOf(parentId).map((c) => c.id).filter((id) => this.agents.has(id));",
  },
  {
    name: "nested: wake only the direct parent",
    file: "src/master.ts",
    // walk no further up than the first ancestor
    find: "      this.wakeParentWaiters(cur);\n      cur = this.config.agents.find((a) => a.id === cur)?.parent;",
    replace: "      this.wakeParentWaiters(cur);\n      cur = undefined;",
  },
  // NOTE: "read the whole log instead of the tail" is deliberately NOT here. It is
  // performance-only — the same seq and lastEventId come out either way — so no
  // behaviour test can catch it, and listing it would report a false gap.
  {
    name: "tool row: capture the result prop again",
    file: "frontend/App.tsx",
    find: "const res = () => props.res;",
    replace: "const res = () => (props.res as Ev | undefined) && undefined; void props.res; const _r = () => props.res;",
  },
  {
    name: "idle close: never release the descriptor",
    file: "src/log/events.ts",
    find: "    if (!this.stream) return;\n    // a later append re-armed the timer — let that deadline own the close\n    if (this.idleTimer) return;",
    replace: "    if (!this.stream) return;\n    return; // mutated: never close",
  },
];

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;

/**
 * The tests that COULD catch a change to `file`: the ones that import it, directly
 * or transitively. Running the whole suite would take ~20 minutes per mutation and
 * add nothing — a test file that never loads the module cannot observe it.
 */
function relevantTests(file) {
  const all = fs.readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
  const direct = all.filter((t) => {
    const src = fs.readFileSync(t, "utf8");
    const rel = path.relative("test", file).replace(/\\/g, "/").replace(/\.tsx?$/, "");
    return src.includes(`../${rel}`) || src.includes(rel);
  });
  // files that only assert on source text still COUNT here: they are exactly the
  // ones this audit is asking about
  const srcAsserters = all.filter((t) => {
    const src = fs.readFileSync(t, "utf8");
    return /readSource|readFileSync/.test(src) && new RegExp(path.basename(file)).test(src);
  });
  return [...new Set([...direct, ...srcAsserters])];
}

const run = (files) => {
  try {
    execFileSync("node", ["--test", ...files], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    });
    return { failed: 0, names: [] };
  } catch (e) {
    const err = e as { stdout?: unknown; stderr?: unknown };
    const out = String(err.stdout ?? "") + String(err.stderr ?? "");
    const names = [...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]);
    return { failed: names.length, names };
  }
};

const results: { name: string; caught: boolean; count: number; names: string[] }[] = [];
for (const mut of MUTATIONS) {
  if (only && !mut.name.includes(only)) continue;
  const src = fs.readFileSync(mut.file, "utf8");
  if (!src.includes(mut.find)) {
    console.log(`SKIP (pattern not found): ${mut.name}  [${mut.file}]`);
    continue;
  }
  const relevant = relevantTests(mut.file);
  fs.writeFileSync(mut.file, src.replace(mut.find, mut.replace));
  try {
    const { failed, names } = run(relevant);
    results.push({ name: mut.name, caught: failed > 0, count: failed, names: names.slice(0, 4) });
    console.log(
      `${failed > 0 ? "caught " : "MISSED "} (${String(failed).padStart(2)} of ${String(relevant.length).padStart(2)} tests) ${mut.name}`,
    );
    if (failed === 0) console.log(`        ^^ NO TEST NOTICES THIS`);
  } finally {
    execFileSync("git", ["checkout", "--", mut.file]);
  }
}

const missed = results.filter((r) => !r.caught);
console.log(`\n${results.length} mutations | caught: ${results.length - missed.length} | MISSED: ${missed.length}`);
for (const m of missed) console.log(`  MISSED: ${m.name}`);
