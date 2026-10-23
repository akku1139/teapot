/**
 * ANSI SGR escape sequences → styled spans, for tool output.
 *
 * Tool results carry whatever the program printed, and a lot of programs colour their output with
 * ANSI escapes — Renode's monitor, test runners, `git --color`, `ls --color`, anything using a TTY
 * library. The timeline rendered those bytes literally, so a result read like
 *
 *     ^[[91m(monitor) ^[[0minclude @/tmp/t.a7.resc
 *
 * which is unreadable and wastes the vertical space the colours were meant to organise.
 *
 * ## Scope: SGR only
 *
 * Only `ESC [ … m` (Select Graphic Rendition: colour, bold, underline, inverse) is interpreted.
 * Cursor movement, screen clearing and erase-line are DROPPED without effect — a tool card is not a
 * terminal, and honouring `ESC[2J` there would blank the card. Dropping them silently is also what
 * makes the output of a TUI-ish program render as its final visible text instead of as control
 * noise.
 *
 * ## Why a tokenizer rather than a regex replace
 *
 * A naive `/\x1b\[[0-9;]*m/` strip leaves `\r` handling and nesting to chance: `ESC[91m` … `ESC[0m`
 * needs a span boundary, and a re-open after every reset is how terminals do it. This walks the
 * string once and emits `{ text, classes }` runs, which keeps the renderer a dumb `For`.
 *
 * Pure and dependency-free so it is unit-testable under `node --test`.
 */

/** one run of text sharing a style */
export interface AnsiRun {
  text: string;
  /** semantic classes, not colours — the palette decides what "red" looks like */
  classes: string[];
}

/** SGR state, as a small record so re-opening after a reset is a copy */
interface SgrState {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

/**
 * The reset state. `fg`/`bg` are explicitly `undefined` rather than omitted.
 *
 * MEASURED: `Object.assign(next, EMPTY)` does NOT remove a key that is absent from `EMPTY`, so a
 * reset left `fg: "bright-red"` in place — the colour survived `ESC[0m` and every following run
 * merged into the previous one, which is how `\x1b[91mA\x1b[0mB` rendered as one red run "AB".
 */
const EMPTY: SgrState = {
  fg: undefined,
  bg: undefined,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
};

/** the 8 basic colours + their bright variants, as semantic names */
const BASIC = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/**
 * Map an SGR number to a class.
 *
 * Semantic names rather than hex: `app.css` owns the palette and must be able to retheme tool
 * output the same way it themes everything else. A hardcoded hex here would be the one surface that
 * ignores the operator's theme.
 */
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

/** apply one SGR parameter list to the state (mutating a copy) */
function applySgr(state: SgrState, params: number[]): SgrState {
  const next: SgrState = { ...state };
  // `ESC[m` and `ESC[0m` both mean "reset everything"
  if (params.length === 0) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) {
      // assign the KEYS, not the object: see the note on EMPTY for why this must include fg/bg
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
      /**
       * Extended colour: `5;n` is a 256-colour index, `2;r;g;b` is truecolour.
       *
       * Both are mapped to a NEUTRAL class rather than reproduced: the palette is the operator's,
       * and a hardcoded `rgb()` from a random program would fight it. The important part is that
       * the escape is CONSUMED rather than rendered as text, and the following parameters are
       * skipped so they are not misread as basic colours.
       */
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

/** matches an SGR sequence and captures its parameters */
const SGR = /\x1b\[([0-9;]*)m/;

/**
 * Split text into styled runs.
 *
 * Also normalises the carriage-return redraw idiom: a program that repaints a line emits
 * `text\r rewritten`, and `\r` in a `<pre>` does nothing, so the two halves would both show. Keeping
 * only what follows the LAST `\r` of a line reproduces what a terminal would display.
 */
export function ansiRuns(input: string): AnsiRun[] {
  if (!input) return [];
  const runs: AnsiRun[] = [];
  let state: SgrState = { ...EMPTY };
  let buf = "";

  const flush = () => {
    if (!buf) return;
    const classes = classesFor(state);
    // merge with the previous run when the style did not change, so the DOM stays shallow
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
      // any OTHER CSI / OSC sequence is control noise in a tool card: consume and ignore
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
      // a lone ESC: drop it, do not print the byte
      continue;
    }
    if (c === "\r") {
      // CRLF is a real newline; a bare CR is a line redraw
      if (input[i + 1] === "\n") {
        buf += "\n";
        i++;
        continue;
      }
      // discard what this line has shown so far
      buf = "";
      continue;
    }
    buf += c;
  }
  flush();
  return runs;
}

/** the visible text of an ANSI-laden string — for copy buttons and search */
export function stripAnsi(input: string): string {
  return ansiRuns(input)
    .map((r) => r.text)
    .join("");
}

/** does this text contain any escape sequence at all? (cheap pre-check) */
export function hasAnsi(input: string): boolean {
  return input.includes("\x1b");
}
