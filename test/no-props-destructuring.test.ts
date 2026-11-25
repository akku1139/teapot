/**
 * No component may destructure `props` — and this is the check that says so.
 *
 * `const { a, b } = props` reads each field ONCE, when the component is created, so a later change never arrives: Solid tracks
 * a property through `props.a` at the point of USE, and destructuring up front throws that subscription away. The failure is
 * silent by nature — the first render is correct — so nothing here can be caught by a type check, a screenshot or an initial
 * render assertion. `AGENTS.md` states the rule; this file is what makes it hold.
 *
 * Three shapes count, because they are the same mistake one line apart:
 *
 *   - `const { a } = props`                     — a declaration
 *   - `const { a } = someProps()`               — the same through an accessor's RESULT
 *   - `function X({ a }: SomeProps)`            — a destructured PARAMETER
 *
 * The detector parses the file (via `vite`'s `parseAst`, the oxc parser the build itself uses — the TypeScript 7 native port
 * exports no text-to-AST entry, checked in both 7.0 and the 7.1 dev builds), because a pattern match cannot tell
 * `const { a } = props` from `const { a } = props.x` (which is the SUPPORTED form) or from the same text inside a string.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findPropsDestructuring } from "../scripts/find-props-destructuring.ts";

test("no component destructures props", () => {
  const frontend = path.join(import.meta.dirname, "..", "frontend");
  const { hits, files } = findPropsDestructuring(frontend);

  assert.ok(files > 20, `precondition: the scan must cover the frontend; saw ${files} file(s)`);
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}  ${h.kind}  ${h.source}`),
    [],
    "props destructuring breaks reactivity (AGENTS.md): read `props.x` where the value is used, or pass an accessor",
  );
});

test("the detector actually catches each shape — a green scan above means something", (t) => {
  /**
   * A checker that reports nothing is indistinguishable from one that cannot see. Each shape gets its own file, and the
   * supported forms sit beside them so a detector that simply flags every `{ … } =` would fail here.
   */
  const dir = mkdtempSync(path.join(tmpdir(), "props-detect-"));
  writeFileSync(
    path.join(dir, "shapes.tsx"),
    [
      "export function Declaration(props: { a: string; b: string }) {",
      "  const { a, b } = props;",
      "  return <span>{a}{b}</span>;",
      "}",
      "export function Parameter({ a }: { a: string }) {",
      "  return <span>{a}</span>;",
      "}",
      "export function Getter(getProps: () => { a: string }) {",
      "  const { a } = getProps();",
      "  return <span>{a}</span>;",
      "}",
      "export function Fine(props: { a: string }) {",
      "  const { b } = { b: 1 } as { b: number };",
      "  return <span>{props.a}{b}</span>;",
      "}",
    ].join("\n"),
  );

  const { hits } = findPropsDestructuring(dir);
  const kinds = hits.map((h) => h.kind).sort();
  assert.deepEqual(kinds, ["declaration", "getter", "parameter"], `caught: ${JSON.stringify(hits)}`);

  assert.ok(
    hits.some((h) => h.source === "props"),
    "the declaration names the source it destructured",
  );
  assert.ok(
    hits.some((h) => h.source.startsWith("{ … }:")),
    "and a destructured parameter names its type",
  );
  // the object literal destructure is not props and must NOT be reported
  assert.ok(
    !hits.some((h) => h.line >= 12),
    "a destructure from a plain object literal is not props — flagging it would make the check useless",
  );

  t.diagnostic(`caught ${hits.length} shape(s)`);
});


test("the shapes a naive AST walk misses — each one was a measured false negative or positive", () => {
  /**
   * A checker is only as good as the shapes it can see, so the gaps found by review are pinned here rather than trusted:
   *
   *   - `Component<Props>` puts the type on the DECLARATOR, and the parameter has no annotation at all;
   *   - `Omit<Props, "id">` and `Props & { … }` hide the name behind a wrapper;
   *   - an INLINE object type in a `.tsx` is only props when the function returns JSX, or a plain helper is flagged.
   */
  const dir = mkdtempSync(path.join(tmpdir(), "props-detect2-"));
  writeFileSync(
    path.join(dir, "shapes2.tsx"),
    [
      "export const Named = ({ title }: CardProps) => <div>{title}</div>;",
      "export function Omitted({ a }: Omit<CardProps, 'id'>) { return <b>{a}</b>; }",
      "export function Intersected({ a }: CardProps & { x: boolean }) { return <b>{a}</b>; }",
      "export const ViaComponent: Component<CardProps> = ({ title }) => <div>{title}</div>;",
      "const formatUser = ({ name }: { name: string }) => name.trim();",
    ].join("\n"),
  );

  const { hits } = findPropsDestructuring(dir);
  const lines = hits.map((h) => h.line).sort((a, b) => a - b);
  assert.deepEqual(
    lines,
    [1, 2, 3, 4],
    `all four props shapes must be caught, and the helper on line 5 must not be (caught: ${JSON.stringify(hits)})`,
  );
  assert.ok(
    !hits.some((h) => h.line === 5),
    "a helper that takes an object and returns a string is not a component — flagging it is a false positive",
  );
});
