import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function readSourceUrl(url: URL): string {
  return readSource(fileURLToPath(url));
}

export function readSource(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

export function stripSourceComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  const lastMeaningful = (): string => {
    for (let j = out.length - 1; j >= 0; j--) {
      const ch = out[j]!;
      if (!/\s/.test(ch)) return ch;
    }
    return "";
  };
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n !== "/" && n !== "=" && n !== "*" && regexCanStartAfter(lastMeaningful())) {
      out += c;
      i++;
      let inClass = false;
      while (i < src.length) {
        const r = src[i]!;
        if (r === "\\") {
          out += r + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += r;
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) {
          i++;
          break;
        } else if (r === "\n") {
          break; 
        }
        i++;
      }
      while (i < src.length && /[a-z]/.test(src[i]!)) {
        out += src[i]!;
        i++;
      }
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function regexCanStartAfter(prev: string): boolean {
  if (!prev) return true; 
  return "(,=:[!&|?{};+-*%^~<>".includes(prev) || prev === "\n";
}

export function blockFrom(src: string, anchor: string, fallback = 2000): string {
  const at = src.indexOf(anchor);
  if (at === -1) return "";
  const lineEnd = src.indexOf("\n", at);
  const segment = src.slice(at, lineEnd === -1 ? src.length : lineEnd);
  if (!segment.includes("{")) {
    const rest = src.slice(at, at + fallback);
    const stop = rest.search(/\n\s*\n/);
    return stop === -1 ? rest : rest.slice(0, stop);
  }
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return src.slice(at, at + fallback);
}
