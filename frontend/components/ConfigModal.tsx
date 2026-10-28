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
  themeBeingEdited,
  type CustomTheme,
  type ThemePalette,
} from "../lib/theme-store";
import { THEMES } from "../lib/themes-presets";

declare const __APP_VERSION__: string;

export function ThemeEditor(props: {
  themes: () => CustomTheme[];
  paintedId: string;
  onChange: (next: CustomTheme[]) => void;
  onPick: (id: string) => void;
}) {
  /**
   * The theme being edited is the one PAINTED on screen — `paintedId`, not `activeId`.
   *
   * `activeId` is the fixed fallback, and with "follow the system" on it is simply not the theme you are
   * looking at; the painted one is. The background-image picker renders this theme, so reading anything but
   * the painted theme shows a wallpaper that is not on screen. See `themeBeingEdited` for why the pinned
   * `editingId` is only a fallback.
   */
  const [editingId, setEditingId] = createSignal<string>(
    props.themes().some((t) => t.id === props.paintedId) ? props.paintedId : (props.themes()[0]?.id ?? ""),
  );
  const editing = () => themeBeingEdited(props.themes(), props.paintedId, editingId());
  const [hexDraft, setHexDraft] = createSignal<Record<string, string>>({});
  let filePick: HTMLInputElement | undefined;

  const patch = (fn: (t: CustomTheme) => CustomTheme) => {
    const id = editing()?.id;
    if (!id) return;
    const next = props.themes().map((t) => (t.id === id ? fn(t) : t));
    props.onChange(next);
  };
  const setColour = (key: keyof ThemePalette, raw: string) => {
    const norm = normalizeColour(raw);
    if (!norm) return;
    patch((t) => ({ ...t, palette: { ...t.palette, [key]: norm } }));
  };

  const duplicatePreset = () => {
    const activeCustom = props.themes().find((t) => t.id === props.paintedId);
    const activePreset = THEMES.find((t) => t.key === props.paintedId);
    const base = activeCustom ?? activePreset ?? THEMES[0]!;
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
    props.onPick(id);
  };

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
        {}
      </div>

      <Show
        when={editing() && props.themes().some((t) => t.id === props.paintedId) ? editing() : null}
        fallback={
          <div class="muted" style="margin:6px 0">
            {props.themes().length === 0
              ? <>no custom themes yet — press <b>＋ duplicate current</b> to start from the palette you are using.</>
              : <>the editor shows when one of your themes is the one on screen — pick one under "your themes" above (or press <b>＋ duplicate current</b>).</>}
          </div>
        }
      >
        {(t) => (
          <>
            <div class="cfggrid" style="margin-top:8px">
              {}
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
                      value={hexDraft()[k.key] ?? editing()!.palette[k.key]}
                      spellcheck={false}
                      oninput={(e) => {
                        const raw = e.currentTarget.value;
                        setHexDraft((d) => ({ ...d, [k.key]: raw }));
                        setColour(k.key, raw);
                      }}
                      onblur={() =>
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
              {}
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
                  {}
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
                  e.stopPropagation();
                  importFile(e.currentTarget.files?.[0]);
                  e.currentTarget.value = "";
                }}
              />
              <Show when={editing()!.backgroundImage}>
                <div class="bgpreview">
                  {}
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
                    {}
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
  announcedOAuth: Set<string>;
  skills: { name: string; description: string }[];
  hasSelection: boolean;
  agentId: string | null;
  features: {
    imageResize: { available: boolean; tool: string | null; maxEdge: number; found: { name: string; present: boolean }[] };
    pty: { available: boolean; provider: string | null };
  } | null;
  theme: {
    themes: () => CustomTheme[];
    activeId: () => string;
    paintedId: () => string;
    auto: () => boolean;
    setAuto: (v: boolean) => void;
    dark: () => string;
    setDark: (v: string) => void;
    light: () => string;
    setLight: (v: string) => void;
    setThemes: (v: CustomTheme[]) => void;
    setActive: (v: string) => void;
    commitAppearance: (v: { auto: boolean; dark: string; light: string; fixed: string }) => void;
    preview: (id: string | null) => void;
  };
}) {
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
  const cfgDefaultProvider = () => props.cfg.defaultProvider ?? "";
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
  const [ctxBudgetK, setCtxBudgetK] = createSignal<number | null>(
    props.cfg.contextTokenBudget != null ? Math.round(props.cfg.contextTokenBudget / 1000) : null,
  );
  const [ctxWinK, setCtxWinK] = createSignal(props.cfg.contextWindowTokens ? Math.round(props.cfg.contextWindowTokens / 1000) : 0);
  const [maxDepth, setMaxDepth] = createSignal(props.cfg.maxSpawnDepth ?? 3);
  const [shortContext, setShortContext] = createSignal(Boolean(props.cfg.shortContext));
  const [apiPassword, setApiPassword] = createSignal("");
  const [apiPasswordDirty, setApiPasswordDirty] = createSignal(false);
  const [tasks, setTasks] = createSignal<any[]>((props.cfg.tasks ?? []).map((t: any) => ({ ...t })));
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
        tools?: { name: string; description?: string }[];
        needsOAuth?: boolean;
      }
    >
  >({});
  const urlProbeTimers: Record<number, ReturnType<typeof setTimeout> | undefined> = {};
  const probeOAuth = async (i: number, cfg: Record<string, unknown>) => {
    if (!mcpServers()[i]) return; 
    const r = (await api("/api/mcp/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cfg),
    }).catch(() => null)) as { ok?: boolean; error?: string; needsOAuth?: boolean; tools?: unknown[] } | null;
    if (!mcpServers()[i]) return;
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
  const [mcpStates, setMcpStates] = createSignal<Record<string, any>>({});
  const [mcpOAuth, setMcpOAuth] = createSignal<
    Record<string, { required?: boolean; authorized?: boolean; hasRefreshToken?: boolean; flow?: { phase: string; url?: string } }>
  >({});
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

    const r = (await api(`/api/mcp/oauth/status?name=${encodeURIComponent(key)}`).catch(
      () => null,
    )) as any;
    if (r && !r.error) setMcpOAuth((m) => ({ ...m, [key]: r }));
  };
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
    window.open(r.url, "_blank", "noopener");
    setMcpStatus((m) => ({
      ...m,
      [i]: { kind: "testing", text: "waiting for you to finish in the browser…" },
    }));
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 1000));
      const st = (await api(`/api/mcp/oauth/status?name=${encodeURIComponent(srv.name)}`).catch(
        () => null,
      )) as any;
      if (!st || st.error) continue;
      setMcpOAuth((m) => ({ ...m, [srv.name]: st }));
      if (st.authorized) {
        setMcpStatus((m) => ({
          ...m,
          [i]: { kind: "ok", text: "authorized — the tools are available now" },
        }));
        await refreshMcpStates();
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
    mcpServers().forEach((m, i) => {
      if (m.name) void refreshMcpOAuth(m.name);
    });
  });
  const [err, setErr] = createSignal("");

  type Section = "providers" | "runtime" | "appearance" | "mcp" | "tasks" | "archive" | "agents" | "update" | "skills" | "help";
  const [section, setSection] = createSignal<Section>("providers");
  const pickThemeCard = (id: string, mode: "dark" | "light") => {
    const { slot } = slotForSelection(props.theme.auto(), mode);
    if (slot === "dark") setSysDarkTheme(id);
    else if (slot === "light") setSysLightTheme(id);
    else setFixedTheme(id);
  };
  const themeCardChosen = (id: string) =>
    props.theme.auto()
      ? id === props.theme.dark() || id === props.theme.light()
      : id === props.theme.activeId();
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
  const archivedTop = () => archived().filter((a) => !a.parent);
  createEffect(() => {
    if (section() === "archive") void refreshArchived();
  });
  const SECTIONS: { key: Section; label: string; hint: string }[] = [
    { key: "providers", label: "🧦 providers", hint: "endpoints, API keys, default models" },
    { key: "appearance", label: "🎨 appearance", hint: "theme, custom palettes, background image" },
    { key: "runtime", label: "⚙️ runtime", hint: "context budget, retries, spawn depth" },
    { key: "tasks", label: "⏰ scheduled tasks", hint: "cron prompts run against an agent" },
    { key: "mcp", label: "🔌 MCP servers", hint: "external tool servers exposed to every agent" },
    { key: "archive", label: "🗄 archive", hint: "agents you put away — restore or delete for good" },
    { key: "agents", label: "👥 agents", hint: "what exists (read-only)" },
    { key: "update", label: "⬆️ live update", hint: "restart onto a newer build" },
    { key: "skills", label: "🧠 skills", hint: "reusable playbooks available to the selected session" },
    { key: "help", label: "❔️ help", hint: "keyboard shortcuts and what each toggle does" },
  ];

  const agentIds = () => (props.cfg.agents ?? []).map((a: any) => a.id);

  const customThemes = () => props.theme.themes();
  const fixedTheme = () => props.theme.activeId();
  const storedAppearance = {
    auto: localStorage.getItem("teapot.theme.auto") === "1",
    dark: localStorage.getItem("teapot.theme.dark") ?? "dark",
    light: localStorage.getItem("teapot.theme.light") ?? "light",
    fixed: localStorage.getItem("teapot.theme") ?? "dark",
  };
  const draft = createSignal(storedAppearance);
  const draftOf = draft[0];
  const applyDraft = (next: Partial<ReturnType<typeof draftOf>>) => {
    const merged = { ...draftOf(), ...next };
    draft[1](merged);
    props.theme.setAuto(merged.auto);
    props.theme.setDark(merged.dark);
    props.theme.setLight(merged.light);
    props.theme.setActive(merged.fixed);
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

  const revertAppearance = () => {
    const s = storedAppearance;
    props.theme.setAuto(s.auto);
    props.theme.setDark(s.dark);
    props.theme.setLight(s.light);
    props.theme.setActive(s.fixed);
    props.theme.preview(null);
  };

  const presetPalette = (key: string): ThemePalette => PRESET_PALETTES[key] ?? DEFAULT_PALETTE;

  const saveProviders = (): Record<string, any> | null => {
    const out: Record<string, any> = {};
    for (const p of providers()) {
      if (!p.name.trim()) { setErr("provider name is required"); return null; }
      if (p.baseUrl && !/^https?:\/\//.test(p.baseUrl)) { setErr(`provider ${p.name}: baseUrl must start with http(s)://`); return null; }
      const keys = p.apiKeys.map((k) => k.trim()).filter(Boolean);
      out[p.name.trim()] = {
        baseUrl: p.baseUrl,
        ...(keys.length ? { apiKeys: keys, apiKey: keys[0] } : {}),
        ...(p.model ? { model: p.model } : {}),
      };
    }
    return out;
  };

  const [saveState, setSaveState] = createSignal<"idle" | "saving" | "saved" | "error">("idle");

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
    const cleanMcp: any[] = [];
    const seenMcp = new Set<string>();
    for (const m of mcpServers()) {
      const name = String(m.name ?? "").trim();
      const url = String(m.url ?? "").trim();
      const transport = m.transport ?? "http";
      const command = String(m.command ?? "").trim();
      if (!name && !url && !command) continue; 
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
        /**
         * The save path rebuilds each server from a whitelist, so a field not listed here is silently
         * dropped — which is how the description box "existed" but never reached the config, and
         * therefore never reached the model's prompt.
         */
        ...(String(m.description ?? "").trim() ? { description: String(m.description).trim() } : {}),
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
      await refreshMcpStates();
      await Promise.all(
        cleanMcp.map((m, i) => (m.name ? refreshMcpOAuth(m.name) : Promise.resolve())),
      );
      setTimeout(() => {
        void refreshMcpStates();
        cleanMcp.forEach((m, i) => {
          if (m.name) void refreshMcpOAuth(m.name);
        });
      }, 1200);
      props.onSaved();
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
        for (const m of newlyNeeding) props.announcedOAuth.add(String(m.name ?? ""));
        const names = newlyNeeding.map((m) => String(m.name ?? "").trim()).filter(Boolean);
        flashHint(
          `${names.join(", ") || "a saved MCP server"} needs authorization — 🔑 authorize in MCP servers`,
        );
      }
      props.theme.commitAppearance(draftOf());
      props.theme.preview(null); 
      setSaveState("saved");
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
        revertAppearance();
        props.onClose();
      }}
    >
      <form onsubmit={save} style="display:flex;flex-direction:column;gap:12px;min-height:0">
        {}
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
          {}
          <Index each={providers()}>
            {(p, i) => (
              <div class="cfgrow">
                <input class="cfgname" placeholder="name" value={p().name} oninput={(e) => setProviders(providers().map((x, j) => (j === i ? { ...x, name: e.currentTarget.value } : x)))} />
                <input placeholder="https://…/v1" value={p().baseUrl} oninput={(e) => setProviders(providers().map((x, j) => (j === i ? { ...x, baseUrl: e.currentTarget.value } : x)))} />
                <input placeholder="default model" value={p().model} oninput={(e) => setProviders(providers().map((x, j) => (j === i ? { ...x, model: e.currentTarget.value } : x)))} />
                <button type="button" class="danger" title="remove provider" onclick={() => setProviders(providers().filter((_, j) => j !== i))}>✕</button>
                {}
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

        {}
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
          {}
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
          {}
          <For each={[{ mode: "dark" as const, title: "dark themes" }, { mode: "light" as const, title: "light themes" }]}>
            {(group) => (
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
            paintedId={props.theme.paintedId()}
            onChange={(requested) => {
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
                  flashHint(retry.error ?? "could not save theme");
                  return;
                }
              }
              setCustomThemes(adopted);
              const alive = (id: string) =>
                adopted.some((t) => t.id === id) || THEMES.some((t) => t.key === id);
              if (!alive(fixedTheme())) {
                setFixedTheme("dark");
                localStorage.setItem("teapot.theme", "dark");
              }
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
          {}
          <label class="cfgtoggle" title="prune old tool output early (at 60% of the budget) instead of waiting for the window to fill. Meant for small-window models — on a large window it throws away context you had room for.">
            <input
              type="checkbox"
              checked={shortContext()}
              onchange={(e) => setShortContext(e.currentTarget.checked)}
            />
            short-context mode
            {}
          </label>
        </fieldset>

        <fieldset classList={{ hide: section() !== "mcp" }}>
          <legend>MCP servers — external tools, shared by every agent</legend>
          {}
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
                      <input
                        placeholder="what this server is for — e.g. reverse engineering: decompile, disassemble"
                        value={srv().description ?? ""}
                        oninput={(e) => upd({ description: e.currentTarget.value })}
                        title={
                          "shown to the model when the MCP catalog is too large to send, so it can search " +
                          "for the right tool instead of guessing keywords"
                        }
                      />
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
                    {}
                    <div class="cfgrow">
                      <select
                        value={oauthState(String(srv().name ?? "")) ? "oauth" : (mcpAuthKind()[i] ?? "none")}
                        onchange={(e) => {
                          const kind = e.currentTarget.value as "none" | "bearer" | "header" | "json";
                          setMcpAuthKind((m) => ({ ...m, [i]: kind }));
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
                        {}
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
                          if (!r?.ok) await refreshMcpOAuth(patch.name);
                        }}
                        title="connect now and list the tools — nothing is saved"
                      >test</button>
                      {}
                      <Show when={oauthStateFrom(mcpOAuth(), String(srv().name ?? ""))?.required && !oauthStateFrom(mcpOAuth(), String(srv().name ?? ""))?.authorized}>
                        <button
                          type="button"
                          class="mcpauthorize"
                          onclick={() => void startMcpOAuth(i, srv())}
                          title="start the OAuth flow: a browser tab opens, and the tools appear when you finish"
                        >🔑 authorize</button>
                      </Show>
                      <Show when={oauthStateFrom(mcpOAuth(), String(srv().name ?? ""))?.authorized}>
                        {}
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
                          {}
                          {}
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
                          {}
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
          {}
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
          {}
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
                          {}
                          {}
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
          {}
          <div class="helpsec">
            <h4 class="cfgsub">this host</h4>
            {}
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

        {}
        <div class="cfgfoot">
          <Show when={err()}><span style="color:var(--err);font-size:13px">{err()}</span></Show>
          {}
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
