/**
 * #30 — an in-progress todo edit lost focus/caret whenever the right panel
 * re-rendered for an agent-update snapshot.
 *
 * The panel was gated on the agent OBJECT (`<Show when={sel()}>`). The
 * compiled children getter builds a fresh array on every `sel()` change, so a
 * new snapshot identity made Solid rebuild the whole right panel — taking the
 * focused textarea with it. Verified by staging the real UI: the editor
 * survived typing, saving and the /api/agents poll, and was recreated ONLY by
 * the websocket `agent-update` (sameNode=false, focus lost).
 *
 * Gating on the agent ID (keyed) rebuilds only when the operator actually
 * switches agent, which is the only case where discarding UI state is correct.
 * The editor is also its own component with primitive props, giving Solid a
 * stable element to keep.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

/* ---------- the gate ---------- */

test("the right panel is gated on the agent ID, not the object (#30)", () => {
  // `sel()!.id` / `sel()?.id` — anything but the bare object
  assert.match(
    app,
    /<Show when=\{sel\(\)\??\.id\} keyed/,
    "the panel must key on the agent id so a snapshot identity change is not a rebuild (#30)",
  );
});

test("nothing is gated on the agent object (#30)", () => {
  // both the outer layout gate and the right panel gate used `when={sel()}`,
  // and an object gate rebuilds its whole subtree on every snapshot
  assert.doesNotMatch(
    app,
    /<Show when=\{sel\(\)\}(?!\??\.)/,
    "no Show may gate on the agent OBJECT — a snapshot identity change then rebuilds it (#30)",
  );
});

test("the outermost panel gate is null-safe (#30)", () => {
  // `sel()!.id` at the outermost gate threw on first render when no agent was
  // selected: the bundle failed to import at all ("Cannot read properties of
  // undefined (reading 'id')"). Nested gates are fine — they sit inside it.
  assert.match(
    app,
    /<Show when=\{sel\(\)\?\.id\} keyed fallback=\{<div style="display:grid/,
    "the outermost gate must use sel()?.id (#30)",
  );
});


/* ---------- the editor component ---------- */

test("the tasks editor is its own component with primitive props (#30)", () => {
  assert.match(app, /function TodoEditor\(/, "the editor must be a component (#30)");
  const i = app.indexOf("function TodoEditor(");
  const body = app.slice(i, app.indexOf("\n}\n", i));
  // primitive props only — an object prop would change identity every render
  assert.match(body, /draft: string/, "draft must be a string prop (#30)");
  assert.match(body, /viewMode: boolean/, "viewMode must be a boolean prop (#30)");
  assert.match(body, /onDraft: \(text: string\) => void/, "onDraft must be a function prop (#30)");
  assert.doesNotMatch(body, /agent: Agent|sel\(\)/, "no agent-object props (#30)");
});

test("the editor component is used in the panel (#30)", () => {
  assert.match(app, /<TodoEditor\s+draft=\{todoDraft\(\)\}/, "the panel must render TodoEditor (#30)");
});

test("the editor keeps its id, handler and view toggle (#30)", () => {
  const i = app.indexOf("function TodoEditor(");
  const body = app.slice(i, app.indexOf("\n}\n", i));
  assert.match(body, /id="todo-input"/, "the editor must keep #todo-input (tests + styles) (#30)");
  assert.match(body, /oninput=\{\(e\) => props\.onDraft\(e\.currentTarget\.value\)\}/, "input still reports up (#30)");
  assert.match(body, /when=\{props\.viewMode\}/, "the view toggle still switches modes (#30)");
  assert.match(body, /renderMarkdownCached\(props\.draft\)/, "the checklist preview still renders (#30)");
});

/* ---------- the real check lives in the bundle smoke test ---------- */

test("the smoke test asserts node identity, not just the draft text (#30)", () => {
  const smoke = readFileSync(new URL("../scripts/smoke-web.mjs", import.meta.url), "utf8");
  assert.match(
    smoke,
    /after !== box/,
    "smoke must assert the editor NODE survives, since focus/caret loss was the bug (#30)",
  );
  assert.match(smoke, /activeElement/);
});

/* ---------- EACH gate is keyed, not just one of them (#75 T5c/T5d) ---------- */

/**
 * The two assertions above were satisfied by the OUTER gate alone. Removing
 * `keyed` from the session panel gate (:3378) or the FilesPanel gate (:3391)
 * individually left all seven tests green — while the whole point of #30 is that
 * each of these re-renders its subtree on every snapshot.
 *
 * The outer gate cannot mask that in practice: Solid rebuilds the nested JSX
 * when the outer one re-runs, and a nested unkeyed gate is exactly what then
 * thrashes. So each gate is pinned by its own surroundings.
 */
test("the session panel gate is keyed (#30/#75)", () => {
  const at = app.indexOf('🎛 session');
  assert.notEqual(at, -1, "the session panel must exist (#30)");
  // walk back to the OPENING tag of the gate that wraps it. lastIndexOf("<Show")
  // lands there, but the tag may extend past `at` via a fallback prop, so slice
  // a window and take the tag itself.
  const before = app.lastIndexOf("<Show", at);
  const gate = app.slice(before, app.indexOf(">", before) + 1);
  assert.match(
    gate,
    /when=\{sel\(\)[!?]\.id\}[^>]*\bkeyed\b/,
    `the session panel's OWN gate must be keyed (#30/#75); got: ${gate}`,
  );
});

test("the FilesPanel gate is keyed (#30/#75)", () => {
  const at = app.indexOf("<FilesPanel");
  assert.notEqual(at, -1, "FilesPanel must exist (#30)");
  const before = app.lastIndexOf("<Show", at);
  const gate = app.slice(before, app.indexOf(">", before) + 1);
  assert.match(
    gate,
    /when=\{sel\(\)[!?]\.id\}[^>]*\bkeyed\b/,
    `the FilesPanel gate must be keyed (#30/#75); got: ${gate}`,
  );
});

test("every keyed gate keys on the agent ID, never the object (#30/#75)", () => {
  // a blanket check, so a NEW panel cannot reintroduce the #30 regression by
  // using the object where the id belongs
  const gates = [...app.matchAll(/<Show when=\{sel\(\)[!?]?\.([a-z]+)\}([^>]*)>/g)].map((m) => ({
    prop: m[2],
    keyed: /\bkeyed\b/.test(m[3] ?? ""),
  }));
  assert.ok(gates.length > 0, "precondition: there are sel()-gated Shows (#30)");
  const objectGates = gates.filter((g) => g.prop === "" && g.keyed);
  assert.deepEqual(
    objectGates,
    [],
    `no gate may key on the agent OBJECT (#30); found ${JSON.stringify(objectGates)}`,
  );
});
