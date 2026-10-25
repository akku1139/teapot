import { For, Index, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { IconBtn, Modal } from "./chrome";
import { CodePreview, NumberField, ThemePreview, TodoEditor } from "./settings-parts";
import { api } from "../lib/api";
import { bgSrc, bgSrcSet } from "../lib/bg-srcset";
import { flashHint } from "../lib/flash";
import { oauthStateFrom } from "../lib/mcp-oauth-key";
import { relTime } from "../lib/format";
import { renderMarkdownCached } from "../lib/markdown";
import { PROVIDER_PRESETS } from "../lib/provider-presets";
import { paintedIdFor, slotForSelection } from "../lib/theme-slots";
import {
  DEFAULT_PALETTE,
  PALETTE_KEYS,
  PRESET_PALETTES,
  applyCustomTheme,
  newThemeId,
  normalizeColour,
  opaque,
  sanitizeTheme,
  saveCustomThemes,
  type CustomTheme,
  type ThemePalette,
} from "../lib/theme-store";
import { THEMES } from "../lib/themes-presets";

declare const __APP_VERSION__: string;


export function ThemeEditor(props: {
  /**
   * An ACCESSOR, not the array.
   *
   * Passing `props.themes={customThemes()}` hands the editor a snapshot of the list as it was
   * when the component was created, so every later change was invisible to it — pressing
   * "＋ duplicate current" persisted a theme to localStorage and the editor still rendered
   * "no custom themes yet". That is the same freeze AGENTS.md describes for destructured props
   * ("same for destructuring a getter's RESULT: pass the accessor down"), and it only showed up
   * in the browser: the persistence worked, so nothing failed loudly.
   */
  themes: () => CustomTheme[];
  activeId: string;
  /**
   * The id of the theme ACTUALLY PAINTED right now — which is not `activeId` under "follow the
   * system".
   *
   * `activeId` is the FIXED choice (what the picker shows); with auto mode the document is painted
   * with `sysDarkTheme()`/`sysLightTheme()` instead. Duplicating from `activeId` therefore copied
   * the LIVE COLOURS (read from the document) while labelling the copy after the SELECTED theme —
   * so with "follow the system" the copy had the painted palette and the wrong name. Reported as
   * "「follow the system」のときに選択中のテーマじゃなくて、実際に当たっているテーマの色が複製されて、
   * でも名前は選択中のテーマが使用される".
   *
   * A separate prop rather than redefining `activeId`: that one also answers "which theme does the
   * editor edit" and "which `<option>` is selected", and those must keep meaning the fixed choice.
   */
  paintedId: string;
  onChange: (next: CustomTheme[]) => void;
  onPick: (id: string) => void;
}) {
  // which theme the editor is open on: the active one if it is custom, else the first custom,
  // else none (nothing to edit until one exists)
  const [editingId, setEditingId] = createSignal<string>(
    props.themes().some((t) => t.id === props.activeId) ? props.activeId : (props.themes()[0]?.id ?? ""),
  );
  /**
   * `editingId` is a plain signal, so it can outlive the theme it names — deleting the theme
   * being edited left it pointing at a dead id, and the editor then rendered `<Show>`'s
   * fallback ("no custom themes yet — press duplicate") while other themes existed.
   *
   * Resolving through the list instead of trusting the signal means the editor always shows a
   * theme that EXISTS: the named one if it is still there, otherwise the first remaining one.
   */
  const editing = () => {
    const list = props.themes();
    /**
     * The theme being edited defaults to the ACTIVE one, not `list[0]`.
     *
     * `editingId` is only set by a click in this dialog, so on open it is empty and the editor
     * showed the FIRST custom theme — which may be neither the active one nor one with a
     * background image. Combined with the gate below (which requires a custom theme to be active),
     * the whole editor and its "background image" section appeared or vanished depending on an
     * arbitrary list order. Reported as "背景画像があるカスタムテーマと無いテーマがあるときに背景画像
     * 設定欄がどっちからも消失してそう".
     *
     * Falling back to `activeId` means: when a custom theme is on screen, the editor is about THAT
     * theme, so its image field is reachable whenever there is an image to edit.
     */
    return (
      list.find((t) => t.id === editingId()) ??
      list.find((t) => t.id === props.activeId) ??
      list[0]
    );
  };
  /**
   * What the hex field SHOWS while it is being typed in, keyed by palette key.
   *
   * A half-typed "#ff" is not a colour, so it cannot be stored — but it must still be visible,
   * or the input jumps back to the old value on every keystroke and a hex can never be entered.
   * The draft is cleared on blur, at which point the field shows the colour that was applied.
   */
  const [hexDraft, setHexDraft] = createSignal<Record<string, string>>({});
  /** the hidden file input the 🖼 button opens (see the button's comment for why) */
  let filePick: HTMLInputElement | undefined;

  /** write one field of the theme being edited, and persist immediately */
  const patch = (fn: (t: CustomTheme) => CustomTheme) => {
    /**
     * Patch the theme the editor is SHOWING, which is `editing()` — not `editingId()`.
     *
     * `editing()` falls back to the first theme when the signal names one that no longer exists
     * (or nothing at all), so the UI renders a real theme. `patch()` read the raw signal and
     * bailed when it was empty, so the editor was showing a theme that every edit silently
     * failed to touch: "choose image… で画像選択したのに何も変わらない". The two must resolve the
     * same way, or the panel lies about what it is editing.
     */
    const id = editing()?.id;
    if (!id) return;
    // apply the palette live so the operator sees the change as they type
    const next = props.themes().map((t) => (t.id === id ? fn(t) : t));
    props.onChange(next);
  };
  const setColour = (key: keyof ThemePalette, raw: string) => {
    const norm = normalizeColour(raw);
    // a half-typed value must not repaint the app with an empty colour: an unparseable string
    // leaves the LAST valid colour applied, which is what the operator sees while typing
    if (!norm) return;
    patch((t) => ({ ...t, palette: { ...t.palette, [key]: norm } }));
  };

  /** copy the CURRENT preset into a new custom theme, so presets never drift */
  const duplicatePreset = () => {
    /**
     * Copy whatever is PAINTED — preset or custom — and take the NAME from the same theme.
     *
     * Both halves must come from `paintedId`, because the palette below is read from the LIVE
     * document. Using `activeId` for the name while the colours came from the document split the
     * two under "follow the system": the copy got the painted palette and the selected theme's
     * label. Using `paintedId` for both keeps name and colours describing one theme.
     *
     * (An earlier bug had the same shape: looking the id up in THEMES alone meant duplicating a
     * CUSTOM theme produced "Dark copy" with `mode: "dark"`, because the lookup missed and fell
     * back to THEMES[0]. MEASURED: active=custom-x (mode light) produced a dark copy labelled after
     * the wrong theme.)
     */
    const activeCustom = props.themes().find((t) => t.id === props.paintedId);
    const activePreset = THEMES.find((t) => t.key === props.paintedId);
    const base = activeCustom ?? activePreset ?? THEMES[0]!;
    // Colours come from the LIVE document, which is what the operator is looking at: for a
    // preset that is the stylesheet's value, and for a custom theme the inline value it
    // applied. A hardcoded copy in JS would drift from app.css the first time a palette was
    // retuned, and copying a custom theme from DEFAULT_PALETTE would silently lose its colours.
    const cs = getComputedStyle(document.documentElement);
    const palette = { ...DEFAULT_PALETTE } as ThemePalette;
    for (const { key, cssVar } of PALETTE_KEYS) {
      const v = normalizeColour(cs.getPropertyValue(cssVar));
      if (v) palette[key] = v;
    }
    const id = newThemeId(props.themes().map((t) => t.id).concat(THEMES.map((t) => t.key)));
    const theme: CustomTheme = {
      id,
      label: `${base.label}${activeCustom ? "" : " copy"}`.slice(0, 40),
      mode: base.mode,
      palette,
      // carry the background too, or duplicating a themed setup loses the image
      ...(activeCustom?.backgroundImage
        ? {
            backgroundImage: activeCustom.backgroundImage,
            backgroundDim: activeCustom.backgroundDim,
            surfaceAlpha: activeCustom.surfaceAlpha,
          }
        : {}),
    };
    props.onChange([...props.themes(), theme]);
    setEditingId(id);
    /**
     * ADOPT the copy as the active theme.
     *
     * `applyCustomTheme()` only paints the theme that is ACTIVE — a custom theme the operator
     * is merely editing has no effect on the document. "Duplicate current" creates an editable
     * copy, so without this the operator got a copy they could edit with no visible result:
     * changing a colour, choosing a background image, none of it reached the screen. Reported
     * as "choose image… で画像選択したのに何も変わらない".
     *
     * Selecting the thing you just created is also what the button implies.
     */
    props.onPick(id);
  };

  /**
   * Upload the image to the SERVER and store its URL.
   *
   * It used to be read into a data URI and kept in `localStorage`, which forced a 1.5MB cap
   * because the whole origin shares a ~5MB quota — one wallpaper could break every other setting
   * the UI stores there, and a phone photo is bigger than that anyway. The bytes now live in
   * `<dataDir>/assets/` and the theme holds a short URL, so there is no size limit worth
   * mentioning and nothing competes with the theme palette for storage.
   *
   * The raw `File` is the request body (no multipart), because the server only needs the bytes
   * and its content type.
   */
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      flashHint(`that file is ${JSON.stringify(file.type || "unknown")} — pick an image`);
      return;
    }
    flashHint(`uploading ${file.name} (${Math.round(file.size / 1024)}KB)…`);
    try {
      const r = (await fetch("/api/assets", {
        method: "POST",
        headers: { "content-type": file.type },
        body: file,
      }).then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => null) }))) as {
        ok: boolean;
        body: { url?: string; bytes?: number; error?: string } | null;
      };
      if (!r.ok || !r.body?.url) {
        flashHint(r.body?.error ?? "upload failed");
        return;
      }
      patch((t) => ({ ...t, backgroundImage: r.body!.url!, backgroundImageBytes: r.body!.bytes }));
      /**
       * ADOPT the theme being edited — the image is otherwise invisible.
       *
       * `patch()` only repaints the theme that is ACTIVE (`applyCustomTheme` paints exactly
       * one), so uploading into a theme the operator has not selected set the URL, saved it, and
       * showed nothing: reported as "背景画像アップロードして保存したのに適用されない". It looked
       * like the upload had failed, because the one thing they asked for — seeing the picture —
       * did not change.
       *
       * Selecting the theme you just decorated is also what the action implies, and it is what
       * `duplicatePreset()` already does for the same reason.
       */
      const id = editing()?.id;
      if (id) props.onPick(id);
      flashHint("background image set");
    } catch (ex) {
      flashHint(`upload failed: ${(ex as Error).message}`);
    }
  };

  return (
    <div class="themeeditor">
      <h4 class="cfgsub">your themes</h4>
      <div class="btnrow">
        <button type="button" onclick={duplicatePreset} title="copy the theme you are using into a new editable one — presets themselves are never modified">
          ＋ duplicate current
        </button>
        {/**
          * NO theme picker here.
          *
          * The card grid above is the selection surface, and picking a card already makes that
          * theme the edited AND painted one. A second dropdown listing the same themes was the same
          * decision offered twice — "duplicate 右のプルダウンが不要、上で選択中のテーマの編集画面が出る
          * べきで、編集の選択経路は2つなくて良い". Two paths also meant two ways to disagree about
          * which theme is being edited, which is the class of bug this editor has already had.
          */}
      </div>

      <Show
        /**
         * The editing controls appear only when a CUSTOM theme is ACTIVE.
         *
         * They used to show whenever any custom theme existed, defaulting to the first one — so
         * the panel offered a colour picker for a theme that was not on screen and edits went
         * somewhere the operator had not chosen. Reported as "テーマエディタは、ユーザー作成テーマが
         * アクティブなときだけ出現してほしい".
         *
         * The "＋ duplicate current" row above stays ALWAYS visible: hiding the whole editor also
         * removed the only way to CREATE a custom theme, which the smoke test caught
         * ("no way to create a custom theme — the editor cannot be reached"). Create is how you
         * get into the state this gate tests for, so it cannot live behind the gate.
         *
         * `props.themes()` contains the active id — the same resolution the painter uses — so "is
         * it active" here and "is it painted" there cannot disagree.
         */
        when={editing() && props.themes().some((t) => t.id === props.activeId) ? editing() : null}
        fallback={
          <div class="muted" style="margin:6px 0">
            {props.themes().length === 0
              ? <>no custom themes yet — press <b>＋ duplicate current</b> to start from the palette you are using.</>
              : <>the editor shows when one of your themes is ACTIVE — pick one under "your themes" above (or press <b>＋ duplicate current</b>).</>}
          </div>
        }
      >
        {(t) => (
          <>
            <div class="cfggrid" style="margin-top:8px">
              {/**
                * NO name field here.
                *
                * "your themes のテーマ名欄と themes のテーマプレビュー選択が実質役割が重複している"
                * — the field and the card grid were two ways to point at the same theme, and the
                * label is what the card shows anyway. The theme keeps the name it was created
                * with (`<preset> copy`); an operator who wants a different one duplicates again,
                * which is the same effort as typing over it.
                */}
              <label class="trow">appearance
                <select
                  value={editing()!.mode}
                  onchange={(e) => patch((cur) => ({ ...cur, mode: e.currentTarget.value as "dark" | "light" }))}
                >
                  <option value="dark">dark</option>
                  <option value="light">light</option>
                </select>
              </label>
            </div>

            <div class="paletterows">
              <For each={PALETTE_KEYS}>
                {(k) => (
                  <label class="paletterow" title={k.cssVar}>
                    <input
                      type="color"
                      value={normalizeColour(editing()!.palette[k.key]) ?? "#000000"}
                      oninput={(e) => setColour(k.key, e.currentTarget.value)}
                    />
                    <span class="paletterow-label">{k.label}</span>
                    <input
                      class="mono paletterow-hex"
                      /**
                       * The DRAFT, not the stored colour.
                       *
                       * Bound to the palette value, every keystroke was normalised and reverted:
                       * typing "#ff" stores nothing (not a valid colour yet), so the input
                       * snapped back to the old value and the operator could never finish
                       * typing a hex. `#{hexDraft()[k.key] ?? stored}` lets an incomplete value
                       * sit in the field while only valid colours repaint the app.
                       */
                      value={hexDraft()[k.key] ?? editing()!.palette[k.key]}
                      spellcheck={false}
                      oninput={(e) => {
                        const raw = e.currentTarget.value;
                        setHexDraft((d) => ({ ...d, [k.key]: raw }));
                        setColour(k.key, raw);
                      }}
                      onblur={() =>
                        // leave the field showing the colour that actually got applied
                        setHexDraft((d) => {
                          const next = { ...d };
                          delete next[k.key];
                          return next;
                        })
                      }
                    />
                  </label>
                )}
              </For>
            </div>
            <div class="btnrow">
              <button
                type="button"
                title="put every colour back to the palette this theme was created from"
                onclick={() => patch((cur) => ({ ...cur, palette: { ...DEFAULT_PALETTE } }))}
              >
                ↺ reset palette
              </button>
              <button
                type="button"
                onclick={() => {
                  // capture the doomed id BEFORE mutating: `props.themes` is a getter, and
                  // reading it again after `onChange` depends on whether the parent has already
                  // re-rendered — the same expression then means two different things
                  const doomed = editing()?.id;
                  if (!doomed) return;
                  props.onChange(props.themes().filter((x) => x.id !== doomed));
                  setEditingId(props.themes().find((x) => x.id !== doomed)?.id ?? "");
                }}
                title="delete this custom theme"
              >
                🗑 delete
              </button>
            </div>

            <h4 class="cfgsub">background image</h4>
            <div class="cfggrid">
              {/**
                * THE PREVIEW IS THE CONTROL.
                *
                * Asked for as "replace imageボタンをやめて、背景画像が設定されているときは背景画像を
                * hoverでreplaceのガイド、クリックでファイルピッカーにしたほうが良い気がする、よくある
                * UIパターン". It is: the thing you want to change is the thing you click, and a
                * separate button makes the operator map "which image does this replace?" themselves.
                *
                * With NO image the same slot is an empty drop-target-style button, so there is still
                * exactly one place to go.
                *
                * The hidden `<input type="file">` is still the mechanism (a native file control
                * cannot be styled and always shows "no file chosen" once cleared), and it is still
                * cleared after each pick so the SAME file can be chosen twice.
                */}
              <button
                type="button"
                class={"bgpick" + (editing()!.backgroundImage ? " has" : "")}
                onclick={() => filePick?.click()}
                title={
                  editing()!.backgroundImage
                    ? "click to replace this background image (PNG/JPG/WebP)"
                    : "choose a background image (PNG/JPG/WebP)"
                }
              >
                <Show
                  when={editing()!.backgroundImage}
                  fallback={<span class="bgpick-empty">🖼 choose a background image…</span>}
                >
                  {/**
                    * `srcset` HERE TOO — this is why the appearance panel felt laggy.
                    *
                    * The app's own wallpaper (`<BgPhoto>`) loads through `srcset` + `sizes`, so the
                    * browser picks a width that suits the viewport. This preview asked for the
                    * ORIGINAL file, which is a multi-megabyte photo, and it does so every time the
                    * section opens. Asked as "appearanceがラグくて… こっちはUI本体と違って背景画像が
                    * srcset無しでロードされてる" — exactly right.
                    *
                    * The preview is small, so it asks for the smallest rung and never the original.
                    */}
                  <img
                    src={bgSrc(editing()!.backgroundImage)}
                    srcset={bgSrcSet(editing()!.backgroundImage)}
                    sizes="260px"
                    alt="current background"
                    decoding="async"
                    loading="lazy"
                  />
                  <span class="bgpick-hint">🖼 replace…</span>
                </Show>
              </button>
              <input
                ref={filePick}
                type="file"
                accept="image/*"
                style="display:none"
                oninput={(e) => e.stopPropagation()}
                onchange={(e) => {
                  // stop the change from reaching the settings <form>: it was firing a full
                  // PUT /api/config (saving every setting and running connectAll) on an upload
                  e.stopPropagation();
                  importFile(e.currentTarget.files?.[0]);
                  // clear so the SAME file can be picked again
                  e.currentTarget.value = "";
                }}
              />
              <Show when={editing()!.backgroundImage}>
                <div class="bgpreview">
                  {/**
                   * Show the UPLOADED size, not a guess from the URL length.
                   *
                   * The bytes live on the server and the theme stores only
                   * `/api/assets/<32hex>.<ext>`, so estimating from the string's length reported
                   * "0 KB" for every image. A size is only known at upload time.
                   */}
                  <span class="muted" title="this image is served from the server; the theme stores only its URL">
                    ✓ image set{(() => {
                      const b = editing()?.backgroundImageBytes;
                      return b ? ` — ${Math.max(1, Math.round(b / 1024))} KB` : "";
                    })()}
                  </span>
                  <div class="btnrow">
                    <label class="trow" title="how much the image is dimmed so text stays readable">
                      dim
                      <input
                        type="range"
                        min="0"
                        max="0.9"
                        step="0.05"
                        value={editing()!.backgroundDim ?? 0.55}
                        oninput={(e) => patch((cur) => ({ ...cur, backgroundDim: Number(e.currentTarget.value) }))}
                      />
                      <span class="muted mono">{Math.round((editing()!.backgroundDim ?? 0.55) * 100)}%</span>
                    </label>
                    {/**
                     * How see-through the code / tool cards are. Floored at 35% in
                     * `sanitizeTheme`: lower than that and monospace output over a busy photo
                     * becomes unreadable, which is the bug the opaque rule was added to fix.
                     */}
                    <label title="how much of the background shows through code blocks and tool cards — lower is more transparent">
                      surfaces
                      <input
                        type="range"
                        min="0.35"
                        max="1"
                        step="0.01"
                        value={editing()!.surfaceAlpha ?? 0.82}
                        oninput={(e) =>
                          patch((cur) => ({ ...cur, surfaceAlpha: Number(e.currentTarget.value) }))
                        }
                      />
                      <span class="muted mono">
                        {Math.round((editing()!.surfaceAlpha ?? 0.82) * 100)}%
                      </span>
                    </label>
                    <button type="button" onclick={() => patch((cur) => ({ ...cur, backgroundImage: undefined }))}>
                      ✕ remove
                    </button>
                  </div>
                </div>
              </Show>
            </div>
            <div class="muted" style="margin-top:6px;font-size:var(--text-xs)">
              the image is uploaded to the server and sits behind the panels, dimmed so text
              stays readable. No size limit — it is a file now, not browser storage.
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

export function ConfigModal(props: {
  cfg: any;
  onClose: () => void;
  onSaved: () => void;
  /**
   * MCP servers whose missing grant has already been announced.
   *
   * Owned by App and shared across opens, because "this server needs authorization" is a fact
   * about the SERVER, not about this dialog instance: a per-mount Set would forget it every
   * time the dialog was closed and re-open the same interruption on the next save.
   */
  announcedOAuth: Set<string>;
  /**
   * Skills available to the SELECTED session, for the skills section.
   *
   * Read-only and passed in rather than fetched here: App already holds them for the `/` command
   * palette, and a second fetch would be a second copy to keep in step.
   */
  skills: { name: string; description: string }[];
  /** whether a session is selected at all, so the lists can say "select a session" honestly */
  hasSelection: boolean;
  /** the selected agent's id, so a skill body can be fetched by name */
  agentId: string | null;
  /** optional native tools this host has; null while unknown */
  features: {
    imageResize: { available: boolean; tool: string | null; maxEdge: number; found: { name: string; present: boolean }[] };
    pty: { available: boolean; provider: string | null };
  } | null;
  /** theme state, owned by App because it paints `<html>` */
  theme: {
    themes: () => CustomTheme[];
    activeId: () => string;
    /** the id ACTUALLY PAINTED (differs from activeId under "follow the system") */
    paintedId: () => string;
    auto: () => boolean;
    setAuto: (v: boolean) => void;
    dark: () => string;
    setDark: (v: string) => void;
    light: () => string;
    setLight: (v: string) => void;
    setThemes: (v: CustomTheme[]) => void;
    setActive: (v: string) => void;
    /** persist the appearance — called by SAVE, never by a preview */
    commitAppearance: (v: { auto: boolean; dark: string; light: string; fixed: string }) => void;
    /** paint this id regardless of the slot the OS selects, or null to stop previewing */
    preview: (id: string | null) => void;
  };
}) {
  /**
   * a provider row holds a LIST of keys, rotated round-robin by the server.
   *
   * `apiKeys` is read when present and `apiKey` seeds it otherwise, matching the
   * migration on the server side — an existing config must open in this dialog
   * showing its key, and save back without changing its shape.
   */
  type PRow = { name: string; baseUrl: string; apiKeys: string[]; model: string };
  const rowOf = (name: string, v: any): PRow => {
    const keys: string[] = Array.isArray(v?.apiKeys) && v.apiKeys.length
      ? v.apiKeys.filter((k: unknown) => typeof k === "string" && k.trim())
      : v?.apiKey
        ? [String(v.apiKey)]
        : [""];
    return { name, baseUrl: v?.baseUrl ?? "", apiKeys: keys.length ? keys : [""], model: v?.model ?? "" };
  };
  const [providers, setProviders] = createSignal<PRow[]>(
    Object.entries(props.cfg.providers ?? {}).map(([name, v]: [string, any]) => rowOf(name, v)),
  );
  const [defaultProvider, setDefaultProvider] = createSignal(props.cfg.defaultProvider ?? "");
  // the default as it exists on disk, so we can tell "configured but missing"
  // from "you just changed it"
  const cfgDefaultProvider = () => props.cfg.defaultProvider ?? "";
  // A <select> whose value matches no <option> silently falls back to the
  // first option — which is exactly the "(none — first provider wins)" row.
  // So a configured default that has no provider row (deleted/renamed) showed
  // as "none", i.e. as if the topmost provider were always chosen, and the
  // next save persisted that. Render the orphaned name as its own option so
  // the dropdown always shows the real value.
  const providerNames = (): string[] => {
    const names = [...new Set(providers().map((p) => p.name.trim()).filter(Boolean))];
    const cur = defaultProvider();
    if (cur && !names.includes(cur)) names.push(cur);
    return names;
  };
  const staleDefaultProvider = (): string => {
    const cur = defaultProvider();
    if (!cur) return "";
    return providers().some((p) => p.name.trim() === cur) ? "" : cur;
  };
  const [intervalMin, setIntervalMin] = createSignal(Math.round((props.cfg.progressIntervalMs ?? 600000) / 60000));
  const [minChars, setMinChars] = createSignal(props.cfg.progressMinChars ?? 4000);
  // empty input = DERIVED budget (75% of each model's window) — the old UI
  // always showed 96 and saved it back on every settings save, silently
  // turning every agent into "manual override" at a fixed 96k that fit
  // neither 32k local models nor 1M-context ones. Null means "not set".
  const [ctxBudgetK, setCtxBudgetK] = createSignal<number | null>(
    props.cfg.contextTokenBudget != null ? Math.round(props.cfg.contextTokenBudget / 1000) : null,
  );
  const [ctxWinK, setCtxWinK] = createSignal(props.cfg.contextWindowTokens ? Math.round(props.cfg.contextWindowTokens / 1000) : 0);
  const [maxDepth, setMaxDepth] = createSignal(props.cfg.maxSpawnDepth ?? 3);
  const [shortContext, setShortContext] = createSignal(Boolean(props.cfg.shortContext));
  /**
   * The `/api/*` password — empty means "no auth", which is correct and safe on loopback.
   *
   * This field exists because there was NO way to set one: `POST /api/setup` accepts a password but
   * refuses once a config file exists, and that path was only ever driven by the first-run wizard,
   * which was removed. Asked as "初回起動ウィザードは前に廃止したはずだからパスワード設定できないのでは?"
   * — correct, and the answer is this field rather than resurrecting the wizard.
   *
   * Seeded EMPTY rather than showing the stored value: it is a secret, and the panel has no way to
   * display "unchanged" for it the way masked provider keys do. An untouched empty field therefore
   * means "leave it alone", which is why the save only sends it when it was actually edited.
   */
  const [apiPassword, setApiPassword] = createSignal("");
  const [apiPasswordDirty, setApiPasswordDirty] = createSignal(false);
  const [tasks, setTasks] = createSignal<any[]>((props.cfg.tasks ?? []).map((t: any) => ({ ...t })));
  // MCP servers. The header text is kept separately as STRINGS: the config holds
  // an object, and round-tripping it through JSON on every keystroke would rewrite what
  // the operator is typing (a half-typed quote would be erased mid-word).
  const [mcpServers, setMcpServers] = createSignal<any[]>(
    (props.cfg.mcpServers ?? []).map((m: any) => ({ ...m })),
  );
  const [mcpHeadersText, setMcpHeadersText] = createSignal<Record<number, string>>(
    Object.fromEntries(
      (props.cfg.mcpServers ?? []).map((m: any, i: number) => [
        i,
        m.headers ? JSON.stringify(m.headers) : "",
      ]),
    ),
  );
  const [mcpHeaderErr, setMcpHeaderErr] = createSignal<Record<number, string>>({});
  /**
   * Which auth input to show per row, and its value.
   *
   * "headers as JSON" was the only way to authenticate, reported as "正直わかりやすいとは言い難い":
   * a bearer token meant knowing the header name, the "Bearer " prefix and JSON quoting — to do
   * the one thing every server needs. A choice with one input per case makes the common path a
   * paste; the JSON box stays for anything unusual.
   *
   * Derived from the saved headers so re-opening settings shows the right control rather than
   * resetting everything to "no auth".
   */
  const [mcpAuthKind, setMcpAuthKind] = createSignal<
    Record<number, "none" | "bearer" | "header" | "json">
  >(
    Object.fromEntries(
      (props.cfg.mcpServers ?? []).map((m: any, i: number) => {
        const h = (m.headers ?? {}) as Record<string, string>;
        const keys = Object.keys(h);
        if (!keys.length) return [i, "none"];
        const only = keys.length === 1 ? keys[0]! : "";
        if (only === "Authorization" && /^Bearer /i.test(h[only] ?? "")) return [i, "bearer"];
        return [i, keys.length === 1 ? "header" : "json"];
      }),
    ),
  );
  const [mcpAuthValue, setMcpAuthValue] = createSignal<Record<number, string>>(
    Object.fromEntries(
      (props.cfg.mcpServers ?? []).map((m: any, i: number) => {
        const h = (m.headers ?? {}) as Record<string, string>;
        const keys = Object.keys(h);
        if (keys.length !== 1) return [i, ""];
        const only = keys[0]!;
        return [i, only === "Authorization" ? (h[only] ?? "").replace(/^Bearer /i, "") : (h[only] ?? "")];
      }),
    ),
  );
  const [mcpHeaderName, setMcpHeaderName] = createSignal<Record<number, string>>(
    Object.fromEntries(
      (props.cfg.mcpServers ?? []).map((m: any, i: number) => {
        const keys = Object.keys((m.headers ?? {}) as Record<string, string>);
        const only = keys.length === 1 ? keys[0]! : "";
        return [i, only && only !== "Authorization" ? only : ""];
      }),
    ),
  );
  const [mcpStatus, setMcpStatus] = createSignal<
    Record<
      number,
      {
        kind: "testing" | "ok" | "err";
        text: string;
        /** what the connect found — a COUNT alone cannot tell you it is the right server */
        tools?: { name: string; description?: string }[];
        needsOAuth?: boolean;
      }
    >
  >({});
  /**
   * Pending debounce timers for the URL-triggered OAuth probe, keyed by row.
   *
   * A plain object rather than a closure per row: a row can be removed while its timer is pending,
   * so the callback re-reads `mcpServers()[i]` and bails when the row is gone.
   */
  const urlProbeTimers: Record<number, ReturnType<typeof setTimeout> | undefined> = {};
  /**
   * Ask the server whether an UNSAVED config needs OAuth, and show the 🔑 button if so.
   *
   * `/api/mcp/test` takes a config and never touches the saved list, so this is safe to run before
   * a save — which is the point: the operator should not have to save, close, reopen and authorize.
   */
  const probeOAuth = async (i: number, cfg: Record<string, unknown>) => {
    if (!mcpServers()[i]) return; // the row was removed while the timer was pending
    const r = (await api("/api/mcp/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cfg),
    }).catch(() => null)) as { ok?: boolean; error?: string; needsOAuth?: boolean; tools?: unknown[] } | null;
    if (!mcpServers()[i]) return;
    // only a DEFINITE answer replaces the status: a network blip must not wipe what is shown
    if (!r) return;
    setMcpStatus((m) => ({
      ...m,
      [i]: r.ok
        ? { kind: "ok", text: `${(r.tools as unknown[] | undefined)?.length ?? 0} tools` }
        : {
            kind: "err",
            text: r.needsOAuth ? "needs authorization — press 🔑" : r.error ?? "no response",
            ...(r.needsOAuth ? { needsOAuth: true } : {}),
          },
    }));
  };
  // live per-server state, refreshed when the section is opened
  const [mcpStates, setMcpStates] = createSignal<Record<string, any>>({});
  /**
   * Per-server OAuth state, keyed by NAME.
   *
   * It was keyed by row INDEX, and that silently broke in two directions. The save path
   * iterates `cleanMcp` (which SKIPS blank rows) while the row UI iterates `mcpServers()`, so
   * the two disagree the moment any row is blank — the status fetched for server N got stored
   * under a different row's index, and the save then read a stale flag and redirected to the MCP
   * section on saves that had nothing to do with MCP ("テーマ編集後に save settings をすると
   * MCP servers のセクションに飛ぶ").
   *
   * A name is the server's identity everywhere else (the server itself looks states up by name),
   * so it is the only key that cannot drift.
   */
  const [mcpOAuth, setMcpOAuth] = createSignal<
    Record<string, { required?: boolean; authorized?: boolean; hasRefreshToken?: boolean; flow?: { phase: string; url?: string } }>
  >({});
  /**
   * The OAuth state for a server NAME, or null when the server is not OAuth at all.
   *
   * Keyed by name because that is the server's identity everywhere else (`mcpOAuth` was once keyed
   * by ROW INDEX and drifted between the save loop and the render loop). Returned as an accessor so
   * the dropdown re-renders when authorization completes.
   */
  const oauthState = (name: string) => {
    const st = oauthStateFrom(mcpOAuth(), name);
    return st && (st.required || st.authorized) ? st : null;
  };
  const refreshMcpStates = async () => {
    const r = (await api("/api/mcp").catch(() => null)) as { states?: any[] } | null;
    setMcpStates(Object.fromEntries((r?.states ?? []).map((s: any) => [s.name, s])));
  };
  const refreshMcpOAuth = async (name: string) => {
    const key = String(name ?? "").trim();
    if (!key) return;

    // "needs OAuth" is discovered by the server itself now: an unauthorized connect
    // leaves the state flagged, so there is no separate probe to trigger here.
    const r = (await api(`/api/mcp/oauth/status?name=${encodeURIComponent(key)}`).catch(
      () => null,
    )) as any;
    if (r && !r.error) setMcpOAuth((m) => ({ ...m, [key]: r }));
  };
  /**
   * Start OAuth for one server and open the authorization page.
   *
   * The server answers as soon as the SDK's discovery + registration produce a URL; the
   * token exchange finishes when the browser hits the loopback callback. So the panel
   * opens a tab and POLLS — polling is what makes "authorized" appear on its own, which
   * is the whole point of an automatic flow.
   */
  const startMcpOAuth = async (i: number, srv: any) => {
    if (!srv.name) {
      setMcpStatus((m) => ({ ...m, [i]: { kind: "err", text: "give it a name first" } }));
      return;
    }
    setMcpStatus((m) => ({
      ...m,
      [i]: { kind: "testing", text: "discovering the authorization server…" },
    }));
    const r = (await api("/api/mcp/oauth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      /**
       * Send the URL too, so an UNSAVED server can be authorized.
       *
       * The endpoint used to require the name to exist in `config.mcpServers`, which forced
       * save → dialog closes → reopen → authorize → save again. The grant is stored per server
       * NAME, so authorizing first and saving afterwards keeps it.
       */
      body: JSON.stringify({ name: srv.name, url: srv.url }),
    }).catch(() => null)) as
      | { ok?: boolean; url?: string; error?: string; alreadyAuthorized?: boolean }
      | null;
    if (r?.alreadyAuthorized) {
      setMcpStatus((m) => ({ ...m, [i]: { kind: "ok", text: "already authorized" } }));
      await refreshMcpOAuth(srv.name);
      await refreshMcpStates();
      return;
    }
    if (!r?.ok || !r.url) {
      setMcpStatus((m) => ({ ...m, [i]: { kind: "err", text: r?.error ?? "no response" } }));
      await refreshMcpOAuth(srv.name);
      return;
    }
    // Open the authorization page. `noopener` is deliberate: the page must not get a
    // handle on this window.
    window.open(r.url, "_blank", "noopener");
    setMcpStatus((m) => ({
      ...m,
      [i]: { kind: "testing", text: "waiting for you to finish in the browser…" },
    }));
    // poll until the flow settles (the server gives up after 5 minutes)
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 1000));
      const st = (await api(`/api/mcp/oauth/status?name=${encodeURIComponent(srv.name)}`).catch(
        () => null,
      )) as any;
      if (!st || st.error) continue;
      /**
       * Keyed by NAME, like every reader of this map.
       *
       * This wrote `[i]` — the row INDEX — while `mcpOAuth()` is read as
       * `mcpOAuth()[server.name]` everywhere. Index 0 therefore answered for whatever server
       * happened to be first, so a freshly authorized server showed nothing and an unrelated row
       * could pick up its state. Reported as "何故かCanvaだけ 🔑 authorized って出てる" with three
       * OAuth servers configured: only the row whose index coincided with a written key matched.
       * The map's own docblock already said "keyed by name because that is the identity that cannot
       * drift"; this call was the one place that had not been converted.
       */
      setMcpOAuth((m) => ({ ...m, [srv.name]: st }));
      if (st.authorized) {
        setMcpStatus((m) => ({
          ...m,
          [i]: { kind: "ok", text: "authorized — the tools are available now" },
        }));
        await refreshMcpStates();
        // `onSaved` re-fetches the agent list, so a newly-authorized server's tools are
        // usable on the next turn rather than being a promise
        props.onSaved();
        return;
      }
      if (st.flow?.phase === "error") {
        setMcpStatus((m) => ({
          ...m,
          [i]: { kind: "err", text: st.flow.message ?? st.lastError ?? "authorization failed" },
        }));
        return;
      }
    }
    setMcpStatus((m) => ({ ...m, [i]: { kind: "err", text: "authorization timed out" } }));
  };
  createEffect(() => {
    if (section() !== "mcp") return;
    void refreshMcpStates();
    // OAuth state is per row and changes independently of the server list, so it is
    // fetched for every configured server when the section opens.
    mcpServers().forEach((m, i) => {
      if (m.name) void refreshMcpOAuth(m.name);
    });
  });
  const [err, setErr] = createSignal("");

  /**
   * Which section the settings dialog is showing.
   *
   * The five sections used to be stacked in one column, so reaching the task list meant
   * scrolling past every provider row — and with several providers (each now holding
   * several keys, #170) the dialog was a wall of inputs with no way to see what it
   * contained. A menu on the left names them, shows only one at a time, and marks the
   * one you are on.
   *
   * The SAVE button stays outside the menu: it applies the whole form, so it must not
   * look like it belongs to whichever section happens to be visible.
   */
  type Section = "providers" | "runtime" | "appearance" | "mcp" | "tasks" | "archive" | "agents" | "update" | "skills" | "help";
  const [section, setSection] = createSignal<Section>("providers");
  /**
   * Pick a theme from a CARD, routing to whichever slot the painter actually reads.
   *
   * Under "follow the system" the painted theme comes from the dark/light slots, so the cards'
   * old `setActive(...)` (which writes the FIXED slot) changed a value nothing read: the card
   * highlighted and the screen did not move. That invisible-edit shape is what showed up as
   * "follow the system を入れてるときにテーマ複製したりするとやっぱりちょっと変な挙動になる".
   *
   * A card writes the slot for ITS OWN mode, exactly as the labelled pickers above do — so picking
   * a light card while the OS is dark updates the light slot instead of applying something the OS
   * mode says is not current.
   */
  const pickThemeCard = (id: string, mode: "dark" | "light") => {
    const { slot } = slotForSelection(props.theme.auto(), mode);
    /**
     * Through `applyDraft`, so a card click is BOTH a draft edit and a preview.
     *
     * Calling the setters directly wrote the slot but never previewed, so a light card clicked
     * while the OS is dark still showed nothing — the painter reads the slot matching the OS.
     */
    if (slot === "dark") setSysDarkTheme(id);
    else if (slot === "light") setSysLightTheme(id);
    else setFixedTheme(id);
  };
  /**
   * Which card reads as selected.
   *
   * Following the system there are TWO slots, so BOTH marked cards are legitimate — the dark choice
   * and the light choice each carry a frame, because each is the answer for one appearance. Asked
   * as "follow systemの時はdarkとlightでそれぞれ選択中のやつに枠が出て、最後に押したテーマが
   * プレビューされるべき".
   *
   * Marking only `paintedIdFor()` (the slot the OS is currently in) hid the other choice entirely:
   * the operator could not see what their light theme was set to without flipping the OS.
   *
   * Not following the system there is one slot, so exactly one card is marked.
   */
  const themeCardChosen = (id: string) =>
    props.theme.auto()
      ? id === props.theme.dark() || id === props.theme.light()
      : id === props.theme.activeId();
  // the archive list is SERVER state (which entries are archived), fetched on open
  // and after every action — not derived from props.cfg, which carries the config as
  // loaded and would go stale the moment an agent is archived from the controls panel
  const [archived, setArchived] = createSignal<
    {
      id: string;
      workspace: string;
      archivedAt?: number;
      sessions: number;
      parent?: string;
      subs?: number;
    }[]
  >([]);
  const refreshArchived = async () => {
    const r = (await api("/api/archived").catch(() => null)) as {
      agents?: {
        id: string;
        workspace: string;
        archivedAt?: number;
        sessions: number;
        parent?: string;
        subs?: number;
      }[];
    } | null;
    setArchived(r?.agents ?? []);
  };
  // Only TOP-LEVEL archived entries get a row. Archiving a parent takes its subtree
  // with it, so listing every descendant individually would suggest the operator
  // archived several things when they archived one — and restoring the parent already
  // brings the children back.
  const archivedTop = () => archived().filter((a) => !a.parent);
  // refresh whenever the panel is OPENED, so it never shows a stale list
  createEffect(() => {
    if (section() === "archive") void refreshArchived();
  });
  const SECTIONS: { key: Section; label: string; hint: string }[] = [
    { key: "providers", label: "🧦 providers", hint: "endpoints, API keys, default models" },
    // themes moved here from a sidebar icon: it is a preference, not a per-session action,
    // and the editor needs room a popover does not have
    { key: "appearance", label: "🎨 appearance", hint: "theme, custom palettes, background image" },
    { key: "runtime", label: "⚙️ runtime", hint: "context budget, retries, spawn depth" },
    { key: "tasks", label: "⏰ scheduled tasks", hint: "cron prompts run against an agent" },
    { key: "mcp", label: "🔌 MCP servers", hint: "external tool servers exposed to every agent" },
    { key: "archive", label: "🗄 archive", hint: "agents you put away — restore or delete for good" },
    { key: "agents", label: "👥 agents", hint: "what exists (read-only)" },
    { key: "update", label: "⬆️ live update", hint: "restart onto a newer build" },
    // what the agent can load: skills it wrote itself, workspace ones, and bundled ones
    { key: "skills", label: "🧠 skills", hint: "reusable playbooks available to the selected session" },
    // where the explanations that used to sit permanently under the UI now live
    { key: "help", label: "❔️ help", hint: "keyboard shortcuts and what each toggle does" },
  ];

  const agentIds = () => (props.cfg.agents ?? []).map((a: any) => a.id);

  // Theme state is owned by App (it paints `<html>`); these local names keep the appearance
  // panel readable without implying a second copy of the state.
  const customThemes = () => props.theme.themes();
  const fixedTheme = () => props.theme.activeId();
  /**
   * The appearance actually in force, for gating the theme groups.
   *
   * A custom theme carries its own `mode`; a preset's lives in `THEMES`. Both are needed because a
   * custom light theme must count as light. Defaulting to "dark" matches `<html>`'s own default, so
   * the grouping can never offer a group the document is not painting.
   */
  /**
   * APPEARANCE IS A DRAFT UNTIL SAVE.
   *
   * Every other section here commits on the save button, and themes used to commit on click — so
   * the same dialog had two meanings for "apply". Reported as "save settingsボタンがあるのにテーマは
   * saveしなくても適用確定してるから設定の操作に一貫性が無い".
   *
   * The PREVIEW still has to be immediate (you cannot choose a colour you cannot see), so the draft
   * is pushed to the live theme on every change and only PERSISTED on save:
   *
   *   click  → the screen changes            (preview)
   *   save   → written to localStorage        (commit)
   *   close  → the stored values are restored (discard)
   *
   * The draft starts from whatever is stored, so an untouched dialog commits nothing new.
   */
  /**
   * The state as STORED when the dialog opened — captured ONCE, so a discard can restore it.
   *
   * `props.theme.*()` reads the live signal, which the preview has already changed; reading it at
   * revert time would restore the preview, not the stored value.
   */
  const storedAppearance = {
    auto: localStorage.getItem("teapot.theme.auto") === "1",
    dark: localStorage.getItem("teapot.theme.dark") ?? "dark",
    light: localStorage.getItem("teapot.theme.light") ?? "light",
    fixed: localStorage.getItem("teapot.theme") ?? "dark",
  };
  const draft = createSignal(storedAppearance);
  const draftOf = draft[0];
  /**
   * Push a draft to the LIVE theme without storing it.
   *
   * `props.theme.set*` persists (it has to, for the sidebar's own theme switch), so previewing
   * through it would commit. The setters below therefore write the signal and let `commit` own
   * storage — see `commitAppearance`.
   */
  const applyDraft = (next: Partial<ReturnType<typeof draftOf>>) => {
    const merged = { ...draftOf(), ...next };
    draft[1](merged);
    props.theme.setAuto(merged.auto);
    props.theme.setDark(merged.dark);
    props.theme.setLight(merged.light);
    props.theme.setActive(merged.fixed);
    /**
     * PREVIEW the theme just chosen, whichever slot it landed in.
     *
     * Following the system the painter reads the slot matching the OS appearance, so choosing the
     * LIGHT theme while the OS is dark wrote a value nothing painted — the click looked dead.
     * Previewing the id directly makes the last-clicked theme visible regardless of which slot the
     * OS selects, which is what "最後に押したテーマがプレビューされる" means.
     */
    const chosen = next.dark ?? next.light ?? next.fixed;
    if (chosen) props.theme.preview(chosen);
  };
  const setFixedTheme = (v: string) => applyDraft({ fixed: v });
  const themeAuto = () => draftOf().auto;
  const setThemeAuto = (v: boolean) => applyDraft({ auto: v });
  const sysDarkTheme = () => draftOf().dark;
  const setSysDarkTheme = (v: string) => applyDraft({ dark: v });
  const sysLightTheme = () => draftOf().light;
  const setSysLightTheme = (v: string) => applyDraft({ light: v });
  const setCustomThemes = (v: CustomTheme[]) => props.theme.setThemes(v);

  /**
   * Restore the stored appearance — the DISCARD path.
   *
   * Called when the dialog closes without saving. Without it the preview would silently become the
   * committed state, which is the inconsistency this whole change removes.
   */
  const revertAppearance = () => {
    const s = storedAppearance;
    props.theme.setAuto(s.auto);
    props.theme.setDark(s.dark);
    props.theme.setLight(s.light);
    props.theme.setActive(s.fixed);
    // stop previewing: back to whichever slot the OS selects
    props.theme.preview(null);
  };

  /**
   * A PRESET's palette, read back from the stylesheet so a preview can be drawn for it.
   *
   * The presets live as `[data-theme="…"]` blocks in app.css, and duplicating all ten palettes
   * into JS would be a second source of truth that silently drifts the first time a theme is
   * retuned. Instead the variables are read for real: a detached probe carries the
   * `data-theme` attribute, and `getComputedStyle` resolves the cascade for it.
   *
   * Memoised per key — this touches computed style, so it must not run per render.
   */
  /**
   * A PRESET's palette, for drawing its preview.
   *
   * A static table (`PRESET_PALETTES`), NOT a probe: the first version appended an element to
   * `document.body` to resolve the CSS cascade, and doing that from inside a `<For>` render broke
   * the settings dialog (MEASURED: "the config dialog renders no key inputs at all"). The table
   * duplicates app.css, which is unavoidable — a bundler inlines the stylesheet as a blob and
   * its rules are not readable back — so `test/theme-store.test.ts` asserts the two agree.
   */
  const presetPalette = (key: string): ThemePalette => PRESET_PALETTES[key] ?? DEFAULT_PALETTE;

  const saveProviders = (): Record<string, any> | null => {
    const out: Record<string, any> = {};
    for (const p of providers()) {
      if (!p.name.trim()) { setErr("provider name is required"); return null; }
      if (p.baseUrl && !/^https?:\/\//.test(p.baseUrl)) { setErr(`provider ${p.name}: baseUrl must start with http(s)://`); return null; }
      // blanks are dropped on save (an empty row the operator added and did not
      // fill), and the legacy scalar mirrors the FIRST key so anything still
      // reading `apiKey` keeps working
      const keys = p.apiKeys.map((k) => k.trim()).filter(Boolean);
      out[p.name.trim()] = {
        baseUrl: p.baseUrl,
        ...(keys.length ? { apiKeys: keys, apiKey: keys[0] } : {}),
        ...(p.model ? { model: p.model } : {}),
      };
    }
    return out;
  };

  /**
   * What the save button should say — the same shape as the model panel's apply.
   *
   * Reported: "設定のsaveが適用されたのかわかりにくいのでmodelパネルのapplyと同じ感じにしてほしい".
   * The model panel disables the button, does the work, shows `✓ applied` and restores the label;
   * this footer just said "save settings" the whole time, so a save that succeeded and one that
   * did nothing looked identical.
   */
  const [saveState, setSaveState] = createSignal<"idle" | "saving" | "saved" | "error">("idle");

  /**
   * A validation failure clears "saving" in ONE place.
   *
   * `save` has six early `return`s (a task with no agent, an MCP row with no name, …). Resetting the
   * state at each of them is a list of things to forget — and forgetting one parks the button
   * disabled on "saving…" for good, so the only control that could retry is dead.
   */
  const failSave = (message: string) => {
    setErr(message);
    setSaveState((s) => (s === "saving" ? "idle" : s));
  };

  const save = async (e: Event) => {
    e.preventDefault(); setErr("");
    setSaveState("saving");
    const providers = saveProviders();
    if (!providers) return setSaveState("idle");
    const cleanTasks = tasks()
      .filter((t) => t.id?.trim() || t.prompt?.trim())
      .map((t, i) => ({ id: t.id?.trim() || `task-${i + 1}`, agent: t.agent, schedule: t.schedule, prompt: t.prompt, ...(t.forked ? { forked: true } : {}) }));
    for (const t of cleanTasks) {
      if (!t.agent) return failSave(`task "${t.id}": agent is required`);
      if (!t.schedule?.trim()) return failSave(`task "${t.id}": schedule is required`);
    }
    // MCP servers: validate HERE so a bad entry fails in the dialog that made it.
    // A nameless server would otherwise connect as "" and its tools would flatten to
    // `mcp____tool`, which the model cannot tell apart from another nameless one.
    const cleanMcp: any[] = [];
    const seenMcp = new Set<string>();
    for (const m of mcpServers()) {
      const name = String(m.name ?? "").trim();
      const url = String(m.url ?? "").trim();
      const transport = m.transport ?? "http";
      const command = String(m.command ?? "").trim();
      if (!name && !url && !command) continue; // a blank row is not an error
      if (!name) return failSave("MCP: a server needs a name");
      if (seenMcp.has(name)) return failSave(`MCP: two servers are named "${name}"`);
      seenMcp.add(name);
      if (transport === "stdio" ? !command : !url) {
        return failSave(
          `MCP "${name}": ${transport === "stdio" ? "a command is" : "a url is"} required`,
        );
      }
      cleanMcp.push({
        name,
        transport,
        enabled: m.enabled !== false,
        ...(url ? { url } : {}),
        ...(transport === "stdio"
          ? { command, ...(m.args?.length ? { args: m.args } : {}) }
          : {}),
        ...(m.headers && Object.keys(m.headers).length ? { headers: m.headers } : {}),
      });
    }
    try {
      await api("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providers,
          defaultProvider: defaultProvider() || undefined,
          progressIntervalMs: Math.max(1, intervalMin()) * 60000,
          progressMinChars: Math.max(100, minChars()),
          ...(ctxBudgetK() != null ? { contextTokenBudget: Math.max(1, ctxBudgetK()!) * 1000 } : {}),
          ...(ctxWinK() > 0 ? { contextWindowTokens: ctxWinK() * 1000 } : {}),
          maxSpawnDepth: Math.max(0, maxDepth()),
          shortContext: shortContext(),
          ...(apiPasswordDirty() ? { password: apiPassword() } : {}),
          tasks: cleanTasks,
          mcpServers: cleanMcp,
        }),
      });
      // The save also CONNECTS every server (`PUT /api/config` → `mcp.connectAll()`), and
      // THAT is what discovers "this one needs OAuth". The panel only fetched OAuth
      // status when the section OPENED, so the 🔑 authorize button did not appear until
      // the operator closed and reopened settings — reported as "一回設定を閉じて、再度
      // 開かないとOAuthのボタンが出ない".
      //
      // `connectAll()` is fired-and-forgotten server-side, so the result lands AFTER this
      // response: refresh now AND once more shortly after, then let the operator see the
      // outcome. Closing immediately would hide the very thing the save discovered.
      await refreshMcpStates();
      await Promise.all(
        cleanMcp.map((m, i) => (m.name ? refreshMcpOAuth(m.name) : Promise.resolve())),
      );
      // one more pass after the connections settle
      setTimeout(() => {
        void refreshMcpStates();
        cleanMcp.forEach((m, i) => {
          if (m.name) void refreshMcpOAuth(m.name);
        });
      }, 1200);
      props.onSaved();
      /**
       * Move to the MCP section only when THIS save NEWLY discovered a missing grant.
       *
       * Reported twice ("save settings をすると何故か MCP servers のセクションに移動する"), and
       * the first fix was not enough. It narrowed the scan to the names this save wrote, but a
       * server that needs a grant KEEPS needing it until someone authorizes it — so once that
       * was true, every later save jumped again. The condition described an ongoing state, not
       * an event.
       *
       * A redirect earns its interruption only once: the moment the panel learns there is
       * something to act on. After that the 🔑 badge in the row is the standing notice, and the
       * save does what the operator asked it to do — save and close.
       */
      const savedNames = new Set(cleanMcp.map((m) => m.name).filter(Boolean));
      const needing = mcpServers().filter((m) => {
        const key = String(m.name ?? "").trim();
        return (
          savedNames.has(key) && mcpOAuth()[key]?.required && !mcpOAuth()[key]?.authorized
        );
      });
      const newlyNeeding = needing.filter((m) => !props.announcedOAuth.has(String(m.name ?? "")));
      const needsAction = newlyNeeding.length > 0;
      if (needsAction) {
        // remember it, so the NEXT save closes instead of interrupting again
        for (const m of newlyNeeding) props.announcedOAuth.add(String(m.name ?? ""));
        /**
         * NEVER navigate away from the section the operator was editing.
         *
         * Reported twice: "設定パネルの appearance を保存するとMCP serversに移動する". The
         * redirect was meant as a courtesy — a saved server needs authorization, so take them
         * there. But it fired on saves that had nothing to do with MCP, so saving a theme
         * silently moved the panel to a different section, which reads as the save having done
         * something it did not.
         *
         * They are already LOOKING at the MCP section in the one case where moving is a no-op,
         * so the panel stays put and the hint names the server. The hint is where the
         * information goes: it is visible on any section, and it does not move anything.
         */
        const names = newlyNeeding.map((m) => String(m.name ?? "").trim()).filter(Boolean);
        flashHint(
          `${names.join(", ") || "a saved MCP server"} needs authorization — 🔑 authorize in MCP servers`,
        );
      }
      /**
       * The panel CLOSES on a successful save, in every case.
       *
       * The OAuth branch above used to return without closing, so saving anything — appearance
       * included — left the dialog on screen whenever a saved MCP server merely *needed* a grant.
       * では設定ウィンドウが閉じる". The hint is the whole message; keeping the dialog open only made
       * the behaviour differ by section.
       *
       * The button state is set FIRST and the close deferred: a state change on a component that is
       * already unmounting would never be painted, and the operator would see the dialog vanish
       * with no confirmation.
       */
      /**
       * COMMIT the appearance here, not on click.
       *
       * Everything the operator can see is already live (the preview pushed it); this makes it
       * survive a reload, which is what "save settings" means for every other section.
       */
      props.theme.commitAppearance(draftOf());
      props.theme.preview(null); // the committed state now paints itself
      setSaveState("saved");
      // the draft IS the stored state now: closing must not revert what was just saved
      Object.assign(storedAppearance, draftOf());
      setTimeout(() => {
        setSaveState("idle");
        props.onClose();
      }, 400);
    } catch (ex) {
      setErr((ex as Error).message);
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 1600);
    }
  };


  return (
    <Modal
      title="settings"
      onClose={() => {
        /**
         * CLOSING DISCARDS an unsaved appearance preview.
         *
         * The preview writes the live theme so the choice is visible; without this, closing the
         * dialog would silently keep a change the operator never saved — the inconsistency that
         * "save settings" is supposed to resolve.
         */
        revertAppearance();
        props.onClose();
      }}
    >
      <form onsubmit={save} style="display:flex;flex-direction:column;gap:12px;min-height:0">
        {/* A MENU, not one long column. With several providers — each holding
            several keys — the stacked form was a wall of inputs whose extent
            the operator could not see; reaching the task list meant scrolling past
            every credential. One section at a time, named on the left.

            The menu is a VERTICAL rail rather than a wrapping row: a row of five
            labels re-wrapped to two lines on a narrow dialog and pushed the panel
            down every time the window changed, which moved the content the operator
            was already reading. A rail keeps its own width and the panel's top edge
            fixed. */}
        <div class="cfgbody">
          <nav class="cfgmenu" aria-label="settings sections">
            <For each={SECTIONS}>
              {(sec) => (
                <button
                  type="button"
                  class={"cfgmenu-item" + (section() === sec.key ? " on" : "")}
                  title={sec.hint}
                  aria-current={section() === sec.key ? "page" : undefined}
                  onclick={() => setSection(sec.key)}
                >
                  <span class="cfgmenu-label">{sec.label}</span>
                </button>
              )}
            </For>
          </nav>
          <div class="cfgpanel">
        <fieldset classList={{ hide: section() !== "providers" }}>
          <legend>providers</legend>
          {/* Index keyed by position — editing a row must not recreate its
              input DOM and steal focus. For (keyed by identity) recreated
              the edited row on every keystroke (new object → new identity
              → unmount/remount → focus lost). Index keeps the same input
              element for the same index, preserving focus and cursor. */}
          <Index each={providers()}>
            {(p, i) => (
              <div class="cfgrow">
                <input class="cfgname" placeholder="name" value={p().name} oninput={(e) => setProviders(providers().map((x, j) => (j === i ? { ...x, name: e.currentTarget.value } : x)))} />
                <input placeholder="https://…/v1" value={p().baseUrl} oninput={(e) => setProviders(providers().map((x, j) => (j === i ? { ...x, baseUrl: e.currentTarget.value } : x)))} />
                <input placeholder="default model" value={p().model} oninput={(e) => setProviders(providers().map((x, j) => (j === i ? { ...x, model: e.currentTarget.value } : x)))} />
                <button type="button" class="danger" title="remove provider" onclick={() => setProviders(providers().filter((_, j) => j !== i))}>✕</button>
                {/* #170: several keys per provider, rotated round-robin. A
                    rate-limited key is parked for a minute and the next one is
                    used, so an exhausted key no longer stalls every agent on it.
                    The first key is what anything reading the legacy `apiKey`
                    sees, which is why order is preserved. */}
                <div class="cfgkeys">
                  <For each={p().apiKeys}>
                    {(k, ki) => (
                      <div class="cfgkeyrow">
                        <input
                          placeholder={ki() === 0 ? "api key" : "api key (backup)"}
                          type="password"
                          value={k}
                          oninput={(e) =>
                            setProviders(
                              providers().map((x, j) =>
                                j === i
                                  ? { ...x, apiKeys: x.apiKeys.map((v, m) => (m === ki() ? e.currentTarget.value : v)) }
                                  : x,
                              ),
                            )
                          }
                        />
                        <Show when={p().apiKeys.length > 1}>
                          <button
                            type="button"
                            title="remove this key"
                            onclick={() =>
                              setProviders(
                                providers().map((x, j) =>
                                  j === i ? { ...x, apiKeys: x.apiKeys.filter((_, m) => m !== ki()) } : x,
                                ),
                              )
                            }
                          >−</button>
                        </Show>
                      </div>
                    )}
                  </For>
                  <button
                    type="button"
                    title="add another key for this provider — they are rotated round-robin, and a rate-limited key is skipped for a minute"
                    onclick={() =>
                      setProviders(providers().map((x, j) => (j === i ? { ...x, apiKeys: [...x.apiKeys, ""] } : x)))
                    }
                  >+ key</button>
                </div>
              </div>
            )}
          </Index>
          <button type="button" onclick={() => setProviders([...providers(), { name: "", baseUrl: "", apiKeys: [""], model: "" }])}>+ add custom</button>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            <span class="muted" style="font-size:11.5px">quick-add:</span>
            <For each={PROVIDER_PRESETS}>
              {(p) => (
                <button
                  type="button"
                  title={`fill a ${p.label} row — ${p.url}${p.model ? ` (model: ${p.model})` : ""}`}
                  onclick={() => {
                    // re-click = update the existing entry instead of duplicating
                    const rest = providers().filter((x) => x.name !== p.key);
                    setProviders([...rest, { name: p.key, baseUrl: p.url, apiKeys: [""], model: p.model }]);
                    if (!defaultProvider()) setDefaultProvider(p.key);
                  }}
                >+ {p.label}</button>
              )}
            </For>
          </div>
          <div><label style="display:flex;align-items:center;gap:6px;margin-top:6px" title="agents without an explicit provider use this one">
            default provider
            <select
              value={defaultProvider()}
              onchange={(e) => setDefaultProvider(e.currentTarget.value)}
            >
              <option value="">(none — first provider wins)</option>
              <For each={providerNames()}>
                {(n) => <option value={n}>{n}</option>}
              </For>
            </select>
          </label></div>
          <Show when={staleDefaultProvider()}>
            <div class="muted" style="font-size:11.5px;margin-top:4px">
              ⚠ configured default provider <code>{staleDefaultProvider()}</code> has no provider row here
              {staleDefaultProvider() === cfgDefaultProvider()
                ? " — the dropdown above cannot show it."
                : " — it was replaced by your selection."}{" "}
              Add a provider named <code>{staleDefaultProvider()}</code> or pick a default below; otherwise agents
              fall back to the first provider.
            </div>
          </Show>
        </fieldset>

        {/* 🎨 appearance. Moved out of the sidebar's 🎨 popover: a theme is a PREFERENCE, so
            it belongs beside the other settings, and an editor (palette rows, a background
            picker) needs the room a popover does not have. */}
        <fieldset classList={{ hide: section() !== "appearance" }}>
          <legend>appearance</legend>

          <div class="cfggrid">
            <label class="trow">follow the system
              <input
                type="checkbox"
                checked={themeAuto()}
                onchange={(e) => {
                  setThemeAuto(e.currentTarget.checked);
                }}
              />
            </label>
          </div>
          {/* The per-mode pickers appear ONLY when following the system: that is the one
              case where two choices exist. It used to be inverted — turning "follow the system"
              OFF showed two pickers (so you chose a dark AND a light theme while following
              neither) and turning it ON showed a read-only sentence instead of letting you pick.
              The sentence was also redundant with the picker below it. */}
          <Show when={themeAuto()}>
              <div class="cfggrid" style="margin-top:8px">
                <label class="trow">dark theme →
                  <select
                    class="w100"
                    value={sysDarkTheme()}
                    onchange={(e) => {
                      setSysDarkTheme(e.currentTarget.value);
                    }}
                  >
                    <For each={customThemes().filter((t) => t.mode === "dark").map((t) => ({ key: t.id, label: `${t.label} (custom)` })).concat(THEMES.filter((t) => t.mode === "dark"))}>
                      {(t) => <option value={t.key}>{t.label}</option>}
                    </For>
                  </select>
                </label>
                <label class="trow">light theme →
                  <select
                    class="w100"
                    value={sysLightTheme()}
                    onchange={(e) => {
                      setSysLightTheme(e.currentTarget.value);
                    }}
                  >
                    <For each={customThemes().filter((t) => t.mode === "light").map((t) => ({ key: t.id, label: `${t.label} (custom)` })).concat(THEMES.filter((t) => t.mode === "light"))}>
                      {(t) => <option value={t.key}>{t.label}</option>}
                    </For>
                  </select>
                </label>
              </div>
          </Show>

          <h4 class="cfgsub">themes</h4>
          {/* Grouped by LIGHT and DARK, as Misskey does — "which theme do I want" is almost
              always "which dark theme", so one mixed grid makes the eye filter the half it does
              not want. Custom themes appear in their own group first: they are what the operator
              just made, so they belong where the eye lands. */}
          <For each={[{ mode: "dark" as const, title: "dark themes" }, { mode: "light" as const, title: "light themes" }]}>
            {(group) => (
              /**
               * BOTH groups are always shown — including when "follow the system" is OFF.
               *
               * I once gated this to only the group matching the current appearance, reasoning that
               * with one slot a light card under a fixed dark theme was "a theme you cannot
               * meaningfully have". That was wrong, and the operator said so twice: "follow system
               * オフならライト、ダーク問わず選択できるべき".
               *
               * The premise was the bug. Picking a light theme while not following the system is
               * SUPPOSED to make the app light — the appearance control naming "dark" only
               * reflected the choice that was there before, not a constraint. Hiding the group
               * removed the only way to switch, so a light theme became unreachable unless the OS
               * happened to be light (which is what "やっぱりライトテーマしかでない" was reporting:
               * the surviving group was whichever one the gate happened to match).
               */
              <Show when={[...customThemes(), ...THEMES].some((t) => t.mode === group.mode)}>
                <div class="cfgsub" style="margin-bottom:var(--space-1)">{group.title}</div>
                <div class="themepick">
                  <For each={customThemes().filter((t) => t.mode === group.mode)}>
                    {(t) => (
                      <button
                        type="button"
                        class={"themecard" + (themeCardChosen(t.id) ? " on" : "")}
                        title={`${t.label} (custom)${t.backgroundImage ? " · with a background image" : ""}`}
                        aria-pressed={themeCardChosen(t.id)}
                        onclick={() => pickThemeCard(t.id, t.mode)}
                      >
                        <span class="themecard-preview"><ThemePreview palette={t.palette} backgroundImage={t.backgroundImage} surfaceAlpha={t.surfaceAlpha} backgroundDim={t.backgroundDim} /></span>
                        <span class="themecard-label">{t.label} ★</span>
                      </button>
                    )}
                  </For>
                  <For each={THEMES.filter((t) => t.mode === group.mode)}>
                    {(t) => (
                      <button
                        type="button"
                        class={"themecard" + (themeCardChosen(t.key) ? " on" : "")}
                        title={`${t.label} (${t.mode})`}
                        aria-pressed={themeCardChosen(t.key)}
                        onclick={() => pickThemeCard(t.key, t.mode)}
                      >
                        <span class="themecard-preview">
                          <ThemePreview palette={presetPalette(t.key)} />
                        </span>
                        <span class="themecard-label">{t.label}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            )}
          </For>

          <ThemeEditor
            themes={customThemes}
            activeId={fixedTheme()}
            paintedId={props.theme.paintedId()}
            onChange={(requested) => {
              /**
               * Persist FIRST, then adopt what was actually stored.
               *
               * The old order was `setCustomThemes(next)` then save, so a quota failure left
               * memory ahead of storage: the theme worked, looked saved, and vanished on the next
               * reload with only a transient toast. A background image is the only unbounded
               * field here, so an over-quota save retries without the images — losing a
               * wallpaper is much better than losing a palette — and only then reports failure,
               * in which case the on-screen state is rolled BACK so it matches what is stored.
               */
              let saved = saveCustomThemes(requested);
              let adopted = requested;
              if (!saved.ok) {
                const stripped = requested.map((t) =>
                  t.backgroundImage
                    ? {
                        ...t,
                        backgroundImage: undefined,
                        backgroundDim: undefined,
                        surfaceAlpha: undefined,
                        backgroundImageBytes: undefined,
                      }
                    : t,
                );
                const retry = saveCustomThemes(stripped);
                if (retry.ok) {
                  adopted = stripped;
                  flashHint("storage was full — saved without the background image(s)");
                } else {
                  // nothing could be stored: keep the screen in step with disk rather than
                  // showing a theme that a reload will silently drop
                  flashHint(retry.error ?? "could not save theme");
                  return;
                }
              }
              setCustomThemes(adopted);
              /**
               * Deleting a theme must not leave ANY of the three theme ids pointing at it.
               *
               * There are three places an id is stored — the fixed theme and the two per-mode
               * choices — and the old code only checked the first. With "follow the system" on,
               * the per-mode `<select>`s kept the dead id: `<select value=…>` with no matching
               * `<option>` silently displays the FIRST option while the state still held the dead
               * one, so the picker showed a theme that was not the one in use.
               *
               * Each falls back to a preset that still exists, and is written back to
               * localStorage so a reload agrees with the screen.
               */
              const alive = (id: string) =>
                adopted.some((t) => t.id === id) || THEMES.some((t) => t.key === id);
              if (!alive(fixedTheme())) {
                setFixedTheme("dark");
                localStorage.setItem("teapot.theme", "dark");
              }
              // the per-mode fallback keeps its APPEARANCE: a deleted dark theme must fall back
              // to a dark preset, not to whatever happens to be first
              if (!alive(sysDarkTheme())) {
                setSysDarkTheme("dark");
                localStorage.setItem("teapot.theme.dark", "dark");
              }
              if (!alive(sysLightTheme())) {
                setSysLightTheme("light");
                localStorage.setItem("teapot.theme.light", "light");
              }
            }}
            onPick={(id) => {
              /**
               * ADOPT the theme into whichever slot is PAINTED.
               *
               * `duplicatePreset()` and the editor's select both call this, and both say "this is
               * the theme I am now working on". Writing `teapot.theme` while "follow the system"
               * is on put it in a slot nothing reads, so the new copy was never painted — the
               * operator kept waiting for a visible result and then reported the whole flow as
               * "follow the system を入れてるときにテーマ複製したりするとやっぱりちょっと変な挙動に
               * なる".
               *
               * Following the system, the copy goes into the slot for ITS OWN appearance — the one
               * the OS is showing if they match, and the copy's own slot otherwise, so the operator
               * can still reach it by flipping the system appearance.
               */
              const mode =
                customThemes().find((t) => t.id === id)?.mode ??
                THEMES.find((t) => t.key === id)?.mode ??
                "dark";
              const target = slotForSelection(themeAuto(), mode);
              if (target.slot === "dark") setSysDarkTheme(id);
              else if (target.slot === "light") setSysLightTheme(id);
              else setFixedTheme(id);
            }}
          />
        </fieldset>

        <fieldset classList={{ hide: section() !== "runtime" }}>
          <legend>agent runtime</legend>
          <div class="cfgrow">
            <label style="flex:1">
              API password
              <input
                type="password"
                class="w100"
                placeholder={props.cfg.hasPassword ? "(unchanged — type to replace)" : "(none — loopback only)"}
                value={apiPassword()}
                oninput={(e) => {
                  setApiPassword(e.currentTarget.value);
                  setApiPasswordDirty(true);
                }}
              />
            </label>
            <span class="muted" style="font-size:11.5px;max-width:34ch">
              bearer token for /api. empty = loopback only.
            </span>
          </div>
          <div class="cfggrid">
            <NumberField label="progress interval (min)" value={intervalMin()} onValue={(v) => setIntervalMin(v)} hint="how often the harness asks for a progress report" />
            <NumberField label="progress min chars" value={minChars()} onValue={(v) => setMinChars(v)} hint="progress prompts wait for this much real output" />
            <label title="auto-compact threshold in k tokens. Leave EMPTY to derive per model (75% of its context window) — recommended, since models differ wildly in window size. Set only to force an absolute cap across all models.">
              compact budget (k tok)
              <input
                type="number"
                min="0"
                placeholder="(derive: 75% of window)"
                value={ctxBudgetK() ?? ""}
                oninput={(e) => setCtxBudgetK(e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
              />
            </label>
            <NumberField label="context window (k tok)" value={ctxWinK()} onValue={(v) => setCtxWinK(v)} hint="model's real window — 0/blank hides the % gauge" />
            <NumberField label="max spawn depth" value={maxDepth()} onValue={(v) => setMaxDepth(v)} hint="sub-agent nesting limit (0 = no spawning)" />
          </div>
          {/* #161: opt-in because it DISCARDS information early by design. On a large
              window that is pure loss; on a 32k–262k model waiting for overflow means
              one huge cut instead of many small ones. */}
          <label class="cfgtoggle" title="prune old tool output early (at 60% of the budget) instead of waiting for the window to fill. Meant for small-window models — on a large window it throws away context you had room for.">
            <input
              type="checkbox"
              checked={shortContext()}
              onchange={(e) => setShortContext(e.currentTarget.checked)}
            />
            short-context mode
            {/* no inline repeat of the tooltip: the label already carries the whole
                explanation, including the window range that makes it worth using */}
          </label>
        </fieldset>

        <fieldset classList={{ hide: section() !== "mcp" }}>
          <legend>MCP servers — external tools, shared by every agent</legend>
          {/* Tool discovery is the part that goes wrong, so `test` is a first-class
              control: it connects, lists, and reports the exact failure WITHOUT
              saving. Discovering on save would put the error on an agent's turn
              instead of on the row that caused it. */}
          <div class="muted" style="font-size:11.5px;margin-bottom:8px">
            each tool becomes <code class="mono">mcp__server__tool</code> for every agent.
            saving connects them; the status shown here is live.
          </div>
          <Show
            when={mcpServers().length > 0}
            fallback={
              <div class="muted" style="font-size:12.5px">
                no MCP servers. add one below — a remote url, or a local command for stdio.
              </div>
            }
          >
            <Index each={mcpServers()}>
              {(srv, i) => {
                const st = () => mcpStates()[srv().name];
                const upd = (patch: Record<string, any>) =>
                  setMcpServers(mcpServers().map((x, j) => (j === i ? { ...x, ...patch } : x)));
                return (
                  <div class="cfgcol mcpcard">
                    <div class="cfgrow">
                      <input
                        class="cfgname"
                        placeholder="name"
                        value={srv().name}
                        oninput={(e) => upd({ name: e.currentTarget.value })}
                        title="the name that appears inside mcp__<name>__ in tool names"
                      />
                      <input
                        placeholder="https://example.com/mcp  (or leave empty for a stdio command)"
                        value={srv().url ?? ""}
                        oninput={(e) => {
                          upd({ url: e.currentTarget.value });
                          /**
                           * Detect OAuth from the URL alone, WITHOUT saving.
                           *
                           * Asked as "OAuthのdetectはURLが入力されて数秒経ったら未保存でも検出してみると
                           * かがいいと思う (未保存のMCPサーバーに対してOAuthまでした状態を後から保存すると
                           * いうちょっとめんどくさいフローが発生しちゃうので要検討)".
                           *
                           * `/api/mcp/test` already answers `needsOAuth` for an arbitrary config — it
                           * never touches the saved list — so the probe costs nothing but a request,
                           * and it means the 🔑 button can appear before a save/reopen round trip.
                           *
                           * Debounced because this fires per keystroke and every call is a real
                           * network attempt. 700ms is long enough to finish typing a URL and short
                           * enough to feel automatic.
                           */
                          const mine = e.currentTarget.value.trim();
                          clearTimeout(urlProbeTimers[i]);
                          if (!/^https?:\/\//.test(mine)) return;
                          urlProbeTimers[i] = setTimeout(() => {
                            void probeOAuth(i, { ...mcpServers()[i], url: mine });
                          }, 700);
                        }}
                      />
                      <label style="display:flex;gap:3px;align-items:center;white-space:nowrap;color:var(--dim);font-size:11px">
                        <input
                          type="checkbox"
                          checked={srv().enabled !== false}
                          onchange={(e) => upd({ enabled: e.currentTarget.checked })}
                        />on
                      </label>
                      <button
                        type="button"
                        class="danger"
                        onclick={() => setMcpServers(mcpServers().filter((_, j) => j !== i))}
                      >✕</button>
                    </div>
                    <div class="cfgrow">
                      <select
                        value={srv().transport ?? "http"}
                        onchange={(e) => upd({ transport: e.currentTarget.value })}
                        title="streamable HTTP is the current spec; legacy SSE is the 2024-11-05 handshake; stdio spawns a local process"
                      >
                        <option value="http">streamable http</option>
                        <option value="sse">legacy http+sse</option>
                        <option value="stdio">stdio (local command)</option>
                      </select>
                      <Show when={srv().transport === "stdio"}>
                        <>
                          <input
                            placeholder="command (e.g. npx)"
                            value={srv().command ?? ""}
                            oninput={(e) => upd({ command: e.currentTarget.value })}
                          />
                          <input
                            placeholder="args, space separated"
                            value={(srv().args ?? []).join(" ")}
                            oninput={(e) =>
                              upd({ args: e.currentTarget.value.split(" ").filter(Boolean) })
                            }
                          />
                        </>
                      </Show>
                    </div>
                    {/* AUTH as a CHOICE, not a JSON textarea.
                        "headers as JSON" was the only way to authenticate, reported as
                        "正直わかりやすいとは言い難い": a bearer token meant knowing the header name,
                        the "Bearer " prefix and JSON quoting, to do the one thing every server
                        needs. The JSON box stays under "advanced" for anything unusual — the
                        same shape open-webui uses (a select whose sibling region swaps). */}
                    <div class="cfgrow">
                      <select
                        /**
                         * OAuth WINS over the header-derived kind: an authorized server has a
                         * token in the server-side store, so `headers` is empty and the
                         * derivation would say "none". Showing "no auth" while the 🔑 row says
                         * authorization is required is the reported contradiction.
                         */
                        value={oauthState(String(srv().name ?? "")) ? "oauth" : (mcpAuthKind()[i] ?? "none")}
                        onchange={(e) => {
                          const kind = e.currentTarget.value as "none" | "bearer" | "header" | "json";
                          setMcpAuthKind((m) => ({ ...m, [i]: kind }));
                          // switching away must actually REMOVE the header, or the old token keeps
                          // being sent and a 403 looks like a broken server
                          if (kind === "none") upd({ headers: undefined });
                          else if (kind === "bearer") {
                            const v = mcpAuthValue()[i] ?? "";
                            upd({ headers: v ? { Authorization: `Bearer ${v}` } : undefined });
                          } else if (kind === "header") {
                            const hname = mcpHeaderName()[i] ?? "";
                            const v = mcpAuthValue()[i] ?? "";
                            upd({ headers: hname && v ? { [hname]: v } : undefined });
                          }
                        }}
                        title="how this server authenticates"
                      >
                        {/**
                          * An OAuth server is NOT "no auth", and showing it that way hid the one
                          * fact that mattered: the dropdown said "no auth" while the panel's own
                          * 🔑 row said authorization was required. Reported as "MCPサーバーで
                          * OAuthが検出されたのに No auth がメニューから選択されてるのはどうなの?".
                          *
                          * The kind is derived from `headers`, and an OAuth grant lives in the
                          * server-side token store instead — so headers were empty and the
                          * derivation fell through to "none". The state is shown from `mcpOAuth`
                          * (keyed by NAME, which is the server's identity) and is not selectable by
                          * hand: it is a fact about the server, not a setting the operator picks.
                          */}
                        <Show when={oauthState(String(srv().name ?? ""))}>
                          {(st) => (
                            <option value="oauth" selected>
                              {st().authorized ? "OAuth — authorized" : "OAuth — authorization needed"}
                            </option>
                          )}
                        </Show>
                        <option value="none">no auth</option>
                        <option value="bearer">bearer token</option>
                        <option value="header">custom header</option>
                        <option value="json">headers as JSON (advanced)</option>
                      </select>
                      <Show when={mcpAuthKind()[i] === "bearer"}>
                        <input
                          type="password"
                          placeholder="paste the token"
                          value={mcpAuthValue()[i] ?? ""}
                          oninput={(e) => {
                            const v = e.currentTarget.value;
                            setMcpAuthValue((m) => ({ ...m, [i]: v }));
                            upd({ headers: v ? { Authorization: `Bearer ${v}` } : undefined });
                          }}
                          title="sent as Authorization: Bearer <token>"
                          style="flex:1"
                        />
                      </Show>
                      <Show when={mcpAuthKind()[i] === "header"}>
                        <input
                          placeholder="header name"
                          value={mcpHeaderName()[i] ?? ""}
                          oninput={(e) => {
                            const hname = e.currentTarget.value;
                            setMcpHeaderName((m) => ({ ...m, [i]: hname }));
                            const v = mcpAuthValue()[i] ?? "";
                            upd({ headers: hname && v ? { [hname]: v } : undefined });
                          }}
                          style="flex:0 1 150px"
                        />
                        <input
                          type="password"
                          placeholder="value"
                          value={mcpAuthValue()[i] ?? ""}
                          oninput={(e) => {
                            const v = e.currentTarget.value;
                            setMcpAuthValue((m) => ({ ...m, [i]: v }));
                            const hname = mcpHeaderName()[i] ?? "";
                            upd({ headers: hname && v ? { [hname]: v } : undefined });
                          }}
                          style="flex:1"
                        />
                      </Show>
                    </div>
                    <Show when={mcpAuthKind()[i] === "json"}>
                      <div class="cfgrow">
                        <textarea
                          class="mono"
                          rows={2}
                          placeholder={'{"Authorization": "Bearer …", "X-Team": "infra"}'}
                          value={mcpHeadersText()[i] ?? ""}
                          oninput={(e) => {
                            const t = e.currentTarget.value;
                            setMcpHeadersText((m) => ({ ...m, [i]: t }));
                            // parse eagerly so a typo is visible here, not as a 401 later
                            if (!t.trim()) upd({ headers: undefined });
                            else {
                              try {
                                const parsed = JSON.parse(t);
                                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                                  throw new Error("not an object");
                                }
                                upd({ headers: parsed });
                                setMcpHeaderErr((m) => ({ ...m, [i]: "" }));
                              } catch {
                                setMcpHeaderErr((m) => ({ ...m, [i]: "must be a JSON object — not applied" }));
                              }
                            }
                          }}
                          title="static headers for every request. Use the bearer option unless the server needs something unusual."
                          style="flex:1"
                        />
                      </div>
                    </Show>
                    <div class="cfgrow">
                      <button
                        type="button"
                        onclick={async () => {
                          const patch = mcpServers()[i];
                          if (!patch.name) {
                            setMcpStatus((m) => ({ ...m, [i]: { kind: "err", text: "give it a name first" } }));
                            return;
                          }
                          setMcpStatus((m) => ({ ...m, [i]: { kind: "testing", text: "connecting…" } }));
                          const r = (await api("/api/mcp/test", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify(patch),
                          }).catch(() => null)) as
                            | {
                                ok?: boolean;
                                tools?: { name: string; description?: string }[];
                                error?: string;
                                needsOAuth?: boolean;
                              }
                            | null;
                          setMcpStatus((m) => ({
                            ...m,
                            [i]: r?.ok
                              ? {
                                  kind: "ok",
                                  text: `${r.tools?.length ?? 0} tool${r.tools?.length === 1 ? "" : "s"}`,
                                  tools: r.tools ?? [],
                                }
                              : {
                                  kind: "err",
                                  text: r?.error ?? "no response",
                                  ...(r?.needsOAuth ? { needsOAuth: true } : {}),
                                },
                          }));
                          // A failed test may be a MISSING GRANT rather than a wrong url.
                          // The status endpoint reports what the connect attempt found, so
                          // "authorize" appears without the operator diagnosing a 401.
                          if (!r?.ok) await refreshMcpOAuth(patch.name);
                        }}
                        title="connect now and list the tools — nothing is saved"
                      >test</button>
                      {/* OAuth: offer "authorize" when the 401 challenge said this
                          server wants a grant. Without this the operator sees only
                          "error" and has to know the difference between a bad header
                          and a missing grant. */}
                      <Show when={oauthStateFrom(mcpOAuth(), String(srv().name ?? ""))?.required && !oauthStateFrom(mcpOAuth(), String(srv().name ?? ""))?.authorized}>
                        <button
                          type="button"
                          class="mcpauthorize"
                          onclick={() => void startMcpOAuth(i, srv())}
                          title="start the OAuth flow: a browser tab opens, and the tools appear when you finish"
                        >🔑 authorize</button>
                      </Show>
                      <Show when={oauthStateFrom(mcpOAuth(), String(srv().name ?? ""))?.authorized}>
                        {/*
                          Status only, not an action.
                          `disconnect` used to sit right here, in the row's control strip next to
                          `test` and `save` — one misclick from deleting the grant, and it read as
                          a peer of the harmless buttons ("しくじってクリックしそうなところに大々的に
                          置くのどうなの?"). The action moved into the server's expanded detail below,
                          which is the shape OpenWebUI uses for the same job: their connection row
                          shows state, and Delete lives inside the EDIT modal behind a confirm
                          dialog. `on/off` is the enable checkbox — a switch is state, a grant is a
                          credential, and putting them side by side made two different things look
                          like the same kind of toggle ("on/offのチェックボックスもあるし意味論が微妙").
                        */}
                        <span class="mcpstate connected" title="an OAuth access token is usable — disconnect it under the server's details">
                          🔑 authorized
                        </span>
                      </Show>
                      <Show when={st()}>
                        <span
                          class={"mcpstate " + (st()?.status ?? "")}
                          title={st()?.lastError ?? ""}
                        >
                          {st()?.status === "connected"
                            ? `● ${st()?.tools} tools`
                            : st()?.status === "error"
                              ? "● error"
                              : st()?.status === "disabled"
                                ? "● off"
                                : "● idle"}
                        </span>
                      </Show>
                    </div>
                    <Show when={mcpHeaderErr()[i]}>
                      <div class="muted" style="font-size:11px;color:var(--warn)">{mcpHeaderErr()[i]}</div>
                    </Show>
                    <Show when={mcpStatus()[i]}>
                      {(st2) => (
                        <div class={"mcpresult " + (st2().kind === "err" ? "err" : "ok")}>
                          <div class="mcpresult-head">
                            <b>{st2().text}</b>
                            <Show when={st2().needsOAuth}>
                              <span class="muted"> · needs a grant (🔑 authorize)</span>
                            </Show>
                          </div>
                          {/* The TOOL LIST, not just the count.
                              "4 tools" says nothing about whether this is the server you meant,
                              or whether the tool you wanted is among them — a wrong URL and a
                              working URL with the wrong scopes looked identical. The names
                              answer "did that do what I wanted"; the description says which one
                              to reach for. */}
                          {/* A `details` because a server can expose dozens of tools and the list
                              had no way to be put away — it stayed open under the row forever,
                              pushing every other server down the panel. Closed by default: the
                              count in the head already answers "did it connect". */}
                          <Show when={(st2().tools?.length ?? 0) > 0}>
                            <details class="mcptools-wrap">
                              <summary>show {st2().tools?.length} tool{st2().tools?.length === 1 ? "" : "s"}</summary>
                              <ul class="mcptools">
                                <For each={st2().tools ?? []}>
                                  {(t2) => (
                                    <li title={t2.description ?? ""}>
                                      <code class="mono">{t2.name}</code>
                                      <Show when={t2.description}>
                                        <span class="mcptool-desc">{t2.description}</span>
                                      </Show>
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </details>
                          </Show>
                          {/*
                            The destructive action lives HERE, under the server's details.

                            OpenWebUI's connection settings use the same shape: the list row shows
                            state, and Delete lives inside the EDIT dialog behind a confirm. Two
                            reasons it matters here beyond "less ugly": a grant is a CREDENTIAL, not
                            a setting, so it should not sit beside the on/off checkbox as if they
                            were the same kind of toggle; and disconnecting deletes the refresh
                            token, so recovering means a browser round trip — a misclick next to
                            `test` costs far more than a misclick on `test`.
                          */}
                          <Show when={oauthStateFrom(mcpOAuth(), String(srv().name ?? ""))?.authorized}>
                            <div class="mcpdanger">
                              <span class="muted">OAuth grant</span>
                              <button
                                type="button"
                                class="mcpdisconnect"
                                onclick={async () => {
                                  if (!confirm(`Disconnect ${srv().name}?\n\nThe stored OAuth grant is deleted and you will have to authorize again in a browser.`)) return;
                                  await api("/api/mcp/oauth/disconnect", {
                                    method: "POST",
                                    headers: { "content-type": "application/json" },
                                    body: JSON.stringify({ name: srv().name }),
                                  }).catch(() => {});
                                  await refreshMcpOAuth(srv().name);
                                  setMcpStatus((m) => ({ ...m, [i]: { kind: "ok", text: "disconnected" } }));
                                }}
                                title="forget the stored grant (the refresh token is deleted, so authorizing again needs a browser)"
                              >disconnect</button>
                            </div>
                          </Show>
                        </div>
                      )}
                    </Show>
                  </div>
                );
              }}
            </Index>
          </Show>
          <button
            type="button"
            onclick={() => setMcpServers([...mcpServers(), { name: "", url: "", transport: "http", enabled: true }])}
          >+ add MCP server</button>
        </fieldset>

        <fieldset classList={{ hide: section() !== "tasks" }}>
          <legend>scheduled tasks</legend>
          <Show when={tasks().length > 0}>
            <Index each={tasks()}>
              {(t, i) => (
                <div class="cfgcol">
                  <div class="cfgrow">
                    <input placeholder="id" value={t().id} oninput={(e) => setTasks(tasks().map((x, j) => (j === i ? { ...x, id: e.currentTarget.value } : x)))} />
                    <input placeholder="agent id" value={t().agent} oninput={(e) => setTasks(tasks().map((x, j) => (j === i ? { ...x, agent: e.currentTarget.value } : x)))} />
                    <input placeholder="every 30m / cron" value={t().schedule} oninput={(e) => setTasks(tasks().map((x, j) => (j === i ? { ...x, schedule: e.currentTarget.value } : x)))} />
                    <label style="display:flex;gap:3px;align-items:center;white-space:nowrap;color:var(--dim);font-size:11px">
                      <input type="checkbox" checked={!!t().forked} onchange={(e) => setTasks(tasks().map((x, j) => (j === i ? { ...x, forked: e.currentTarget.checked } : x)))} />fork
                    </label>
                    <button type="button" class="danger" onclick={() => setTasks(tasks().filter((_, j) => j !== i))}>✕</button>
                  </div>
                  <textarea rows={2} placeholder="prompt to send" value={t().prompt} oninput={(e) => setTasks(tasks().map((x, j) => (j === i ? { ...x, prompt: e.currentTarget.value } : x)))} />
                </div>
              )}
            </Index>
          </Show>
          <button type="button" onclick={() => setTasks([...tasks(), { id: "", agent: agentIds()[0] ?? "", schedule: "every 30m", prompt: "" }])}>+ add task</button>
        </fieldset>

        <fieldset classList={{ hide: section() !== "archive" }}>
          <legend>archived agents — restore, or delete for good</legend>
          {/* Archived entries keep their config and their session history. The
              distinction the UI must make obvious is which of the two buttons is
              irreversible, so DELETE states exactly what it destroys. */}
          <Show
            when={archivedTop().length > 0}
            fallback={
              <div class="muted" style="font-size:12.5px">
                nothing archived. 🗄 archive in the controls panel puts an agent away
                without losing its history.
              </div>
            }
          >
            <For each={archivedTop()}>
              {(a) => (
                <div class="cfgrow archrow">
                  <div class="archmain">
                    <b>{a.id}</b>
                    <span class="muted">
                      {a.sessions} session{a.sessions === 1 ? "" : "s"}
                      {(a.subs ?? 0) > 0
                        ? ` · +${a.subs} sub-agent${a.subs === 1 ? "" : "s"} (restored together)`
                        : ""}
                      {a.archivedAt ? ` · archived ${relTime(new Date(a.archivedAt).toISOString())}` : ""}
                    </span>
                    <span class="muted mono ellip" title={a.workspace}>{a.workspace}</span>
                  </div>
                  <button
                    type="button"
                    class="archrestore"
                    onclick={async () => {
                      const r = (await api(`/api/agents/${a.id}/restore`, { method: "POST" }).catch(
                        () => null,
                      )) as { live?: boolean; ids?: string[] } | null;
                      await refreshArchived();
                      // `onSaved` re-fetches the agent list, so the restored agent
                      // reappears in the controls panel without a reload
                      props.onSaved();
                      const extra = (r?.ids?.length ?? 1) - 1;
                      flashHint(
                        (r?.live === false
                          ? `restored ${a.id} — it could not be started (check its provider)`
                          : `restored ${a.id}`) +
                          (extra > 0 ? ` + ${extra} sub-agent${extra === 1 ? "" : "s"}` : ""),
                      );
                    }}
                    title="bring it back and start it again — its history was never touched"
                  >↩ restore</button>
                  <button
                    type="button"
                    class="danger"
                    onclick={async () => {
                      // The count comes from the server's own listing, so the
                      // warning names a real number rather than a guess.
                      if (
                        !confirm(
                          `PERMANENTLY DELETE ${a.id}?\n\n` +
                            `${a.sessions} session${a.sessions === 1 ? "" : "s"} of history will be ` +
                            "erased from disk along with the config entry. This cannot be undone " +
                            "— archiving was the reversible option.",
                        )
                      )
                        return;
                      await api(`/api/agents/${a.id}/purge`, { method: "DELETE" }).catch(() => {});
                      await refreshArchived();
                      props.onSaved();
                      flashHint(`deleted ${a.id} for good`);
                    }}
                    title="erase the config entry AND every session directory — irreversible"
                  >🗑 delete</button>
                </div>
              )}
            </For>
          </Show>
        </fieldset>

        <fieldset classList={{ hide: section() !== "agents" }}>
          <legend>agents (read-only — edit config file or use +)</legend>
          <For each={props.cfg.agents ?? []}>
            {(a: any) => (
              <div class="cfgrow">
                <b>{a.id}</b><span class="muted">{a.workspace}</span>
                <Show when={a.parent}><span class="muted">🧩 sub of @{a.parent}</span></Show>
              </div>
            )}
          </For>
        </fieldset>

        <fieldset classList={{ hide: section() !== "update" }}>
          <legend>live update</legend>
          <div class="cfgrow">
            <span class="muted">current version: {props.cfg.version ?? "unknown"}</span>
            <button
              type="button"
              onclick={async (e) => {
                try {
                  setErr("");
                  const btn = e.currentTarget as HTMLButtonElement;
                  btn.disabled = true;
                  btn.textContent = "updating…";
                  const res = await api("/api/update/restart", { method: "POST" });
                  if (!res.ok) throw new Error((await res.json()).error ?? "restart failed");
                  /**
                   * Wait for the NEW image to answer, then reload.
                   *
                   * Three signals are checked together because no single one is enough:
                   *
                   *  - it ANSWERED at all: during the old handover the port was dead, and
                   *    reloading into a dead port was #35;
                   *  - a DIFFERENT version: the usual case, and `__APP_VERSION__` was baked into
                   *    this bundle at build time, so a new server is genuinely distinguishable;
                   *  - a FRESH uptime: a restart that did not bump the version (a local build, a
                   *    code change shipped under the same number) would otherwise spin for the full
                   *    timeout even though the server was healthy. Before the request the uptime
                   *    was large; after it, it must be small — that is the true "it restarted".
                   *
                   * is against the value read just before the POST.
                   */
                  btn.textContent = "restarting…";
                  let beforeUptime: number | null = null;
                  let reloaded = false;
                  for (let i = 0; i < 120 && !reloaded; i++) {
                    await new Promise((r) => setTimeout(r, 1000));
                    try {
                      const v = (await api("/api/version")) as {
                        version?: string;
                        uptimeSeconds?: number;
                      };
                      if (!v.version) continue;
                      if (beforeUptime === null) beforeUptime = v.uptimeSeconds ?? null;
                      const restarted =
                        v.version !== __APP_VERSION__ ||
                        (typeof v.uptimeSeconds === "number" &&
                          beforeUptime !== null &&
                          v.uptimeSeconds < beforeUptime);
                      if (restarted) {
                        reloaded = true;
                        window.location.reload();
                      }
                    } catch {
                      /* the port is briefly down mid-update — keep polling */
                    }
                  }
                  if (!reloaded) throw new Error("restart timeout — new server did not come up");
                } catch (ex) {
                  setErr((ex as Error).message);
                } finally {
                  (e.currentTarget as HTMLButtonElement).disabled = false;
                  (e.currentTarget as HTMLButtonElement).textContent = "update & restart";
                }
              }}
              class="primarybtn"
            >
              update & restart
            </button>
            <span class="muted" style="margin-left:8px;font-size:12px">gracefully stops all agents, spawns new process, then reloads this page</span>
          </div>
        </fieldset>

        <fieldset classList={{ hide: section() !== "skills" }}>
          <legend>skills</legend>
          {/**
            * READ-ONLY: a skill is a file the agent writes while working, and editing it here would
            * be a second writer racing `save_skill`. The file stays the source of truth.
            */}
          <Show
            when={props.skills.length > 0}
            fallback={
              <div class="muted">
                {props.hasSelection
                  ? "this session has no skills yet — the agent saves them with save_skill once a procedure proves itself"
                  : "select a session to see the skills available to it"}
              </div>
            }
          >
            <div class="skilllist">
              <For each={props.skills}>
                {(s) => {
                  /**
                   * A skill row EXPANDS to show the playbook.
                   *
                   * The list alone answered "what is there" but not "what does it say", and the
                   * body is the whole point of a skill — "スキルの内容を読みたい". Fetched on
                   * demand rather than included in the list response, because a body runs to tens
                   * of KB and the / palette uses the same list.
                   */
                  const [open, setOpen] = createSignal(false);
                  const [body, setBody] = createSignal<string | null>(null);
                  const [err, setErr] = createSignal("");
                  const toggle = async () => {
                    if (open()) return setOpen(false);
                    setOpen(true);
                    if (body() !== null || !props.agentId) return;
                    try {
                      const r = await api(
                        `/api/agents/${props.agentId}/skills/${encodeURIComponent(s.name)}`,
                      );
                      setBody(String(r.text ?? ""));
                    } catch (ex) {
                      setErr((ex as Error).message);
                    }
                  };
                  return (
                    <div classList={{ skillrow: true, open: open() }}>
                      <button type="button" class="skillhead" onclick={toggle} title="show the playbook">
                        <span class="skillcaret">{open() ? "▾" : "▸"}</span>
                        <b class="mono">{s.name}</b>
                        <span class="muted">{s.description}</span>
                      </button>
                      <Show when={open()}>
                        <Show
                          when={body() !== null}
                          fallback={<div class="muted skillbody">{err() || "loading…"}</div>}
                        >
                          {/* RENDERED markdown, not a <pre> of the raw file: a SKILL.md is
                              prose + headings + fenced code, and showing its own `##` markers was
                              half of "適切な折り返しと本文のシンタックスハイライトも実装して".
                              `renderMarkdown` is the same renderer the timeline uses, so a skill
                              reads exactly like a message. */}
                          {/* cached: a skill body is up to hundreds of KB and re-rendering it on
                              every parent update would be wasteful, exactly as for timeline rows */}
                          <div class="skillbody" innerHTML={renderMarkdownCached(String(body() ?? ""))} />
                        </Show>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </fieldset>

        <fieldset classList={{ hide: section() !== "help" }}>
          <legend>help</legend>
          {/* The cheat-sheet and the toggle explanations live here rather than in the main UI:
              they are read once, then only get in the way. */}
          <div class="helpsec">
            <h4 class="cfgsub">this host</h4>
            {/* Which of the OPTIONAL native tools this machine actually has. A feature that
                silently does nothing when a binary is missing is indistinguishable from a broken
                one, and this is the only place the answer is visible. */}
            <div class="featgrid">
              <div class="featrow">
                <b>image downscaling</b>
                <span class="muted">
                  {props.features
                    ? props.features.imageResize.available
                      ? `on — ${props.features.imageResize.tool}, long edge ≤ ${props.features.imageResize.maxEdge}px`
                      : "off — no ffmpeg / ImageMagick found; uploads are served as-is"
                    : "checking…"}
                </span>
              </div>
              <div class="featrow">
                <b>terminal pty</b>
                <span class="muted">
                  {props.features
                    ? props.features.pty.available
                      ? `on — ${props.features.pty.provider}`
                      : "off — no pty provider; terminals run on plain pipes (no resize)"
                    : "checking…"}
                </span>
              </div>
            </div>
          </div>
          <div class="helpsec">
            <h4 class="cfgsub">keyboard</h4>
            <div class="helprow"><kbd>enter</kbd><span>send (shift+enter for a newline)</span></div>
            <div class="helprow"><span class="kbdgroup"><kbd>↑</kbd><kbd>↓</kbd></span><span>move between sessions</span></div>
            <div class="helprow"><kbd>/</kbd><span>command palette — commands and focus</span></div>
            <div class="helprow"><kbd>t</kbd><span>open the terminal panel</span></div>
            <div class="helprow"><kbd>d</kbd><span>toggle the details panel</span></div>
            <div class="helprow"><kbd>esc</kbd><span>interrupt the running turn</span></div>
          </div>

          <div class="helpsec">
            <h4 class="cfgsub">what the toggles do</h4>
            <div class="helprow">
              <b>auto-continue</b>
              <span>
                fires after a round only when all hold: the toggle is on, a goal is set and its
                status is <code>active</code>, and the round ended cleanly (not an error, not
                stopped). It stops when the goal is marked done, or when you press ■ stop.
                Sending any prompt starts an idle agent regardless.
              </span>
            </div>
            <div class="helprow">
              <b>auto-compact</b>
              <span>
                when the live context passes the budget shown under 📊 runtime, older turns are
                summarized into notes and the recent stretch is kept verbatim, so work continues
                without losing the thread. Off means you compact by hand (<code>/compact</code>).
              </span>
            </div>
            <div class="helprow">
              <b>messages while it works</b>
              <span>
                anything you send queues up and is handed to the model at its next turn
                boundary — the timeline shows it as "pending (queued)…" until then. Withdraw it
                with ✕ cancel while it is still queued.
              </span>
            </div>
            <div class="helprow">
              <b>👻 ghost sessions</b>
              <span>
                a session whose workspace directory no longer exists on disk. The session log is
                intact — recreate the directory and it stops being a ghost.
              </span>
            </div>
          </div>
        </fieldset>
          </div>
        </div>

        {/* The footer sits OUTSIDE the two columns and outside the scroll area, so
            SAVE is always reachable no matter how long the visible section is —
            previously it scrolled away with the form and the operator had to reach
            the bottom to commit anything. */}
        <div class="cfgfoot">
          <Show when={err()}><span style="color:var(--err);font-size:13px">{err()}</span></Show>
          {/**
            * The button reports its own outcome, like the model panel's apply.
            *
            * Reported: "設定のsaveが適用されたのかわかりにくいのでmodelパネルのapplyと同じ感じに".
            * The label is fixed-width and cannot wrap (see `.cfgsave`), so changing it cannot
            * resize the footer — "✓ applied" once grew this button vertically.
            */}
          <button
            type="submit"
            classList={{
              cfgsave: true,
              saved: saveState() === "saved",
              error: saveState() === "error",
            }}
            disabled={saveState() === "saving"}
          >
            {saveState() === "saving"
              ? "saving…"
              : saveState() === "saved"
                ? "✓ saved"
                : saveState() === "error"
                  ? "✕ failed"
                  : "save settings"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
