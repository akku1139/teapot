
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

export interface CustomTheme {
  id: string;
  label: string;
  mode: "dark" | "light";
  palette: ThemePalette;
  backgroundImage?: string;
  backgroundDim?: number;
  surfaceAlpha?: number;
  backgroundImageBytes?: number;
}

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
export const MAX_BACKGROUND_BYTES = 1_500_000;

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

const isColour = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 64 && !/[;{}]/.test(v);

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
  if (typeof t.backgroundImage === "string") {
    const img = t.backgroundImage;
    const isAsset = /^\/api\/assets\/[a-f0-9]{32}\.(png|jpe?g|gif|webp|avif)$/i.test(img);
    const isData = /^data:image\//.test(img) && img.length <= MAX_BACKGROUND_BYTES;
    const isRemote = /^https?:\/\//.test(img);
    if (isAsset || isData || isRemote) out.backgroundImage = img;
  }
  if (typeof t.backgroundDim === "number" && Number.isFinite(t.backgroundDim)) {
    out.backgroundDim = Math.min(0.9, Math.max(0, t.backgroundDim));
  }
  if (typeof t.backgroundImageBytes === "number" && Number.isFinite(t.backgroundImageBytes)) {
    out.backgroundImageBytes = Math.max(0, Math.round(t.backgroundImageBytes));
  }
  if (typeof t.surfaceAlpha === "number" && Number.isFinite(t.surfaceAlpha)) {
    out.surfaceAlpha = Math.min(1, Math.max(0.35, t.surfaceAlpha));
  }
  return out;
}

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

export function saveCustomThemes(themes: CustomTheme[]): { ok: boolean; error?: string } {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(themes));
    void fetch("/api/themes", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ themes }),
    }).catch(() => {});
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

export async function loadCustomThemesFromServer(): Promise<CustomTheme[] | null> {
  try {
    const r = await fetch("/api/themes");
    if (!r.ok) return null;
    const body = (await r.json()) as { themes?: unknown };
    if (!Array.isArray(body.themes)) return null;
    return body.themes.map(sanitizeTheme).filter((t): t is CustomTheme => t !== null);
  } catch {
    return null;
  }
}

export function newThemeId(taken: readonly string[]): string {
  for (let i = 0; ; i++) {
    const id = `custom-${Date.now().toString(36)}${i ? `-${i}` : ""}`;
    if (!taken.includes(id)) return id;
  }
}

export function applyCustomTheme(root: HTMLElement, theme: CustomTheme | null): void {
  const SURFACE_VARS = new Set(["--bg-darkest", "--bg-dark", "--bg-mid", "--bg-light"]);
  const hasImage = !!theme?.backgroundImage;
  for (const { key, cssVar } of PALETTE_KEYS) {
    const want = theme ? theme.palette[key] : "";
    if (hasImage && SURFACE_VARS.has(cssVar)) {
      if (root.style.getPropertyValue(cssVar)) root.style.removeProperty(cssVar);
      continue;
    }
    if (root.style.getPropertyValue(cssVar) === want) continue;
    if (want) root.style.setProperty(cssVar, want);
    else root.style.removeProperty(cssVar);
  }
  const wantDim = theme?.backgroundImage ? String(theme.backgroundDim ?? 0.55) : "";
  const wantAlpha = theme?.backgroundImage ? String(theme.surfaceAlpha ?? 0.82) : "";
  for (const [prop, want] of [
    ["--bg-image-dim", wantDim],
    ["--surface-alpha", wantAlpha],
  ] as const) {
    if (root.style.getPropertyValue(prop) === want) continue;
    if (want) root.style.setProperty(prop, want);
    else root.style.removeProperty(prop);
  }
  if (theme?.backgroundImage) {
    if (root.dataset) root.dataset.bgImage = "on";
    for (const [name, value] of [
      ["--bg-darkest-solid", theme.palette.bgDarkest],
      ["--bg-dark-solid", theme.palette.bgDark],
      ["--bg-mid-solid", theme.palette.bgMid],
      ["--bg-light-solid", theme.palette.bgLight],
    ] as const) {
      const solid = opaque(value);
      if (root.style.getPropertyValue(name) !== solid) root.style.setProperty(name, solid);
    }
  } else {
    if (root.dataset) delete root.dataset.bgImage;
    for (const name of ["--bg-darkest-solid", "--bg-dark-solid", "--bg-mid-solid", "--bg-light-solid"]) {
      root.style.removeProperty(name);
    }
  }
}

export function opaque(colour: string): string {
  const m = /^#([0-9a-f]{6})[0-9a-f]{2}$/i.exec(colour.trim());
  return m ? `#${m[1]}` : colour;
}

export function normalizeColour(input: string): string | null {
  const s = input.trim().toLowerCase();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (!m) return null;
  const hex = m[1]!;
  if (hex.length === 3) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  return `#${hex}`;
}

export function resolveActiveTheme(args: {
  want: string;
  customIds: readonly string[];
  presetIds: readonly string[];
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

/**
 * Which custom theme the appearance editor is editing: the one IN USE.
 *
 * `activeId` (the theme actually applied) wins; `editingId` only covers the case where the active theme is
 * no longer in the list (it was just deleted). The order matters: `editingId` is seeded once when the modal
 * is created and is NOT updated by picking a theme, so preferring it left the editor — and its
 * background-image picker — showing the previous theme's wallpaper.
 */
export function themeBeingEdited(
  themes: CustomTheme[],
  activeId: string,
  editingId: string | undefined,
): CustomTheme | undefined {
  return themes.find((t) => t.id === activeId) ?? themes.find((t) => t.id === editingId) ?? themes[0];
}
