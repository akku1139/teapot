import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Eol } from "./tools.ts";

export interface EditorConfigEol {
  eol: Eol | null;
  finalNewline?: boolean;
}

const NONE: EditorConfigEol = { eol: null };

export function editorConfigFor(targetPath: string): EditorConfigEol {
  const dirs: string[] = [];
  let dir = path.dirname(path.resolve(targetPath));
  for (;;) {
    dirs.push(dir); 
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

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
    if (/^\s*root\s*=\s*true\s*$/im.test(text)) break; 
  }

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
    if (!current) continue; 
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().toLowerCase();
    if (key && value && !current.props.has(key)) current.props.set(key, value);
  }
  return sections;
}

export function sectionMatches(pattern: string, relPath: string): boolean {
  const anchored = pattern.includes("/");
  const names = anchored ? [relPath] : [relPath.split("/").pop() ?? ""];
  const body = anchored ? pattern.replace(/^\//, "") : pattern;
  const re = globToRegExp(body, anchored);
  return names.some((n) => re.test(n));
}

function globToRegExp(glob: string, anchored: boolean): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*"; 
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
        out += glob.slice(i, close + 1).replace(/[\\^]/g, "\\$&");
        i = close;
        continue;
      }
    }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, anchored ? "" : "");
}
