/**
 * THE API PASSWORD IS SETTABLE FROM SETTINGS — the only way left, after the wizard was removed.
 *
 * Asked as "初回起動ウィザードは前に廃止したはずだからパスワード設定できないのでは?" — correct, and the
 * gap was real: the only path that ever accepted a password was `POST /api/setup`, which returns 409
 * as soon as a config file exists. So on every existing install there was NO way to set one, while
 * the startup banner kept telling the operator to "set TEAPOT_API_TOKEN or config.password".
 *
 * These tests drive the API, because the failure being prevented is the silent one: a password that
 * appears to save, comes back on GET, and is gone after a restart — leaving the server open while
 * the operator believes it is closed.
 */
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

    /**
     * The FILE is the assertion that matters, and it is the #67 trap: `saveConfig()` writes
     * `this.raw`, a hand-maintained mirror. A field absent from it exists in memory and in
     * `GET /api/config` and never reaches disk — so a password set here would silently expire on
     * the next restart.
     */
    const onDisk = JSON.parse(await readFile(`${dir}/config.json`, "utf8")) as { password?: string };
    assert.equal(onDisk.password, "hunter2", "the password must be persisted, not merely held in memory");

    const reloaded = loadConfig(`${dir}/config.json`);
    assert.equal(reloaded.password, "hunter2", "a restart must see the password — that is the whole point");
  });
});

test("the password takes effect on the NEXT request, with no restart (#auth)", async () => {
  await useTempDir("teapot-auth-live-", async (dir) => {
    const { app } = mkApp(dir);
    // open before
    assert.equal((await app.request("/api/config")).status, 200);

    await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    });

    /**
     * `apiToken()` reads `master.config.password` dynamically. If it were captured at construction,
     * the server would stay open until a restart WHILE REPORTING that a password was set — the
     * worst combination for a security control.
     */
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

    /**
     * `""` must be honoured as "remove it". A truthiness check would silently KEEP the old password
     * when the operator emptied the field, which is the one action that explicitly asks to turn the
     * protection off.
     */
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
