#!/usr/bin/env node
/**
 * Find props destructuring — the SolidJS anti-pattern this repo bans.
 *
 * `const { a, b } = props` reads each field ONCE, at component creation, so the component stops updating: Solid tracks a
 * property through `props.a` at the point of use, and an up-front destructure breaks that subscription. The same applies to a
 * destructured PARAMETER (`function X({ a }: P)`) and to destructuring an accessor's result (`const { a } = someProps()`),
 * which is how the pattern comes back through a getter.
 *
 * It is silent by nature: the first render is correct and only a LATER update fails to arrive, so a type check, a lint rule
 * and a screenshot of the initial render all look fine. Hence an AST pass — a regex cannot tell `const { a } = props` from
 * `const { a } = props.x` (which is the supported form) or from the same text inside a string.
 *
 * Parsing goes through `vite`'s `parseAst` (the same oxc parser the build uses), because the TypeScript 7 native port this
 * project depends on no longer exports `createSourceFile`.
 *
 * Usage:
 *   node scripts/find-props-destructuring.ts           # report every occurrence, exit 1 if any
 *   node scripts/find-props-destructuring.ts --json    # machine-readable, for the test
 *   node scripts/find-props-destructuring.ts <dir>     # scan one directory (default: frontend)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseAst } from "vite";

const ROOT = path.join(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", "public", "dist", ".git"]);

export interface Hit {
  file: string;
  line: number;
  column: number;
  /** what was destructured, so the report names the SOURCE rather than a rule name */
  source: string;
  /** `declaration` = `const { a } = props`; `getter` = `const { a } = someProps()`; `parameter` = `function X({ a }: P)` */
  kind: "declaration" | "getter" | "parameter";
}

/**
 * A name that IS the props object rather than a property of it: `props`, `this.props`, `outerProps`, and accessors such as
 * `getProps()` — whose trailing `()` is stripped first, because a name ending in `()` matches nothing.
 */
const isPropsName = (raw: string): boolean => {
  const name = raw.replace(/\(\)$/, "");
  return /(^|\.)props$/i.test(name) || /[a-z0-9]Props$/.test(name);
};

/** `props` / `this.props` / `props()` as written, or null when the expression is anything else. */
function sourceName(node: any): { name: string; call: boolean } | null {
  if (!node) return null;
  if (node.type === "Identifier") return { name: node.name, call: false };
  if (node.type === "ThisExpression") return { name: "this", call: false };
  if (node.type === "MemberExpression" && !node.computed) {
    const left = sourceName(node.object);
    if (!left || left.call) return null;
    const prop = node.property?.name;
    if (typeof prop !== "string") return null;
    return { name: `${left.name}.${prop}`, call: false };
  }
  if (node.type === "CallExpression") {
    const fn = sourceName(node.callee);
    if (!fn) return null;
    return { name: `${fn.name}()`, call: true };
  }
  return null;
}

function scanFile(file: string): Hit[] {
  const source = readFileSync(file, "utf8");
  const hits: Hit[] = [];
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;
  const colAt = (offset: number) => offset - source.lastIndexOf("\n", offset - 1);

  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;

    // const { a, b } = props   /   const { a } = someProps()
    if (node.type === "VariableDeclarator" && node.id?.type === "ObjectPattern" && node.init) {
      const from = sourceName(node.init);
      if (from && isPropsName(from.name)) {
        hits.push({
          file: path.relative(ROOT, file),
          line: lineAt(node.start),
          column: colAt(node.start),
          source: from.name,
          kind: from.call ? "getter" : "declaration",
        });
      }
    }

    /**
     * `const Card: Component<CardProps> = ({ title }) => …` — the parameter carries no annotation, so the type that says "this is
     * props" is on the DECLARATOR. MEASURED as a false negative before this was handled.
     */
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init && node.id.typeAnnotation) {
      const ann = node.id.typeAnnotation.typeAnnotation;
      const isComponent = /^(Parent)?Component$/.test(typeNameOf(ann));
      const fn = node.init;
      if (
        isComponent &&
        (fn.type === "ArrowFunctionExpression" || fn.type === "FunctionExpression") &&
        fn.params?.[0]?.type === "ObjectPattern"
      ) {
        hits.push({
          file: path.relative(ROOT, file),
          line: lineAt(fn.params[0].start),
          column: colAt(fn.params[0].start),
          source: `{ … }: ${typeNameOf(ann)}`,
          kind: "parameter",
        });
      }
    }

    // function X({ a }: SomeProps) {}   /   const X = ({ a }: SomeProps) => …
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") &&
      Array.isArray(node.params)
    ) {
      for (const param of node.params) {
        if (param?.type !== "ObjectPattern") continue;
        const typeName =
          param.typeAnnotation?.type === "TSTypeAnnotation" ? typeNameOf(param.typeAnnotation.typeAnnotation) : "";
        /**
         * A named `*Props` type always counts. An INLINE object type counts too when the file is `.tsx` — that is a
         * component in a component file, and the pattern is the same read-once.
         */
        /**
         * A NAMED `*Props` type always counts. An INLINE object type counts only when the function returns JSX: in a `.tsx`
         * file that is the difference between a component and an ordinary helper, and MEASURED as a false positive —
         * `const formatUser = ({ name }: { name: string }) => name.trim()` was reported as props destructuring.
         */
        const isProps = typeName.endsWith("Props") || (typeName === "<inline>" && returnsJsx(node));
        if (isProps) {
          hits.push({
            file: path.relative(ROOT, file),
            line: lineAt(param.start),
            column: colAt(param.start),
            source: `{ … }: ${typeName}`,
            kind: "parameter",
          });
        }
      }
    }

    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  };

  // `lang: "tsx"` is what the build's parser wants; the option name is vite's, not babel's
  walk(parseAst(source, { lang: file.endsWith(".tsx") ? "tsx" : "ts" }));
  return hits;
}

/** Does this function RETURN JSX? (a component, rather than a helper that happens to take an object) */
function returnsJsx(fn: any): boolean {
  const body = fn.body;
  if (!body) return false;
  const isJsx = (n: any): boolean =>
    !!n && typeof n === "object" && (n.type === "JSXElement" || n.type === "JSXFragment");
  const contains = (root: any): boolean => {
    if (!root || typeof root !== "object") return false;
    if (isJsx(root)) return true;
    for (const key of Object.keys(root)) {
      if (key === "loc" || key === "range") continue;
      const v = root[key];
      if (Array.isArray(v)) {
        if (v.some(contains)) return true;
      } else if (v && typeof v === "object" && contains(v)) return true;
    }
    return false;
  };
  // an expression body IS the returned value; a block body is searched for a `return <jsx>`
  return body.type === "JSXElement" || body.type === "JSXFragment" || contains(body);
}

/**
 * What the annotation is CALLED, for the "is this props?" question.
 *
 * An inline object type (`function B({ a }: { a: string })`) has no name, so it is reported as `<inline>` and the caller
 * decides: in a `.tsx` file that is a component, and a destructured parameter there is the same read-once mistake.
 */
/**
 * The name to ask "is this props?" of, seeing through the wrappers that hide it.
 *
 * `Omit<CardProps, "id">` and `CardProps & { … }` are both props — MEASURED as false negatives with a `TSTypeReference`-only
 * check — so an intersection reports its first element that names something, and a utility type reports its first type argument
 * (`Extract`/`Exclude` take a union as their second, so the FIRST is the one that describes the object).
 */
function typeNameOf(t: any): string {
  if (!t) return "";
  if (t.type === "TSTypeReference") {
    const n = t.typeName;
    const name = typeof n?.name === "string" ? n.name : (n?.right?.name ?? "");
    if (name && /^(Omit|Pick|Partial|Required|Readonly)$/.test(name) && Array.isArray(t.typeArguments?.params)) {
      return typeNameOf(t.typeArguments.params[0]) || "<inline>";
    }
    return name || "<inline>";
  }
  if (t.type === "TSIntersectionType" && Array.isArray(t.types)) {
    for (const part of t.types) {
      const named = typeNameOf(part);
      if (named && named !== "<inline>") return named;
    }
    return "<inline>";
  }
  if (t.type === "TSTypeLiteral") return "<inline>";
  return "";
}

/** Scan a directory (recursively) for the anti-pattern. Exported so a test can prove it catches a planted one. */
export function findPropsDestructuring(dir: string): { hits: Hit[]; files: number } {
  const files: string[] = [];
  const walkDir = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e) || e.startsWith(".")) continue;
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) walkDir(p);
      else if (/\.(ts|tsx)$/.test(e)) files.push(p);
    }
  };
  walkDir(dir);
  return { hits: files.flatMap(scanFile), files: files.length };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const dirArg = args.find((a) => !a.startsWith("--"));
  const { hits, files } = findPropsDestructuring(path.join(ROOT, dirArg ?? "frontend"));

  if (json) {
    console.log(JSON.stringify(hits, null, 2));
  } else if (hits.length === 0) {
    console.log(`no props destructuring in ${files} file(s)`);
  } else {
    for (const h of hits) console.log(`${h.file}:${h.line}:${h.column}  ${h.kind}  ${h.source}`);
    console.log(`\n${hits.length} occurrence(s) in ${files} file(s)`);
    process.exitCode = 1;
  }
}
