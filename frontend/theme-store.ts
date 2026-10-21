/**
 * Custom themes: a user-authored palette plus an optional background image.
 *
 * ## Why this is a module and not component state
 *
 * A theme used to be a hardcoded entry in `THEMES` plus a `[data-theme="…"]` block in
 * `app.css`. That is fine for ten presets and impossible for a theme the operator invents:
 * neither a CSS file nor a literal list can be written from the browser. So a CUSTOM theme is
 * applied the other way round — as inline custom properties on `<html>`, which outrank the
 * stylesheet's `:root` values and need no stylesheet at all.
 *
 * The palette is exactly the eleven variables the presets define, because that is the whole
 * contract `app.css` relies on. Anything a preset can do, a custom theme can do.
 *
 * ## What is deliberately NOT here
 *
 * No arbitrary CSS. A theme is a colour palette and an image, so it cannot break layout or
 * reach outside the page.
 */

/** the eleven colours every theme defines — the contract `app.css` expects */
export interface ThemePalette {
  bgDarkest: string;
  bgDark: string;
  bgMid: string;
  bgLight: string;
  fg: string;
  dim: string;
  line: string;
  acc: string;
  ok: string;
  warn: string;
  err: string;
  tool: string;
  termBg: string;
  termFg: string;
}

/** a theme the operator made */
export interface CustomTheme {
  /** stable id, used as the `data-theme` value and the storage key */
  id: string;
  label: string;
  mode: "dark" | "light";
  palette: ThemePalette;
  /**
   * Background image as a `url(...)`-able string: a `data:` URI (pasted or dropped, kept
   * self-contained so a reload still has it) or an http(s) URL.
   *
   * Kept as the CSS value rather than a File so it survives `localStorage` and can be applied
   * with one `background-image` write.
   */
  backgroundImage?: string;
  /** how much to dim the image so text stays readable over it; 0 = untouched */
  backgroundDim?: number;
}

/** the palette variable names `app.css` reads, in the order a form should show them */
export const PALETTE_KEYS: { key: keyof ThemePalette; cssVar: string; label: string }[] = [
  { key: "bgDarkest", cssVar: "--bg-darkest", label: "surface (deepest)" },
  { key: "bgDark", cssVar: "--bg-dark", label: "surface" },
  { key: "bgMid", cssVar: "--bg-mid", label: "surface (raised)" },
  { key: "bgLight", cssVar: "--bg-light", label: "surface (control)" },
  { key: "fg", cssVar: "--fg", label: "text" },
  { key: "dim", cssVar: "--dim", label: "text (muted)" },
  { key: "line", cssVar: "--line", label: "divider" },
  { key: "acc", cssVar: "--acc", label: "accent" },
  { key: "ok", cssVar: "--ok", label: "success" },
  { key: "warn", cssVar: "--warn", label: "warning" },
  { key: "err", cssVar: "--err", label: "error" },
  { key: "tool", cssVar: "--tool", label: "tool accent" },
  { key: "termBg", cssVar: "--term-bg", label: "terminal background" },
  { key: "termFg", cssVar: "--term-fg", label: "terminal text" },
];

const STORAGE_KEY = "teapot.customThemes";
/** the whole picture is stored inline, so cap it: localStorage is ~5MB per origin */
export const MAX_BACKGROUND_BYTES = 1_500_000;

/** a dark palette to start a new theme from — same values as the built-in dark theme */
export const DEFAULT_PALETTE: ThemePalette = {
  bgDarkest: "#1a1c22",
  bgDark: "#232630",
  bgMid: "#2b2e39",
  bgLight: "#343845",
  fg: "#dcdee4",
  dim: "#9298a5",
  line: "#1d2027",
  acc: "#5865f2",
  ok: "#3ba55d",
  warn: "#faa81a",
  err: "#ed4245",
  tool: "#3ba0c9",
  termBg: "#0d0e12",
  termFg: "#dcdee4",
};

/**
 * The BUILT-IN themes' palettes, mirroring the `[data-theme="…"]` blocks in app.css.
 *
 * These exist so a theme can be PREVIEWED without applying it: the picker draws each theme as a
 * miniature of the UI (Misskey's `MkThemePreview` idea), which needs that theme's colours. A
 * preview used to probe the live document, but inserting a node from inside a render broke the
 * settings dialog (MEASURED: "the config dialog renders no key inputs at all").
 *
 * `test/theme-store.test.ts` fails if any of these drifts from app.css — the duplication is
 * unavoidable (a stylesheet cannot be read as data), so it is CHECKED instead of trusted.
 */
export const PRESET_PALETTES: Record<string, ThemePalette> = {
  "dark": { bgDarkest: "#1a1c22", bgDark: "#232630", bgMid: "#2b2e39", bgLight: "#343845", fg: "#dcdee4", dim: "#9298a5", line: "#1d2027", acc: "#5865f2", ok: "#3ba55d", warn: "#faa81a", err: "#ed4245", tool: "#3ba0c9", termBg: "#0d0e12", termFg: "#dcdee4" },
  "midnight": { bgDarkest: "#0d0f18", bgDark: "#12141f", bgMid: "#1b1f31", bgLight: "#252a42", fg: "#dfe2f2", dim: "#8a90ad", line: "#0a0c14", acc: "#8b7cf7", ok: "#54c08a", warn: "#e5b567", err: "#ef6a6a", tool: "#6aa9e9", termBg: "#0a0c13", termFg: "#dfe2f2" },
  "tea": { bgDarkest: "#241c16", bgDark: "#2e241c", bgMid: "#3b2f24", bgLight: "#493b2d", fg: "#f0e4d2", dim: "#b39d82", line: "#1b140f", acc: "#d98e32", ok: "#7fa653", warn: "#e0b058", err: "#cf5b47", tool: "#c9975f", termBg: "#1d1712", termFg: "#ecdcc3" },
  "coffee": { bgDarkest: "#191410", bgDark: "#211a14", bgMid: "#30271e", bgLight: "#403527", fg: "#ede3d0", dim: "#a89478", line: "#120d07", acc: "#c68a4b", ok: "#8aa15c", warn: "#d9a441", err: "#c25450", tool: "#a67c52", termBg: "#15100c", termFg: "#e8dcc5" },
  "matcha": { bgDarkest: "#1b2217", bgDark: "#232b1e", bgMid: "#2f3a28", bgLight: "#3c4a33", fg: "#e8eeda", dim: "#9aab84", line: "#131a10", acc: "#8db64e", ok: "#6fae4e", warn: "#d8b13c", err: "#cd5c50", tool: "#5da88f", termBg: "#151b11", termFg: "#dfe8cb" },
  "matrix": { bgDarkest: "#060a06", bgDark: "#0a0f0a", bgMid: "#122116", bgLight: "#18301d", fg: "#c9f2cf", dim: "#6fa075", line: "#030603", acc: "#2fd558", ok: "#39c95f", warn: "#b8d977", err: "#ff6b6b", tool: "#57c99b", termBg: "#030503", termFg: "#33ff77" },
  "sunset": { bgDarkest: "#1c1422", bgDark: "#241b2b", bgMid: "#33253e", bgLight: "#452f52", fg: "#f2e6ea", dim: "#ab93a8", line: "#150e1b", acc: "#f2784b", ok: "#63b46f", warn: "#eda63d", err: "#e25563", tool: "#b06ac9", termBg: "#170f1d", termFg: "#f0dfe4" },
  "light": { bgDarkest: "#eceef4", bgDark: "#f6f7fa", bgMid: "#e2e5ee", bgLight: "#ffffff", fg: "#24272f", dim: "#5d6470", line: "#d8dbe4", acc: "#4757d8", ok: "#2b8a4b", warn: "#b97a0f", err: "#d83c3f", tool: "#2278a8", termBg: "#ffffff", termFg: "#24272f" },
  "strawberry": { bgDarkest: "#fbe4ea", bgDark: "#fdf0f3", bgMid: "#f7d4de", bgLight: "#fffafb", fg: "#4a2733", dim: "#96707e", line: "#f0ccd6", acc: "#e05575", ok: "#4d9e63", warn: "#c98a2d", err: "#d43d51", tool: "#b05687", termBg: "#fff5f8", termFg: "#4a2733" },
  "ramune": { bgDarkest: "#ddeff7", bgDark: "#ecf7fb", bgMid: "#c9e7f4", bgLight: "#fbfeff", fg: "#173342", dim: "#5b7d90", line: "#c2e2ef", acc: "#1d86ae", ok: "#3a9e6e", warn: "#cf9a2a", err: "#d64f5c", tool: "#3a9db8", termBg: "#f4fbfd", termFg: "#173342" },
};

/** is this a colour a CSS custom property can hold? */
const isColour = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 64 && !/[;{}]/.test(v);

/**
 * Validate ONE stored theme.
 *
 * Anything can be in `localStorage` — a half-written value, a theme from a future version, or
 * text somebody edited by hand. A malformed palette that reached `style.setProperty` would
 * leave the UI with missing colours (transparent panels), which is much worse than falling
 * back to a default, so every field is checked and anything unexpected is dropped.
 */
export function sanitizeTheme(raw: unknown): CustomTheme | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Partial<CustomTheme>;
  if (typeof t.id !== "string" || !/^[a-z0-9-]{1,40}$/i.test(t.id)) return null;
  if (typeof t.label !== "string" || !t.label.trim()) return null;
  if (t.mode !== "dark" && t.mode !== "light") return null;
  const p = t.palette as Partial<ThemePalette> | undefined;
  if (!p || typeof p !== "object") return null;
  const palette = {} as ThemePalette;
  for (const { key } of PALETTE_KEYS) {
    if (!isColour(p[key])) return null;
    palette[key] = p[key]!;
  }
  const out: CustomTheme = { id: t.id, label: t.label.slice(0, 40), mode: t.mode, palette };
  if (typeof t.backgroundImage === "string" && t.backgroundImage.length <= MAX_BACKGROUND_BYTES) {
    // only the two shapes the picker can produce, so a stored value cannot smuggle `url(javascript:)`
    if (/^(data:image\/|https?:\/\/)/.test(t.backgroundImage)) out.backgroundImage = t.backgroundImage;
  }
  if (typeof t.backgroundDim === "number" && Number.isFinite(t.backgroundDim)) {
    out.backgroundDim = Math.min(0.9, Math.max(0, t.backgroundDim));
  }
  return out;
}

/** read every stored custom theme, dropping anything malformed */
export function loadCustomThemes(): CustomTheme[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeTheme).filter((t): t is CustomTheme => t !== null);
  } catch {
    return [];
  }
}

/**
 * Persist the custom themes, returning what the write REJECTED.
 *
 * A background image is the only unbounded thing here, so an over-quota theme must be reported
 * rather than silently dropped: the operator would otherwise save a theme, reload, and find it
 * gone.
 */
export function saveCustomThemes(themes: CustomTheme[]): { ok: boolean; error?: string } {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(themes));
    return { ok: true };
  } catch (err) {
    const e = err as { name?: string };
    return {
      ok: false,
      error:
        e.name === "QuotaExceededError" || /quota/i.test(String((err as Error).message))
          ? "storage is full — that background image is too large. Try a smaller one, or remove another theme."
          : `could not save: ${(err as Error).message}`,
    };
  }
}

/** a fresh id that cannot collide with a preset or an earlier custom theme */
export function newThemeId(taken: readonly string[]): string {
  for (let i = 0; ; i++) {
    const id = `custom-${Date.now().toString(36)}${i ? `-${i}` : ""}`;
    if (!taken.includes(id)) return id;
  }
}

/**
 * Apply a custom theme to `<html>` as INLINE custom properties, or clear them.
 *
 * Passing `null` removes every property this function owns, so switching back to a preset is
 * clean — a leftover `--bg-dark` from a custom theme would keep overriding the preset's
 * colours and the UI would be half one theme and half the other.
 */
export function applyCustomTheme(root: HTMLElement, theme: CustomTheme | null): void {
  /**
   * Write ONLY what changed.
   *
   * The editor calls this on every keystroke of a colour field, and the effect driving it runs
   * whenever the theme list changes. This used to remove all 14 variables and re-set all 14 on
   * every call, and every `setProperty` invalidates style for the whole document — so typing
   * `#5865f2` into the hex field re-resolved the entire UI six times.
   *
   * Comparing against what is already on `<html>` makes an unchanged palette a no-op, which is
   * what keeps a live preview affordable.
   */
  for (const { key, cssVar } of PALETTE_KEYS) {
    const want = theme ? theme.palette[key] : "";
    if (root.style.getPropertyValue(cssVar) === want) continue;
    if (want) root.style.setProperty(cssVar, want);
    else root.style.removeProperty(cssVar);
  }
  // `url("…")` quoted: a data: URI can contain characters that end an unquoted url(), and a
  // truncated background is worse than none
  const wantImage = theme?.backgroundImage ? `url("${theme.backgroundImage}")` : "";
  const wantDim = theme?.backgroundImage ? String(theme.backgroundDim ?? 0.55) : "";
  for (const [prop, want] of [
    ["--bg-image", wantImage],
    ["--bg-image-dim", wantDim],
  ] as const) {
    if (root.style.getPropertyValue(prop) === want) continue;
    if (want) root.style.setProperty(prop, want);
    else root.style.removeProperty(prop);
  }
}

/**
 * A pasted colour, normalised to a `#rrggbb` string, or `null`.
 *
 * The picker shows a native colour input (always `#rrggbb`) next to a text field, and people
 * paste from design tools: `#RGB`, `#RRGGBBAA` and a bare `rrggbb` all reach that field.
 */
export function normalizeColour(input: string): string | null {
  const s = input.trim().toLowerCase();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (!m) return null;
  const hex = m[1]!;
  if (hex.length === 3) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  return `#${hex}`;
}

/**
 * Decide which theme id to actually apply, given what was stored.
 *
 * A stored id can name a theme that no longer exists: deleted in another tab, dropped by
 * `saveCustomThemes` when storage was full, or left over from an older build. `data-theme` was
 * set to that dead id, which matches neither `:root` nor any `[data-theme]` block — so the page
 * had NO palette at all: every surface transparent and unreadable, with no visible way back.
 *
 * Returns the id to use and whether the caller should repair the stored value (so a reload
 * agrees with the screen instead of retrying the dead id forever).
 */
export function resolveActiveTheme(args: {
  /** the id read from storage / state */
  want: string;
  /** ids of the custom themes that exist */
  customIds: readonly string[];
  /** ids of the built-in themes that exist */
  presetIds: readonly string[];
  /** used when nothing matches; must itself be a valid preset */
  fallback?: string;
}): { active: string; repaired: boolean } {
  const known = args.customIds.includes(args.want) || args.presetIds.includes(args.want);
  if (known) return { active: args.want, repaired: false };
  const fallback = args.fallback && args.presetIds.includes(args.fallback) ? args.fallback : "dark";
  return {
    active: args.presetIds.includes(fallback) ? fallback : (args.presetIds[0] ?? "dark"),
    repaired: true,
  };
}
