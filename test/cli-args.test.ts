/**
 * The CLI argument parser.
 *
 * `index.ts` had NO test importing it — it was 48% branch covered, the second-lowest
 * in the repo. The parser decides which config file is read and which port is bound,
 * and a regression there starts the WRONG SERVER ON THE WRONG PORT with no error
 * anyone would read, so this is worth pinning.
 *
 * `parseArgs` was extracted from `main()` purely so it could be tested; the
 * behaviour is the same, except for one thing that was plainly wrong: a
 * non-numeric `--port` used to set `portOverride = NaN`, and `main` guarded the
 * apply with `!Number.isNaN` — so the flag was silently dropped two lines later,
 * with the parse result carrying a NaN nobody checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/index.ts";

test("a bare config path is taken positionally", () => {
  assert.equal(parseArgs(["teapot.json"]).cfgArg, "teapot.json");
});

test("the long and short flags both work", () => {
  assert.equal(parseArgs(["--config", "a.json"]).cfgArg, "a.json");
  assert.equal(parseArgs(["-c", "a.json"]).cfgArg, "a.json");
  assert.equal(parseArgs(["--port", "8080"]).portOverride, 8080);
  assert.equal(parseArgs(["-p", "8080"]).portOverride, 8080);
});

test("--host takes the next argument verbatim", () => {
  assert.equal(parseArgs(["--host", "0.0.0.0"]).hostOverride, "0.0.0.0");
  // NOT Number()-coerced: an address is not a number, and this flag sits next to
  // --port, where the temptation to parse both the same way is obvious
  assert.equal(parseArgs(["--host", "localhost"]).hostOverride, "localhost");
});

test("everything at once", () => {
  const r = parseArgs(["--port", "3000", "--host", "0.0.0.0", "--config", "x.json"]);
  assert.deepEqual(r, { cfgArg: "x.json", portOverride: 3000, hostOverride: "0.0.0.0", help: false });
});

test("a non-numeric --port is DROPPED, not carried as NaN (#index)", () => {
  // it used to be set to NaN and then discarded two lines later; the parse result
  // itself now never holds a NaN that a caller might apply blindly
  const r = parseArgs(["--port", "notanumber"]);
  assert.equal(r.portOverride, undefined, "a mistyped port must not become NaN");
  assert.ok(!Number.isNaN(r.portOverride as unknown as number));
});

test("--port with no value does not throw", () => {
  assert.doesNotThrow(() => parseArgs(["--port"]));
  assert.equal(parseArgs(["--port"]).portOverride, undefined);
});

test("the FIRST bare word is the config, later ones are ignored", () => {
  // a stray positional must not silently replace the config path
  assert.equal(parseArgs(["a.json", "b.json"]).cfgArg, "a.json");
});

test("--config wins over a positional", () => {
  // an explicit flag is a deliberate choice, so a bare word must not take precedence
  assert.equal(parseArgs(["a.json", "--config", "b.json"]).cfgArg, "b.json");
});

test("help is recognised in both forms and does not parse the rest", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--port", "8080"]).help, false);
});

test("an empty argv is not help and sets nothing", () => {
  const r = parseArgs([]);
  assert.deepEqual(r, { cfgArg: undefined, portOverride: undefined, hostOverride: undefined, help: false });
});

test("an unknown dashed flag is ignored, not treated as a config path", () => {
  // `--acp` is documented in --help and handled elsewhere; it must not become the
  // config filename, which is how a bare-word rule goes wrong
  assert.equal(parseArgs(["--acp"]).cfgArg, undefined);
});
