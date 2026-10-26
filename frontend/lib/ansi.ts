
export interface AnsiRun {
  text: string;
  classes: string[];
}

interface SgrState {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

const EMPTY: SgrState = {
  fg: undefined,
  bg: undefined,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
};

const BASIC = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

function classesFor(s: SgrState): string[] {
  const out: string[] = [];
  if (s.fg) out.push(`ansi-fg-${s.fg}`);
  if (s.bg) out.push(`ansi-bg-${s.bg}`);
  if (s.bold) out.push("ansi-bold");
  if (s.dim) out.push("ansi-dim");
  if (s.italic) out.push("ansi-italic");
  if (s.underline) out.push("ansi-underline");
  if (s.inverse) out.push("ansi-inverse");
  return out;
}

function applySgr(state: SgrState, params: number[]): SgrState {
  const next: SgrState = { ...state };
  if (params.length === 0) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) {
      next.fg = undefined;
      next.bg = undefined;
      next.bold = false;
      next.dim = false;
      next.italic = false;
      next.underline = false;
      next.inverse = false;
    } else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 7) next.inverse = true;
    else if (p === 21 || p === 22) {
      next.bold = false;
      next.dim = false;
    } else if (p === 23) next.italic = false;
    else if (p === 24) next.underline = false;
    else if (p === 27) next.inverse = false;
    else if (p >= 30 && p <= 37) next.fg = BASIC[p - 30]!;
    else if (p >= 90 && p <= 97) next.fg = `bright-${BASIC[p - 90]!}`;
    else if (p === 39) next.fg = undefined;
    else if (p >= 40 && p <= 47) next.bg = BASIC[p - 40]!;
    else if (p >= 100 && p <= 107) next.bg = `bright-${BASIC[p - 100]!}`;
    else if (p === 49) next.bg = undefined;
    else if (p === 38 || p === 48) {
      const kind = params[i + 1];
      const target = p === 38 ? "fg" : "bg";
      if (kind === 5 && params[i + 2] !== undefined) {
        next[target] = "ext";
        i += 2;
      } else if (kind === 2 && params[i + 4] !== undefined) {
        next[target] = "ext";
        i += 4;
      } else {
        next[target] = "ext";
        i += 1;
      }
    }
  }
  return next;
}

const SGR = /\x1b\[([0-9;]*)m/;

export function ansiRuns(input: string): AnsiRun[] {
  if (!input) return [];
  const runs: AnsiRun[] = [];
  let state: SgrState = { ...EMPTY };
  let buf = "";

  const flush = () => {
    if (!buf) return;
    const classes = classesFor(state);
    const prev = runs[runs.length - 1];
    if (prev && prev.classes.join(" ") === classes.join(" ")) prev.text += buf;
    else runs.push({ text: buf, classes });
    buf = "";
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === "\x1b") {
      const rest = input.slice(i);
      const m = SGR.exec(rest);
      if (m) {
        flush();
        const params = (m[1] ?? "")
          .split(";")
          .filter((s) => s !== "")
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n));
        state = applySgr(state, params);
        i += m[0].length - 1;
        continue;
      }
      const csi = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(rest);
      if (csi) {
        i += csi[0].length - 1;
        continue;
      }
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest);
      if (osc) {
        i += osc[0].length - 1;
        continue;
      }
      continue;
    }
    if (c === "\r") {
      if (input[i + 1] === "\n") {
        buf += "\n";
        i++;
        continue;
      }
      buf = "";
      continue;
    }
    buf += c;
  }
  flush();
  return runs;
}

export function stripAnsi(input: string): string {
  return ansiRuns(input)
    .map((r) => r.text)
    .join("");
}

export function hasAnsi(input: string): boolean {
  return input.includes("\x1b");
}
