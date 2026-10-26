import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Master, loadConfig } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import { useTempDir } from "./helpers/tmp.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

const PALETTE = {
  bgDarkest: "#1a1c22",
  bgDark: "#232630",
  bgMid: "#2b2e39",
  bgLight: "#343845",
  fg: "#e6e8ee",
  dim: "#9aa1b1",
  line: "#3a3f4d",
  acc: "#6aa8ff",
  ok: "#3ba55d",
  warn: "#e0a33e",
  err: "#ed4245",
  tool: "#9b7bff",
  termBg: "#14161b",
  termFg: "#d6d9e0",
};

const THEME = {
  id: "custom-probe",
  label: "probe ★",
  mode: "dark",
  surfaceAlpha: 0.82,
  backgroundDim: 0.9,
  backgroundImage: "/api/assets/abc123.png",
  palette: PALETTE,
};

function mkMaster(dataDir: string, configPath: string): Master {
  return new Master({ port: 0, dataDir, llm: LLM, providers: {}, agents: [] }, configPath);
}

test("PUT /api/themes writes the theme to the config FILE (#themes-server)", async () => {
  await useTempDir("teapot-themes-", async (dir) => {
    const configPath = `${dir}/config.json`;
    const master = mkMaster(dir, configPath);
    const app = buildApp(master);

    const res = await app.request("/api/themes", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ themes: [THEME], prefs: { fixed: "custom-probe", auto: false } }),
    });
    assert.equal(res.status, 200, "the write must be accepted");

    const onDisk = JSON.parse(await readFile(configPath, "utf8")) as {
      customThemes?: { id?: string; backgroundImage?: string }[];
      themePrefs?: { fixed?: string };
    };
    assert.ok(
      Array.isArray(onDisk.customThemes),
      "customThemes must reach the FILE — a theme that lives only in `config` is lost on restart (#67)",
    );
    assert.equal(onDisk.customThemes!.length, 1, "the theme list must be written whole");
    assert.equal(onDisk.customThemes![0]!.id, "custom-probe", "the theme must round-trip by identity");
    assert.equal(
      onDisk.customThemes![0]!.backgroundImage,
      "/api/assets/abc123.png",
      "the background image URL must survive — a theme that loses its wallpaper is not the theme",
    );
    assert.equal(onDisk.themePrefs?.fixed, "custom-probe", "themePrefs must persist or slots reset on restart");

    const reloaded = loadConfig(configPath);
    assert.equal(
      (reloaded.customThemes as { id?: string }[] | undefined)?.[0]?.id,
      "custom-probe",
      "a restart must see the theme — this is what localStorage-only could never do",
    );
  });
});

test("GET /api/themes answers with an array even before anything is stored", async () => {
  await useTempDir("teapot-themes-empty-", async (dir) => {
    const app = buildApp(mkMaster(dir, `${dir}/config.json`));
    const res = await app.request("/api/themes");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { themes?: unknown };
    assert.ok(
      Array.isArray(body.themes),
      "the frontend treats [] as 'push mine up'; an undefined would read as a failed load instead",
    );
    assert.equal((body.themes as unknown[]).length, 0, "an install with no themes answers with no themes");
  });
});

test("a malformed themes payload is refused rather than half-applied", async () => {
  await useTempDir("teapot-themes-bad-", async (dir) => {
    const app = buildApp(mkMaster(dir, `${dir}/config.json`));
    const res = await app.request("/api/themes", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ themes: ["not-an-object"] }),
    });
    assert.equal(res.status, 400, "a non-object theme must be refused, not stored and crashed on later");
  });
});
