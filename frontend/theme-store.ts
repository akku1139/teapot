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
  for (const { cssVar } of PALETTE_KEYS) root.style.removeProperty(cssVar);
  root.style.removeProperty("--bg-image");
  root.style.removeProperty("--bg-image-dim");
  if (!theme) return;
  for (const { key, cssVar } of PALETTE_KEYS) root.style.setProperty(cssVar, theme.palette[key]);
  if (theme.backgroundImage) {
    // `url("…")` with the value quoted: a data: URI can contain characters that end an
    // unquoted url(), and a truncated background is worse than none
    root.style.setProperty("--bg-image", `url("${theme.backgroundImage}")`);
    root.style.setProperty("--bg-image-dim", String(theme.backgroundDim ?? 0.55));
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
