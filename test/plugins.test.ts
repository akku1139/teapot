/**
 * Agent Plugins (#162) — `plugin.json` loading.
 *
 * The format's value is that it needs almost no new machinery: `skills/` is a skill
 * root and `mcp.json` is the same server shape teapot already has. What DOES need care
 * is validation, and in particular containment: a plugin is third-party code that
 * arrives as a directory (usually an extracted archive), so a symlink inside it is the
 * way a package escapes its own root. The spec makes containment a MUST, and these
 * tests are what prove this implementation enforces it rather than trusting the path
 * string.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import path from "node:path";
import { useTempDirs } from "./helpers/tmp.ts";
import { loadPlugin, loadPlugins, PluginError } from "../src/agent/plugins.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

// POSIX-only: symlink() needs a privilege Windows does not grant by default, and the
// containment tests are built on symlinks.
markPosixOnly("symlinks for containment tests");

const MANIFEST = (name = "demo", extra: Record<string, unknown> = {}) => ({
  $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
  name,
  ...extra,
});

/** write a plugin tree from a {path: content} map, creating dirs as needed */
async function tree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

test("a minimal plugin loads: manifest, skills, mcp servers (#162)", async () => {
  await useTempDirs(["plug-a-", "plug-data-"], async ([root, data]) => {
    await tree(root, {
      "plugin.json": JSON.stringify(
        MANIFEST("reports", { version: "1.2.0", description: "make reports" }),
      ),
      "skills/summarize/SKILL.md": "# summarize\n\nsummarize things\n",
      "skills/deploy/SKILL.md": "# deploy\n",
      // a directory with no SKILL.md is not a skill
      "skills/notaskill/README.md": "nope",
      "mcp.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json",
        mcpServers: {
          db: { type: "streamable-http", url: "https://example.com/mcp" },
        },
      }),
    });
    const p = await loadPlugin(root, data);
    assert.equal(p.name, "reports");
    assert.equal(p.version, "1.2.0");
    assert.equal(p.description, "make reports");
    // PRECONDITION: only the two dirs with SKILL.md count, and not the third
    assert.deepEqual(p.skills.sort(), ["deploy", "summarize"]);
    assert.ok(p.skillsDir, "the skills dir must be exposed so it can become a skill root");
    assert.equal(p.mcpServers.length, 1);
    assert.equal(p.mcpServers[0]!.name, "db");
    assert.equal(p.mcpServers[0]!.transport, "http");
    assert.equal(p.mcpServers[0]!.url, "https://example.com/mcp");
    assert.deepEqual(p.warnings, [], "a valid plugin must not warn");
  });
});

test("a manifest without $schema or name is rejected (#162)", async () => {
  await useTempDirs(["plug-b-", "plug-datab-"], async ([root, data]) => {
    await tree(root, { "plugin.json": JSON.stringify({ name: "x" }) });
    await assert.rejects(
      () => loadPlugin(root, data),
      (e: Error) => e instanceof PluginError && /\$schema/.test(e.message),
      "the spec requires $schema — guessing a version would half-load a v2 plugin",
    );

    await tree(root, {
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
      }),
    });
    await assert.rejects(
      () => loadPlugin(root, data),
      (e: Error) => e instanceof PluginError && /name/.test(e.message),
    );
  });
});

test("an invalid plugin name is refused — '..' is a traversal primitive (#162)", async () => {
  await useTempDirs(["plug-c-", "plug-datac-"], async ([root, data]) => {
    // "" is reported as MISSING (the more accurate message), so it is not in this
    // list — it is covered by its own assertion below.
    for (const bad of ["..", "a..b", "Upper", "-lead", "a--b", "trailing-", ".lead"]) {
      await tree(root, { "plugin.json": JSON.stringify(MANIFEST(bad)) });
      await assert.rejects(
        () => loadPlugin(root, data),
        (e: Error) => e instanceof PluginError && /not a valid Agent Plugins name/.test(e.message),
        `name ${JSON.stringify(bad)} must be refused — it is used in paths and tool namespaces`,
      );
    }
    // an empty name is "missing", not "invalid" — better for the operator
    await tree(root, { "plugin.json": JSON.stringify(MANIFEST("")) });
    await assert.rejects(
      () => loadPlugin(root, data),
      (e: Error) => e instanceof PluginError && /missing name/.test(e.message),
    );
    // and a good one is accepted, so the test is not rejecting everything
    await tree(root, { "plugin.json": JSON.stringify(MANIFEST("ok-name.1")) });
    assert.equal((await loadPlugin(root, data)).name, "ok-name.1");
  });
});

test("a SYMLINKED skill pointing outside the plugin root is skipped (#162)", async () => {
  // This is the case the spec's containment rule exists for: the plugin directory is
  // usually an extracted archive, and a symlink can point anywhere the user can read.
  // Checking the literal path would pass; only a realpath check catches it.
  await useTempDirs(["plug-d-", "plug-datad-", "plug-outside-"], async ([root, data, outside]) => {
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "SKILL.md"), "# stolen\n");
    await tree(root, {
      "plugin.json": JSON.stringify(MANIFEST("sneaky")),
      "skills/good/SKILL.md": "# good\n",
    });
    await mkdir(path.join(root, "skills"), { recursive: true });
    await symlink(outside, path.join(root, "skills", "evil"));

    const p = await loadPlugin(root, data);
    // PRECONDITION: the symlink really does resolve outside, or this proves nothing
    const real = await readFile(path.join(outside, "SKILL.md"), "utf8");
    assert.match(real, /stolen/);
    assert.deepEqual(p.skills, ["good"], "only the contained skill may be loaded");
    assert.ok(
      p.warnings.some((w) => /evil.*outside the plugin root/.test(w)),
      `the escape must be REPORTED, not silently dropped: ${JSON.stringify(p.warnings)}`,
    );
  });
});

test("a symlinked plugin.json escaping the root is refused (#162)", async () => {
  await useTempDirs(["plug-e-", "plug-datae-", "plug-oute-"], async ([root, data, outside]) => {
    await mkdir(outside, { recursive: true });
    await writeFile(
      path.join(outside, "plugin.json"),
      JSON.stringify(MANIFEST("fromoutside")),
    );
    await symlink(path.join(outside, "plugin.json"), path.join(root, "plugin.json"));
    await assert.rejects(
      () => loadPlugin(root, data),
      (e: Error) => e instanceof PluginError && /outside the plugin root/.test(e.message),
    );
  });
});

test("${PLUGIN_ROOT} and ${PLUGIN_DATA} expand in a stdio server (#162)", async () => {
  // The spec requires expansion in args, env and cwd. Without it a plugin's own server
  // cannot find its own files, which is the entire reason the variables exist.
  await useTempDirs(["plug-f-", "plug-dataf-"], async ([root, data]) => {
    await tree(root, {
      "plugin.json": JSON.stringify(MANIFEST("std")),
      "mcp.json": JSON.stringify({
        mcpServers: {
          local: {
            type: "stdio",
            command: "./bin/server",
            args: ["--data", "${PLUGIN_DATA}/store"],
            env: { CONFIG: "${PLUGIN_ROOT}/config.json" },
            cwd: "${PLUGIN_ROOT}",
          },
        },
      }),
    });
    const p = await loadPlugin(root, data);
    assert.equal(p.mcpServers.length, 1, `warnings: ${JSON.stringify(p.warnings)}`);
    const s = p.mcpServers[0]!;
    assert.equal(s.transport, "stdio");
    // the plugin-relative command is resolved against the root
    assert.equal(s.command, path.join(root, "bin", "server"));
    assert.deepEqual(s.args, ["--data", path.join(data, "store")]);
    assert.deepEqual(s.env, { CONFIG: path.join(root, "config.json") });
    assert.equal((s as { cwd?: string }).cwd, root);
  });
});

test("a stdio cwd that escapes the root invalidates only THAT server (#162)", async () => {
  // The spec's failure boundary is per-server: one bad entry must not reject the
  // plugin, or a single typo would silently disable an unrelated good server.
  await useTempDirs(["plug-g-", "plug-datag-"], async ([root, data]) => {
    await tree(root, {
      "plugin.json": JSON.stringify(MANIFEST("mixed")),
      "mcp.json": JSON.stringify({
        mcpServers: {
          bad: { type: "stdio", command: "node", cwd: "../../etc" },
          bare: { type: "stdio", command: "node", cwd: "data" },
          good: { type: "streamable-http", url: "https://example.com/mcp" },
        },
      }),
    });
    const p = await loadPlugin(root, data);
    assert.deepEqual(
      p.mcpServers.map((s) => s.name),
      ["good"],
      `only the contained server may survive: ${JSON.stringify(p.warnings)}`,
    );
    assert.equal(p.warnings.length, 2, `both bad entries must be reported: ${JSON.stringify(p.warnings)}`);
    // both are REFUSED for a cwd reason; which of the two rules fires (a traversal that
    // also fails the "./" form check) is an implementation detail, so the assertion is
    // on the outcome — the entry is named, and the reason is the cwd.
    assert.ok(p.warnings.some((w) => /"bad".*cwd/.test(w)), JSON.stringify(p.warnings));
    assert.ok(p.warnings.some((w) => /"bare".*cwd/.test(w)), JSON.stringify(p.warnings));
  });
});

test("env may not set PLUGIN_ROOT or PLUGIN_DATA (#162)", async () => {
  // The client owns those two; letting a plugin set them is how one redirects the
  // expansion of its OWN paths (and, in a chain of plugins, another's).
  await useTempDirs(["plug-h-", "plug-datah-"], async ([root, data]) => {
    await tree(root, {
      "plugin.json": JSON.stringify(MANIFEST("env")),
      "mcp.json": JSON.stringify({
        mcpServers: {
          x: { type: "stdio", command: "node", env: { PLUGIN_ROOT: "/etc" } },
        },
      }),
    });
    const p = await loadPlugin(root, data);
    assert.equal(p.mcpServers.length, 0, "the server must be refused");
    assert.ok(p.warnings.some((w) => /may not set PLUGIN_ROOT/.test(w)));
  });
});

test("an unknown server type is reported per-entry (#162)", async () => {
  await useTempDirs(["plug-i-", "plug-datai-"], async ([root, data]) => {
    await tree(root, {
      "plugin.json": JSON.stringify(MANIFEST("unknown")),
      "mcp.json": JSON.stringify({ mcpServers: { w: { type: "websocket", url: "ws://x" } } }),
    });
    const p = await loadPlugin(root, data);
    assert.equal(p.mcpServers.length, 0);
    assert.ok(
      p.warnings.some((w) => /unknown type "websocket"/.test(w)),
      `the message must name what arrived: ${JSON.stringify(p.warnings)}`,
    );
  });
});

test("a plugin with no skills/ and no mcp.json loads cleanly (#162)", async () => {
  // §6.2: a missing component location is not an error. A manifest-only plugin is
  // valid, and treating it as broken would reject a plugin whose components are all
  // client extensions.
  await useTempDirs(["plug-j-", "plug-dataj-"], async ([root, data]) => {
    await tree(root, { "plugin.json": JSON.stringify(MANIFEST("bare")) });
    const p = await loadPlugin(root, data);
    assert.equal(p.name, "bare");
    assert.deepEqual(p.skills, []);
    assert.equal(p.skillsDir, undefined);
    assert.deepEqual(p.mcpServers, []);
    assert.deepEqual(p.warnings, []);
  });
});

test("a directory of plugins skips the broken ones and keeps the rest (#162)", async () => {
  // Third-party code: one bad plugin must not stop the operator's other plugins from
  // working, and the failure must be REPORTED (the caller logs it).
  await useTempDirs(["plug-k-", "plug-datak-"], async ([root, data]) => {
    await tree(root, {
      "good/plugin.json": JSON.stringify(MANIFEST("good")),
      "good/skills/s/SKILL.md": "# s\n",
      "broken/plugin.json": "{ not json",
      "notaplugin/readme.md": "no manifest here",
    });
    const { plugins, errors } = await loadPlugins(root, data);
    assert.deepEqual(plugins.map((p) => p.name), ["good"]);
    // two failures: invalid JSON, and a directory with no manifest at all
    assert.equal(errors.length, 2, `expected both failures reported: ${JSON.stringify(errors)}`);
    assert.ok(errors.some((e) => /not valid JSON/.test(e.error)));
    assert.ok(errors.some((e) => /no plugin.json/.test(e.error)));
  });
});

test("a missing plugins directory is empty, not an error (#162)", async () => {
  // The default location does not exist until someone installs a plugin, and a boot
  // that errors on that would break every fresh install.
  const { plugins, errors } = await loadPlugins("/nonexistent/plugins/dir", "/tmp/data");
  assert.deepEqual(plugins, []);
  assert.deepEqual(errors, []);
});

test("two plugins with a same-named MCP server both survive (#162)", async () => {
  // Each plugin's `mcp.json` names its servers locally ("db"), and two plugins may each
  // have one. The registry keys by NAME, so an unqualified collision silently replaces
  // one with the other — and the loser's tools simply never appear, which looks like the
  // plugin being broken rather than a naming clash. Master qualifies each server with
  // its plugin name; this drives that path through a real boot.
  const { Master } = await import("../src/master.ts");
  await useTempDirs(["plug-m-", "plug-datam-", "plug-ws-"], async ([root, data, ws]) => {
    await tree(root, {
      "one/plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
        name: "one",
      }),
      "one/mcp.json": JSON.stringify({
        mcpServers: { db: { type: "streamable-http", url: "http://127.0.0.1:1/mcp" } },
      }),
      "two/plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
        name: "two",
      }),
      "two/mcp.json": JSON.stringify({
        mcpServers: {
          db: { type: "streamable-http", url: "http://127.0.0.1:2/mcp" },
          cache: { type: "streamable-http", url: "http://127.0.0.1:3/mcp" },
        },
      }),
    });
    const m = new Master(
      { port: 0, dataDir: data, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, pluginsDir: root, agents: [] },
      "/dev/null",
    );
    // NO start(): that binds a port and arms a timer. The plugin load is its own
    // method precisely so the qualification logic can be driven directly.
    const allMcp = await m.loadPluginsAndMcp();
    {
      const { mcp } = await import("../src/agent/mcp-registry.ts");
      mcp.apply(allMcp);
      try {
      assert.equal(m.plugins.length, 2);
      // PRECONDITION: both plugins really do name a server "db"
      assert.deepEqual(m.plugins.flatMap((p) => p.mcpServers.map((s) => s.name)).sort(), [
        "cache",
        "db",
        "db",
      ]);
      // and the registry has all THREE, qualified — nothing was replaced
      const names = mcp.names().sort();
      assert.deepEqual(
        names.filter((n) => n.startsWith("one:") || n.startsWith("two:")),
        ["one:db", "two:cache", "two:db"],
        `both plugins' servers must be registered under their own names: ${JSON.stringify(names)}`,
      );
      } finally {
        await mcp.closeAll();
      }
      void ws;
    }
  });
});
