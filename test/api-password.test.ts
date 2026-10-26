import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Master, loadConfig } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import { useTempDir } from "./helpers/tmp.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function mkApp(dir: string) {
  const master = new Master(
    { port: 0, dataDir: dir, llm: LLM, providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } }, agents: [] },
    `${dir}/config.json`,
  );
  return { master, app: buildApp(master) };
}

test("PUT /api/config sets the password and it reaches the FILE (#auth)", async () => {
  await useTempDir("teapot-auth-", async (dir) => {
    const { app } = mkApp(dir);
    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    });
    assert.equal(res.status, 200, `the save must be accepted: ${await res.text()}`);

    const onDisk = JSON.parse(await readFile(`${dir}/config.json`, "utf8")) as { password?: string };
    assert.equal(onDisk.password, "hunter2", "the password must be persisted, not merely held in memory");

    const reloaded = loadConfig(`${dir}/config.json`);
    assert.equal(reloaded.password, "hunter2", "a restart must see the password — that is the whole point");
  });
});

test("the password takes effect on the NEXT request, with no restart (#auth)", async () => {
  await useTempDir("teapot-auth-live-", async (dir) => {
    const { app } = mkApp(dir);
    assert.equal((await app.request("/api/config")).status, 200);

    await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    });

    const denied = await app.request("/api/config");
    assert.equal(
      denied.status,
      401,
      "an unauthenticated request must be refused immediately after the password is set (#auth)",
    );
    const allowed = await app.request("/api/config", { headers: { authorization: "Bearer hunter2" } });
    assert.equal(allowed.status, 200, "and the configured token must be accepted");
  });
});

test("an EMPTY password clears it, returning to loopback-only trust (#auth)", async () => {
  await useTempDir("teapot-auth-clear-", async (dir) => {
    const { master, app } = mkApp(dir);
    await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    });
    assert.equal((await app.request("/api/config")).status, 401);

    await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer hunter2" },
      body: JSON.stringify({ password: "" }),
    });
    assert.equal(master.config.password, undefined, "an empty password clears the field");
    assert.equal((await app.request("/api/config")).status, 200, "and the API is open again");
    const onDisk = JSON.parse(await readFile(`${dir}/config.json`, "utf8")) as { password?: string };
    assert.equal(onDisk.password, undefined, "the cleared state must also reach the file (#67)");
  });
});

test("GET /api/config reports WHETHER a password is set, never the value (#auth)", async () => {
  await useTempDir("teapot-auth-fact-", async (dir) => {
    const { app } = mkApp(dir);
    const before = (await (await app.request("/api/config")).json()) as { hasPassword?: boolean };
    assert.equal(before.hasPassword, false, "a fresh install says so plainly");

    await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "s3cret" }),
    });
    const authed = await app.request("/api/config", { headers: { authorization: "Bearer s3cret" } });
    const after = (await authed.json()) as { hasPassword?: boolean; password?: unknown };
    assert.equal(after.hasPassword, true, "the panel needs the fact to label the field honestly");
    assert.equal(
      after.password,
      undefined,
      "the SECRET itself must never be sent back — that would put it in the DOM and in any capture",
    );
  });
});
