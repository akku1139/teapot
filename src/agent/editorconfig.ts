/**
 * `.editorconfig` support (#109) — "edit_file の改行コードを .editorconfig に合わせて
 * 正規化するとか?".
 *
 * ## What this DOES and deliberately does NOT do
 *
 * An EXISTING file already keeps its own line ending (#84, `detectEol`): the file's
 * own bytes are the strongest possible evidence, and a `.editorconfig` that
 * disagrees with the file on disk is nearly always stale relative to it. So this
 * only supplies an answer where there was NONE:
 *
 *   - a NEW file (nothing to detect), and
 *   - a MIXED-EOL file, where `detectEol` returns null on purpose because choosing
 *     a winner would be a silent whole-file rewrite.
 *
 * That keeps one rule: **the file's own content outranks configuration, which
 * outranks the LF default.** `end_of_line = crlf` in a repo whose files are LF does
 * not silently convert every file the agent touches.
 *
 * ## Why this is not a general editorconfig library
 *
 * The format has glob sections, brace expansion and a precedence order. Only the
 * facts that change how a WRITE behaves are read — today that is `end_of_line`
 * (plus `insert_final_newline`, which decides whether a new file ends in a
 * newline). Anything else (`indent_style`, `charset`, …) has no in-repo consumer,
 * and guessing at it would be untested surface.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Eol } from "./tools.ts";

export interface EditorConfigEol {
  /** the line ending the config asks for, or null when it says nothing */
  eol: Eol | null;
  /** `insert_final_newline`, when the config states it */
  finalNewline?: boolean;
}

const NONE: EditorConfigEol = { eol: null };

/**
 * Read the `.editorconfig` files that apply to `targetPath`, nearest-wins.
 *
 * Walks from the file's own directory up to the filesystem root so a nested
 * `.editorconfig` overrides the repo root, which is the documented precedence.
 * Sections are matched against the path RELATIVE to the file that declared them.
 * A `root = true` stops the walk, as the format requires.
 */
export function editorConfigFor(targetPath: string): EditorConfigEol {
  const dirs: string[] = [];
  let dir = path.dirname(path.resolve(targetPath));
  for (;;) {
    dirs.push(dir); // nearest first, which is also the precedence order
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // nearest-first, so the FIRST answer found wins; `root = true` truncates the walk
  const applicable: { dir: string; text: string }[] = [];
  for (const d of dirs) {
    const file = path.join(d, ".editorconfig");
    if (!existsSync(file)) continue;
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    applicable.push({ dir: d, text });
    if (/^\s*root\s*=\s*true\s*$/im.test(text)) break; // this file is the root
  }

  // apply outermost -> innermost so the nearest file's value lands last
  let out: EditorConfigEol = NONE;
  for (const { dir: declDir, text } of applicable.reverse()) {
    const rel = path.relative(declDir, path.resolve(targetPath)).split(path.sep).join("/");
    for (const section of parseSections(text)) {
      if (!sectionMatches(section.pattern, rel)) continue;
      const eol = section.props.get("end_of_line");
      if (eol === "lf") out = { ...out, eol: "\n" };
      else if (eol === "crlf") out = { ...out, eol: "\r\n" };
      else if (eol === "cr") out = { ...out, eol: "\r" };
      const fn = section.props.get("insert_final_newline");
      if (fn === "true") out = { ...out, finalNewline: true };
      else if (fn === "false") out = { ...out, finalNewline: false };
    }
  }
  return out;
}

interface Section {
  pattern: string;
  props: Map<string, string>;
}

/** `[section]` blocks with their `key = value` pairs. Comments and blanks ignored. */
function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      current = { pattern: header[1]!.trim(), props: new Map() };
      sections.push(current);
      continue;
    }
    if (!current) continue; // a property outside any section applies to nothing
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().toLowerCase();
    // the FIRST value wins within a section (the format's rule)
    if (key && value && !current.props.has(key)) current.props.set(key, value);
  }
  return sections;
}

/**
 * Does an editorconfig glob match a POSIX-style relative path?
 *
 * Supports the parts that appear in real configs: `*` (within a segment), `**`
 * (across segments), `?`, `{a,b}` alternation, and a `[abc]` class. A section with
 * no `/` matches the BASENAME at any depth, which is the format's documented special
 * case (and why `[*.md]` in a root file applies to `docs/x.md`).
 */
export function sectionMatches(pattern: string, relPath: string): boolean {
  const anchored = pattern.includes("/");
  const names = anchored ? [relPath] : [relPath.split("/").pop() ?? ""];
  const body = anchored ? pattern.replace(/^\//, "") : pattern;
  const re = globToRegExp(body, anchored);
  return names.some((n) => re.test(n));
}

/** Translate an editorconfig glob into a RegExp. */
function globToRegExp(glob: string, anchored: boolean): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more leading segments; a bare `**` is `.*`
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*"; // a single star never crosses a separator
      }
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      continue;
    }
    if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close !== -1) {
        const alts = glob
          .slice(i + 1, close)
          .split(",")
          .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        out += `(?:${alts.join("|")})`;
        i = close;
        continue;
      }
    }
    if (c === "[") {
      const close = glob.indexOf("]", i);
      if (close !== -1) {
        // a character class is passed through as-is, minus any escaping surprises
        out += glob.slice(i, close + 1).replace(/[\\^]/g, "\\$&");
        i = close;
        continue;
      }
    }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  // anchored patterns are relative to the config's directory; a basename pattern
  // already matched against the basename, so neither needs a prefix
  return new RegExp(`^${out}$`, anchored ? "" : "");
}
