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
  assert.equal(parseArgs(["--host", "localhost"]).hostOverride, "localhost");
});

test("everything at once", () => {
  const r = parseArgs(["--port", "3000", "--host", "0.0.0.0", "--config", "x.json"]);
  assert.deepEqual(r, { cfgArg: "x.json", portOverride: 3000, hostOverride: "0.0.0.0", help: false });
});

test("a non-numeric --port is DROPPED, not carried as NaN (#index)", () => {
  const r = parseArgs(["--port", "notanumber"]);
  assert.equal(r.portOverride, undefined, "a mistyped port must not become NaN");
  assert.ok(!Number.isNaN(r.portOverride as unknown as number));
});

test("--port with no value does not throw", () => {
  assert.doesNotThrow(() => parseArgs(["--port"]));
  assert.equal(parseArgs(["--port"]).portOverride, undefined);
});

test("the FIRST bare word is the config, later ones are ignored", () => {
  assert.equal(parseArgs(["a.json", "b.json"]).cfgArg, "a.json");
});

test("--config wins over a positional", () => {
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
  assert.equal(parseArgs(["--acp"]).cfgArg, undefined);
});

test("--flag=value works for every flag, not just the space-separated form", () => {
  const r = parseArgs(["--host=0.0.0.0", "--port=8080", "--config=x.json"]);
  assert.deepEqual(
    r,
    { cfgArg: "x.json", portOverride: 8080, hostOverride: "0.0.0.0", help: false },
    "every flag must accept both `--flag value` and `--flag=value`",
  );
});

test("both spellings can be mixed, and a bare path still wins the config slot", () => {
  assert.equal(parseArgs(["c.json", "--host=1.2.3.4"]).cfgArg, "c.json");
  assert.equal(parseArgs(["--host=1.2.3.4", "c.json"]).hostOverride, "1.2.3.4");
  assert.equal(parseArgs(["--port=1", "--host", "h"]).hostOverride, "h");
});
