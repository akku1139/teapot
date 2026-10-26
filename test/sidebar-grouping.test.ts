import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sidebarRowsOf, treeRowsOf, workspaceOf } from "../frontend/lib/sidebar-tree.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("POSIX filesystem paths");

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

const agentsOf = (rows: { id: string; parent: string; workspace: string }[]) => rows;

test("a sub-agent groups with its PARENT's workspace (#18)", () => {
  const agents = [
    { id: "root", parent: "", workspace: "/tmp/proj" },
    { id: "child", parent: "root", workspace: "" },
  ];
  assert.equal(workspaceOf(agentsOf(agents), "child"), "/tmp/proj", "a sub-agent must inherit (#18)");
});

test("a parent cycle does not hang or return empty (#18)", () => {
  const agents = [
    { id: "a", parent: "b", workspace: "/x" },
    { id: "b", parent: "a", workspace: "" },
  ];
  assert.equal(typeof workspaceOf(agentsOf(agents), "a"), "string");
});

test("a header appears only when the workspace changes (#18)", () => {
  const agents = [
    { id: "a1", parent: "", workspace: "/p1" },
    { id: "a2", parent: "", workspace: "/p1" },
    { id: "b1", parent: "", workspace: "/p2" },
  ];
  const rows = sidebarRowsOf(
    agentsOf(agents),
    treeRowsOf(agentsOf(agents), new Set(), false, new Set()),
    new Set(),
  );
  assert.deepEqual(
    rows.filter((r) => r.headerOnly).map((r) => r.wsHeader),
    ["/p1", "/p2"],
    "one header per directory, in first-seen order (#18)",
  );
  assert.deepEqual(
    rows.filter((r) => !r.headerOnly).map((r) => r.a.id),
    ["a1", "a2", "b1"],
    "every agent still appears exactly once (#18)",
  );
});

test("each project gets exactly one header (#18)", () => {
  const agents = [
    { id: "a1", parent: "", workspace: "/p1" },
    { id: "a2", parent: "", workspace: "/p1" },
    { id: "b1", parent: "", workspace: "/p2" },
    { id: "c1", parent: "", workspace: "/p3" },
  ];
  const rows = sidebarRowsOf(
    agentsOf(agents),
    treeRowsOf(agentsOf(agents), new Set(), false, new Set()),
    new Set(),
  );
  assert.equal(
    rows.filter((r) => r.headerOnly).length,
    3,
    `three projects → three headers (#18); got ${JSON.stringify(rows.filter((r) => r.headerOnly))}`,
  );
  assert.deepEqual(
    rows.filter((r) => r.headerOnly).map((r) => r.wsHeader),
    ["/p1", "/p2", "/p3"],
    "in first-seen order, so the sidebar does not reshuffle (#62)",
  );
});

test("an agent with no workspace does not get a stray header (#18)", () => {
  const agents = [
    { id: "x", parent: "", workspace: "" },
    { id: "y", parent: "", workspace: "/p" },
  ];
  const rows = sidebarRowsOf(
    agentsOf(agents),
    treeRowsOf(agentsOf(agents), new Set(), false, new Set()),
    new Set(),
  );
  assert.deepEqual(
    rows.filter((r) => r.headerOnly).map((r) => r.wsHeader),
    ["/p"],
    `no workspace -> no header row (#18); got ${JSON.stringify(rows.filter((r) => r.headerOnly))}`,
  );
  assert.ok(
    rows.filter((r) => !r.headerOnly).some((r) => r.a.id === "x"),
    "and the agent itself is still listed (#18)",
  );
});

test("the header is styled (#18)", () => {
  assert.match(css, /\.wsheader\s*\{/s, "the header needs its own style (#18)");
  assert.match(css, /\.wsheader \.wscaret/, "the collapse caret needs styling (#18)");
});

