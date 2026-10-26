import { createSignal, onMount, onCleanup, For, Show, createMemo, createEffect, untrack, Index } from "solid-js";
import { renderMarkdown } from "./md";
import { fmtDur } from "./lib/format";
import {
  applyDelta,
  clearLive,
  clearThinkClockIfDone,
  isTurnBoundary,
  isOwnLiveWork,
  pruneDeadLiveBuffers,
  reconcileLiveBuffer,
} from "./lib/live-buffer";
import { buildTimelineWithCount, type TimelineEvent, type PendingEchoLike } from "./lib/timeline";
import { goalLine, isPlaceholderDetail } from "./lib/goal-timeline";
import { Card } from "./components/card";
import { slotForSelection, paintedIdFor } from "./lib/theme-slots";
import { outputLang } from "./lib/tool-output-lang";
import { mergeThemes } from "./lib/theme-merge";
import { previewLayers, veilColour, backgroundImageValue } from "./lib/theme-preview";
import { BG_WIDTHS, bgSrc, bgSrcSet } from "./lib/bg-srcset";
import { descendantsOf, shouldShowCollapseCaret, subAgentDisplayName } from "./lib/sidebar-tree";
import { copyText } from "./lib/clipboard";
import { groupedWith, type RowLike } from "./lib/row-grouping";
import { answeredQuestionIdsOf, type QuestionEvent } from "./lib/question-answered";
import { reconcilePending, type PendingEcho } from "./lib/pending-echo";
import { linkableSessionId, resolveTimelineSession } from "./lib/session-index";
import { rememberTextareaHeight, storedTextareaHeight, trackTextareaHeight } from "./lib/textarea-size";
import { deltaBelongsToTimeline, eventBelongsOnTimeline, timelineIsLive } from "./lib/session-scope";
import { retintTerminal, themeColors } from "./lib/terminal-theme";
import { shellOutcome, shellHint, outcomeMarker } from "./lib/shell-outcome";
import {
  treeRowsOf,
  sidebarRowsOf,
  workspaceOf as workspaceOfPure,
  chatGroupKeyOf,
  wsChatCountsOf,
} from "./lib/sidebar-tree";
import { effectiveProviderOf, mayResyncProvider, modelOnProviderSwitch, modelPlaceholderFor } from "./lib/model-selection";
import { composerValueChanged, shouldWriteComposerValue } from "./lib/composer-ime";
import {
  atTail,
  AT_TAIL_PX,
  classifyScroll,
  distanceToTail,
  gapToTail,
  nextFollowing,
  shouldPin,
  shouldShowJumpToPresent,
  type ScrollCause,
  type TailSample,
} from "./lib/scroll-policy";
import { composerHeight } from "./lib/composer-size";
import { agentLabel, agentLabelWithId } from "./lib/agent-label";
import { queuedBadgeCount } from "./lib/queued-count";
import {
  applyCustomTheme,
  loadCustomThemes,
  loadCustomThemesFromServer,
  newThemeId,
  normalizeColour,
  saveCustomThemes,
  DEFAULT_PALETTE,
  MAX_BACKGROUND_BYTES,
  PALETTE_KEYS,
  PRESET_PALETTES,
  resolveActiveTheme,
  type CustomTheme,
  type ThemePalette,
} from "./lib/theme-store";

const mdCache = new Map<string, string>();
function renderMarkdownCached(src: string): string {
  const hit = mdCache.get(src);
  if (hit !== undefined) return hit;
  const html = renderMarkdown(src);
  mdCache.set(src, html);
  if (mdCache.size > 500) mdCache.delete(mdCache.keys().next().value!);
  return html;
}
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { clampPaneIndex, indexAfterAppend, paneIndexAfterClose, rightPaneSeed } from "./lib/term-tabs";
import { pickAfterArchive } from "./lib/archive-target";
import { shouldSendOnKey, shouldRestoreAfterSend } from "./lib/composer-keys";
import { IconBtn, CopyBtn, Modal } from "./components/chrome";
import { AnsiText, BashElapsed, HighlightedCode, ThinkingTimer } from "./components/code";
import { hasAnsi, stripAnsi } from "./lib/ansi";
import { THEMES, type ThemeMeta } from "./lib/themes-presets";
import { PROVIDER_PRESETS } from "./lib/provider-presets";
import { ficon, fileUiFor, mediaKindOf, type FileUiState, type TreeNode } from "./lib/file-tree";
import { relTime } from "./lib/format";
import { api } from "./lib/api";
import { CodePreview, NumberField, ThemePreview, TodoEditor } from "./components/settings-parts";
import { FreeTextAnswer, MessageRow, SwitchContent, ToolRow } from "./components/rows";
import { ConfigModal } from "./components/ConfigModal";
import { FilesPanel } from "./components/FilesPanel";
import {
  AUTHORS,
  HARNESS_AUTH,
  authorOf,
  fmtK,
  fmtTs,
  oneLine,
  rawOf,
  type Ev,
} from "./lib/timeline-row";

declare const __APP_VERSION__: string;

const REASONING_EFFORT_OPTIONS = ["minimal", "low", "medium", "high"] as const;

const NARROW_PX = 1100;

interface Agent {
  id: string; status: string; statusReason: string; workspace: string;
  live?: boolean;
  session: string; branch: string; goal: { status: string; text: string; verify?: string; audit?: { verdict: "approved" | "changes-required"; feedback: string; at: string } };
  sessionTitle?: string;
  workspaceMissing?: boolean;
  latestProgress: any; stats: any; model: string; provider?: string;
  reasoningEffort?: string; effortSupported?: boolean; effortOptions?: string[];
  pendingPrompts?: number;
  pendingPromptIds?: string[];
  pendingPromptQueue?: { id: string; text: string; source?: string; at?: number; images?: { url: string; name?: string }[] }[];
  todo?: string;
  parent?: string;
  autoContinue?: boolean;
  autoCompact?: boolean;
  ctx?: { usedTokens: number; compactAt: number; window: number; compactAtIsManual?: boolean; compacting?: string };
}

const [flash, setFlash] = createSignal("");
let flashTimer: ReturnType<typeof setTimeout> | undefined;
const flashHint = (msg: string) => {
  setFlash(msg);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setFlash(""), 3200);
};

let imeInProgress = false;

const FEED_TYPES = new Set([
  "user", "message", "prompt", "tool_call", "tool_result", "progress",
  "state", "error", "fork", "goal", "todo", "question", "decision", "compaction",
  "audit_step",
  "system_note",
]);
const NOTE_FEED_TYPES = new Set(["system_note"]);

const RENDERED_TYPES = new Set([
  "user", "message", "prompt", "tool_call", "tool_result", "progress",
  "error", "fork", "goal", "todo", "question", "decision", "compaction", "audit_step",
]);

const RENDERED_NOTE_EVENTS = new Set([
  "runaway-detected",
  "error-retry",
  "background-exit",
  "context-compacted",
  "context-compaction-started",
]);

const hashTok = location.hash.match(/[#&]token=([^&]+)/);
if (hashTok) {
  localStorage.setItem("teapot.token", decodeURIComponent(hashTok[1]));
  history.replaceState(null, "", location.pathname + location.search);
}
const wsTokenQuery = () => {
  const t = localStorage.getItem("teapot.token");
  return t ? `?token=${encodeURIComponent(t)}` : "";
};

export default function App() {
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [timelineId, setTimelineId] = createSignal<string>("");
  const [masterSessionIndex, setMasterSessionIndex] = createSignal<Map<string, string>>(new Map());
  const [sessionsByAgent, setSessionsByAgent] = createSignal<Map<string, string[]>>(new Map());
  const [sessionTitles, setSessionTitles] = createSignal<Map<string, string>>(new Map());
  let indexFetched = false;
  let indexInFlight: Promise<void> | null = null;
  async function refreshSessionIndex(force = false): Promise<void> {
    if (indexInFlight) return indexInFlight;
    if (indexFetched && !force) return;
    const run = (async () => {
      try {
        const r = await api("/api/sessions");
        const byId = new Map<string, string>();
        const byAgent = new Map<string, string[]>();
        const titles = new Map<string, string>();
        for (const s of r.sessions ?? []) {
          byId.set(s.id, s.agentId);
          if (typeof s.title === "string" && s.title) titles.set(s.id, s.title);
          const list = byAgent.get(s.agentId) ?? [];
          list.push(s.id); 
          byAgent.set(s.agentId, list);
        }
        setMasterSessionIndex(byId);
        setSessionsByAgent(byAgent);
        setSessionTitles(titles);
        indexFetched = true;
      } catch {
      }
    })();
    indexInFlight = run;
    try {
      await run;
    } finally {
      if (indexInFlight === run) indexInFlight = null;
    }
  }
  const [events, setEvents] = createSignal<Ev[]>([]);
  const [eventsTotal, setEventsTotal] = createSignal(0); 
  const [branches, setBranches] = createSignal<any[]>([]);
  const [metrics, setMetrics] = createSignal<any>(null);
  const drafts = new Map<string, string>();
  const [draft, setDraft] = createSignal(drafts.get(selected() ?? "") ?? "");
  const saveDraft = (v: string) => {
    setDraft(v);
    const id = selected();
    if (id) {
      if (v) drafts.set(id, v);
      else drafts.delete(id); 
    }
  };
  const [cfg, setCfg] = createSignal<any>({ providers: {} });
  const [showNew, setShowNew] = createSignal(false);

  const activeBgImage = () => {
    const preview = previewTheme();
    const want =
      preview ??
      (themeAuto()
        ? sysPrefersLight()
          ? sysLightTheme()
          : sysDarkTheme()
        : fixedTheme());
    return customThemes().find((t) => t.id === want)?.backgroundImage ?? "";
  };
  const paintedThemeId = () => {
    const want = themeAuto()
      ? sysPrefersLight()
        ? sysLightTheme()
        : sysDarkTheme()
      : fixedTheme();
    return customThemes().some((t) => t.id === want) || THEMES.some((t) => t.key === want)
      ? want
      : "dark";
  };

  const [showCfg, setShowCfg] = createSignal(false);
  let setupNudged = false;
  createEffect(() => {
    if (setupNudged || !cfg()?.needsSetup) return;
    setupNudged = true;
    requestAnimationFrame(() => {
      loadCfg();
      setShowCfg(true);
    });
  });
  createEffect(() => {
    if (!showCfg() || features()) return;
    api("/api/features")
      .then((f) => setFeatures(f as never))
      .catch(() => setFeatures(null));
  });
  const announcedOAuth = new Set<string>();
  const isNarrow = () => window.innerWidth <= NARROW_PX;
  const [narrow, setNarrow] = createSignal(isNarrow());
  onMount(() => {
    const onResize = () => setNarrow(isNarrow());
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
    onResize(); 
  });

  let lastContentHeight = 0;
  let unskipAnchor: { sel: string; top: number } | null = null;
  let unskipAnchorAt = 0;
  let feedRo: ResizeObserver | undefined;
  let feedRoEl: HTMLElement | undefined;
  let feedRoRaf = 0;
  let feedRoLastBox = "";
  const restoreAfterBoxChange = () => {
    feedRoRaf = 0;
    const f = feedEl();
    if (!f) return;

    lastSampleHeight = f.scrollHeight;
    lastSampleViewport = f.clientHeight;
    if (atBottom()) {
      pinToTail();
      return;
    }
    const anchorRow = unskipAnchor;
    if (!anchorRow) return;
    const el = f.querySelector<HTMLElement>(anchorRow.sel);
    if (!el) return;
    const delta = el.getBoundingClientRect().top - anchorRow.top;
    if (delta) {
      f.scrollTop += delta;
      ledger = { top: f.scrollTop, height: f.scrollHeight };
    }
    publishGap(tailSample());
  };

  function resyncAfterUnskip(f: HTMLElement, anchor: { sel: string; top: number } | null): void {
    if (!anchor) return;
    const el = f.querySelector<HTMLElement>(anchor.sel);
    if (!el) return;
    const delta = el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) < 1) return;
    if (Math.abs(delta) > RESYNC_MAX_DELTA_PX) return;
    f.scrollTop += delta;
    ledger = { top: f.scrollTop, height: f.scrollHeight };
  }
  const scheduleRestore = () => {
    if (feedRoRaf) return;
    feedRoRaf = requestAnimationFrame(restoreAfterBoxChange);
  };
  const attachFeedObserver = (f: HTMLElement | null) => {
    if (!f) return;
    if (f === feedRoEl) return; 
    feedRo ??= new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      const key = box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "";
      if (key === feedRoLastBox) return; 
      feedRoLastBox = key;
      scheduleRestore();
    });
    if (feedRoEl) feedRo.unobserve(feedRoEl);
    feedRoEl = f;
    feedRoLastBox = "";
    feedRo.observe(f);
  };
  onMount(() => {
    window.addEventListener("resize", scheduleRestore);
    onCleanup(() => {
      window.removeEventListener("resize", scheduleRestore);
      feedRo?.disconnect();
      feedRo = undefined;
      feedRoEl = undefined;
      if (feedRoRaf) cancelAnimationFrame(feedRoRaf);
    });
  });

  function firstVisibleRow(
    f: HTMLElement,
  ): { sel: string; top: number } | null {
    const rows = f.querySelectorAll<HTMLElement>("[data-eid]");
    if (!rows.length) return null;
    const feedTop = f.getBoundingClientRect().top;
    const at = (i: number) => rows[i]!.getBoundingClientRect();
    let lo = 0;
    let hi = rows.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (at(mid).bottom > feedTop) {
        found = mid;
        hi = mid - 1; 
      } else {
        lo = mid + 1; 
      }
    }
    if (found < 0) return null;
    const eid = rows[found]!.dataset.eid ?? "";
    return eid ? { sel: `[data-eid="${CSS.escape(eid)}"]`, top: at(found).top } : null;
  }
  const [showRight, setShowRight] = createSignal(
    localStorage.getItem("teapot.panel") !== null
      ? localStorage.getItem("teapot.panel") === "1"
      : window.innerWidth > NARROW_PX,
  );
  const setRight = (next: boolean) => {
    setShowRight(next);
    localStorage.setItem("teapot.panel", next ? "1" : "0");
  };
  const toggleRight = () => setRight(!showRight());
  const closeRight = () => {
    if (showRight()) setRight(false);
  };
  const [showLeft, setShowLeft] = createSignal(false);
  const closeLeft = () => setShowLeft(false);

  const [fixedTheme, setFixedTheme] = createSignal(localStorage.getItem("teapot.theme") ?? "dark");
  const [themeAuto, setThemeAuto] = createSignal(localStorage.getItem("teapot.theme.auto") === "1");
  const [sysLightTheme, setSysLightTheme] = createSignal(
    localStorage.getItem("teapot.theme.light") ?? "light",
  );
  const [previewTheme, setPreviewTheme] = createSignal<string | null>(null);
  const [customThemes, setCustomThemes] = createSignal<CustomTheme[]>(loadCustomThemes());
  onMount(() => {
    void loadCustomThemesFromServer().then((remote) => {
      if (remote === null) return;
      const merged = mergeThemes(customThemes(), remote);
      setCustomThemes(merged);
      saveCustomThemes(merged);
    });
  });
  const [sysDarkTheme, setSysDarkTheme] = createSignal(
    localStorage.getItem("teapot.theme.dark") ?? "dark",
  );
  const sysMql =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: light)")
      : null;
  const [sysPrefersLight, setSysPrefersLight] = createSignal(sysMql?.matches ?? false);
  onMount(() => {
    const onChange = (e: MediaQueryListEvent) => setSysPrefersLight(e.matches);
    sysMql?.addEventListener("change", onChange);
    onCleanup(() => sysMql?.removeEventListener("change", onChange));
  });
  createEffect(() => {
    const previewId = previewTheme();
    const want = previewId ?? (themeAuto()
      ? sysPrefersLight()
        ? sysLightTheme()
        : sysDarkTheme()
      : fixedTheme());
    const resolved = resolveActiveTheme({
      want,
      customIds: customThemes().map((t) => t.id),
      presetIds: THEMES.map((t) => t.key),
      fallback: "dark",
    });
    const active = resolved.active;
    const custom = customThemes().find((t) => t.id === active) ?? null;
    if (resolved.repaired) {
      if (themeAuto()) localStorage.setItem(sysPrefersLight() ? "teapot.theme.light" : "teapot.theme.dark", active);
      else localStorage.setItem("teapot.theme", active);
    }
    document.documentElement.dataset.theme = active;
    applyCustomTheme(document.documentElement, custom);
    document.documentElement.dataset.appearance =
      custom?.mode ?? THEMES.find((t) => t.key === active)?.mode ?? "dark";
  });
  const [modelProvider, setModelProvider] = createSignal("");
  const [modelDraft, setModelDraft] = createSignal("");
  const [effortDraft, setEffortDraft] = createSignal("");
  createEffect(() => {
    const id = selected();
    setEffortDraft(untrack(() => agents().find((a) => a.id === id)?.reasoningEffort ?? ""));
  });
  const [models, setModels] = createSignal<
    { id: string; contextLength?: number; pricing?: { prompt: number; completion: number }; modalities?: { input: string[]; output: string[] } }[]
  >([]);
  const providerList = () => Object.keys(cfg().providers ?? {});
  async function loadModels(prov: string) {
    if (!prov) return;
    try {
      const r = await api(`/api/models?provider=${encodeURIComponent(prov)}`);
      setModels(r.models ?? []);
    } catch { setModels([]); }
  }
  const modalityBadge = (m?: { modalities?: { input: string[]; output: string[] } }): string => {
    const icon: Record<string, string> = {
      text: "📄", image: "🖼️", audio: "🔊", video: "🎬️", file: "📎",
    };
    const side = (list?: string[]) =>
      (list ?? ["text"]).map((k) => icon[k] ?? k).join("");
    if (!m?.modalities) return "";
    return `${side(m.modalities.input)} → ${side(m.modalities.output)}`;
  };
  const modelSpec = () => {
    const id = modelDraft().trim() || sel()?.model || "";
    if (!id) return "";
    const m = models().find((x) => x.id === id);
    if (!m) return "";
    const parts: string[] = [];
    const badge = modalityBadge(m);
    if (badge && badge !== "📄 → 📄") parts.push(badge); 
    if (m.contextLength) parts.push(`ctx ${fmtK(m.contextLength)} tok`);
    const price = (p?: number) =>
      p === undefined ? "" : `${p * 1e6 >= 10 ? Math.round(p * 1e6) : +(p * 1e6).toFixed(1)}/M`;
    if (m.pricing) {
      const pin = price(m.pricing.prompt);
      const pout = price(m.pricing.completion);
      if (pin && pout) parts.push(`${pin} in · ${pout} out`);
      else if (pin || pout) parts.push(price(m.pricing.prompt ?? m.pricing.completion));
    }
    return parts.join(" · ");
  };
  let _prevModelAgent: string | null = null;
  let providerTouched = false;
  createEffect(() => {
    const id = selected();
    if (!id) return;
    const a = agents().find((x) => x.id === id);
    const prov = a?.provider || cfg().defaultProvider || providerList()[0] || "";
    if (!a) return;
    if (id !== _prevModelAgent) {
      _prevModelAgent = id;
      providerTouched = false; 
      if (untrack(() => modelProvider()) !== prov) {
        setModelProvider(prov);
        loadModels(prov);
      }
      if (untrack(() => modelDraft())) setModelDraft("");
    } else {
      const curProv = untrack(() => modelProvider());
      const curDraft = untrack(() => modelDraft());
      if (!curDraft && curProv !== prov && mayResyncProvider(providerTouched)) {
        setModelProvider(prov);
        loadModels(prov);
      }
    }
  });
  const MAX_COMPOSER_H = 360; 
  const [composerMaximized, setComposerMaximized] = createSignal(false);
  const [atBottom, setAtBottom] = createSignal(true);
  const [missed, setMissed] = createSignal(0);
  const [gapToTailPx, setGapToTailPx] = createSignal(-1);
  const publishGap = (s: TailSample | null) => setGapToTailPx(s ? gapToTail(s) : -1);
  const [compacting, setCompacting] = createSignal<{ phase: string; summarized?: number } | null>(null);
  const liveIsCompact = () => liveText().startsWith("[compact] ");
  const liveBody = () => {
    const body = liveIsCompact() ? liveText().slice("[compact] ".length) : liveText();
    const CAP = 1200;
    return body.length > CAP ? "…" + body.slice(-CAP) : body;
  };
  createEffect(() => {
    if (!compacting()) setLive((l) => (l?.text.startsWith("[compact] ") ? null : l));
  });
  createEffect(() => {
    void events().length;
    void eventsTotal();
    void compacting();
    void chatEvents().length;
    void olderDone();
    void loadingFeed();
    void loadingOlder();
    const f = feedEl();
    if (!f) return;
    const height = f.scrollHeight;
    if (height === lastContentHeight) return;
    lastContentHeight = height;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (atBottom()) pinToTail();
      }),
    );
  });
  const [liveByAgent, setLiveByAgent] = createSignal<Map<string, { text: string; reasoning: string; at: number }>>(new Map());
  const live = () => {
    const id = selected();
    return id ? liveByAgent().get(id) ?? null : null;
  };
  const setLive = (patch: { text: string; reasoning: string } | null | ((cur: { text: string; reasoning: string } | null) => { text: string; reasoning: string } | null)) => {
    const id = selected();
    if (!id) return;
    setLiveByAgent((prev) => {
      const m = new Map(prev);
      const next = typeof patch === "function" ? patch(prev.get(id) ?? null) : patch;
      if (next) m.set(id, { ...next, at: Date.now() });
      else m.delete(id);
      return m;
    });
  };
  const settleLiveBuffer = () => {
    const buf = live();
    if (!buf) return;
    const next = reconcileLiveBuffer(buf, events(), sel()?.status);
    if (!next) setLive(null);
    else if (next.text !== buf.text || next.reasoning !== buf.reasoning) setLive(next);
  };
  const [liveText, setLiveText] = createSignal("");
  const [thinkStartedAt, setThinkStartedAt] = createSignal(0);
  const liveStartedAt = () => thinkStartedAt();
  const [liveReasoning, setLiveReasoning] = createSignal("");
  let liveRenderTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const l = live();
    if (!l) {
      clearTimeout(liveRenderTimer);
      liveRenderTimer = undefined;
      setLiveText("");
      setLiveReasoning("");
      return;
    }
    if (liveRenderTimer) return; 
    liveRenderTimer = setTimeout(() => {
      liveRenderTimer = undefined;
      setLiveText(live()?.text ?? "");
      setLiveReasoning(live()?.reasoning ?? "");
    }, (live()?.text.length ?? 0) > 20_000 ? 250 : (live()?.text.length ?? 0) > 6_000 ? 120 : 60);
  });
  onCleanup(() => clearTimeout(liveRenderTimer));

  createEffect(() => {
    const list = agents();
    setLiveByAgent((prev) =>
      pruneDeadLiveBuffers(prev, (id) => list.find((x) => x.id === id)?.status),
    );
    setThinkStartedAt((cur) => clearThinkClockIfDone(cur, list, selected(), live()));
  });

  createEffect(() => {
    const txt = liveText();
    const rsn = live()?.reasoning ?? "";
    if (!txt && !rsn) return;
    requestAnimationFrame(() => {
      if (atBottom()) pinToTail();
    });
  });

  createEffect(() => {
    const queued = sel()?.pendingPrompts ?? 0;
    const liveIds = sel()?.pendingPromptIds;
    const key = pendingKey();
    const mine = pendingFor(key);
    const next = reconcilePending(mine, queued, liveIds);
    if (next !== mine) writePending(key, next);
  });

  createEffect(() => {
    const queue = sel()?.pendingPromptQueue;
    if (!queue?.length) return;
    const key = sel()?.session || pendingKey();
    const have = new Set(pendingFor(key).map((p) => p.promptId).filter(Boolean));
    const missing = queue.filter((q) => q.id && !have.has(q.id));
    if (!missing.length) return;
    writePending(key, [
      ...missing.map((q) => ({
        id: `p${q.id}`,
        text: q.text,
        at: Number(q.at) || Date.now(),
        promptId: q.id,
        images: q.images?.map((i) => i.url),
        ...(q.source ? { source: q.source } : {}),
      })),
      ...pendingFor(key),
    ]);
  });

  createEffect(() => {
    const id = selected();
    if (!id) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      requestAnimationFrame(() => {
        if (nearBottom()) {
          setAtBottom(true);
          setMissed(0);
          scrollBottom(true);
          markReadIfFollowing();
        }
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisible));
  });
  const sel = createMemo(() => agents().find((a) => a.id === selected()));
  const queuedCount = () => {
    const mine = sel()?.session === pendingKey() || !sel()?.session;
    return queuedBadgeCount({ sameSession: !!mine, agent: sel(), echoCount: pendingCount() });
  };
  const isSelLive = (): boolean => {
    const a = sel();
    if (!a) return false;
    return a.live ?? (a.status === "running" || a.status === "waiting" || a.status === "needs_operator");
  };
const isTimelineLive = (): boolean => {
    return timelineIsLive(sel() as { id: string; session?: string } | undefined, timelineId(), isSelLive());
  };
  const [editing, setEditing] = createSignal<{ eventId: string; text: string } | null>(null);
  const _answeredIds = createMemo(() => {
    const set = new Set<string>();
    for (const e of events()) {
      if (e.type === "tool_result" && e.data?.name === "ask_user") set.add(String(e.data.callId));
    }
    return set;
  });
  const pendingBySession = new Map<string, PendingEcho[]>();
  const [pendingMsgs, setPendingMsgs] = createSignal<PendingEcho[]>([]);
  const pendingKey = (): string => timelineId() || selected() || "?";
  const pendingFor = (key: string): PendingEcho[] => pendingBySession.get(key) ?? [];
  const writePending = (key: string, next: PendingEcho[]): void => {
    const seen = new Set<string>();
    const deduped: PendingEcho[] = [];
    for (let i = next.length - 1; i >= 0; i--) {
      const p = next[i]!;
      const id = p.promptId;
      if (!id) {
        deduped.push(p); 
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      deduped.push(p);
    }
    deduped.reverse();
    if (deduped.length === 0) pendingBySession.delete(key);
    else pendingBySession.set(key, deduped);
    if (pendingKey() === key) setPendingMsgs(deduped);
  };

  type Notif = {
    id: string;
    agentId: string;
    kind: "progress" | "finish" | "question" | "error";
    title: string;
    body: string;
    at: number;
    read: boolean;
    eventId?: string;
  };
  const [notifs, setNotifs] = createSignal<Notif[]>([]);
  const [hideGhosts, setHideGhosts] = createSignal(
    localStorage.getItem("teapot.hideGhosts") === "1",
  );
  const [showNotifs, setShowNotifs] = createSignal(false);
  const unreadCount = () => notifs().filter((n) => !n.read).length;
  const markSessionRead = (agentId: string) => {
    setNotifs((list) => {
      let changed = false;
      const next = list.map((n) => {
        if (n.read || n.agentId !== agentId) return n;
        changed = true;
        return { ...n, read: true };
      });
      return changed ? next : list; 
    });
  };
  const markReadIfFollowing = () => {
    const id = selected();
    if (!id) return;
    if (!notifs().some((n) => !n.read && n.agentId === id)) return;
    markSessionRead(id);
  };
  const subtreeUnread = (agentId: string): number => {
    let total = notifs().filter((n) => !n.read && n.agentId === agentId).length;
    for (const child of agents()) {
      if (child.parent === agentId)
        total += subtreeUnread(child.id);
    }
    return total;
  };
  let notifSeq = 0;
  const addNotif = (n: Omit<Notif, "id" | "at" | "read">) => {
    setNotifs((list) =>
      [{ ...n, id: `n${++notifSeq}`, at: Date.now(), read: false }, ...list].slice(0, 50),
    );
  };
  const maybeNotify = (agentId: string, ev: any) => {
    const who = agents().find((a) => a.id === agentId)?.id ?? agentId;
    const eid = typeof ev.id === "string" ? ev.id : undefined;
    if (ev.type === "message" && ev.data?.final === true) {
      addNotif({
        agentId,
        kind: "finish",
        title: `${who} finished`,
        body: String(ev.data.content ?? "").slice(0, 300),
        eventId: eid,
      });
    } else if (ev.type === "question") {
      addNotif({
        agentId,
        kind: "question",
        title: `${who} asks a question`,
        body: String(ev.data.question ?? "").slice(0, 300),
        eventId: eid,
      });
    } else if (ev.type === "error") {
      addNotif({
        agentId,
        kind: "error",
        title: `${who} hit an error`,
        body: String(ev.data.message ?? "").slice(0, 300),
        eventId: eid,
      });
    } else if (ev.type === "progress") {
      addNotif({
        agentId,
        kind: "progress",
        title: `${who}: ${String(ev.data.doing ?? "progress")}`.slice(0, 120),
        body: [ev.data.recent && `recent: ${ev.data.recent}`, ev.data.next && `next: ${ev.data.next}`]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 300),
        eventId: eid,
      });
    }
  };
  const jumpToEvent = (eventId: string) => {
    const el = document.querySelector<HTMLElement>(`[data-eid="${eventId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("flash-target");
      setTimeout(() => el.classList.remove("flash-target"), 1600);
    }
  };

  const pairInfo = createMemo(() => {
    const resFor = new Map<string, Ev>();
    const consumed = new Set<string>();
    const awaiting = new Map<string, Ev[]>();
    const orphanCalls = new Map<string, Ev>();
    for (const e of events()) {
      if (!FEED_TYPES.has(e.type)) continue;
      if (e.type === "tool_call") {
        const q = awaiting.get(e.data.callId) ?? [];
        q.push(e);
        awaiting.set(e.data.callId, q);
      } else if (e.type === "tool_result") {
        const call = awaiting.get(e.data.callId)?.shift();
        if (call) {
          resFor.set(call.id, e);
          consumed.add(e.id);
        } else {
          orphanCalls.set(e.id, e);
        }
      }
    }
    return { resFor, consumed, orphanCalls };
  });  
  const [locallyAnswered, setLocallyAnswered] = createSignal<Set<string>>(new Set());
  const markAnswered = (callId: string) => {
    if (!callId) return;
    setLocallyAnswered((prev: Set<string>): Set<string> => {
      if (prev.has(callId)) return prev;
      const next: Set<string> = new Set<string>(prev);
      next.add(callId);
      return next;
    });
  };
  const clearLocallyAnswered = () => setLocallyAnswered(new Set<string>());
  const answeredQuestionIds = createMemo(() =>
    answeredQuestionIdsOf(events() as unknown as QuestionEvent[], locallyAnswered()),
  );
  const timeline = createMemo(() =>
    buildTimelineWithCount({
      events: events() as TimelineEvent[],
      consumed: pairInfo().consumed,
      pending: pendingMsgs() as PendingEchoLike[],
      echo: echoEv as (p: PendingEchoLike) => TimelineEvent,
      feedTypes: FEED_TYPES,
      renderedTypes: RENDERED_TYPES,
      renderedNoteEvents: RENDERED_NOTE_EVENTS,
    }),
  );
  const chatEvents = () => timeline().rows as Ev[];
  const pendingCount = () => timeline().pendingCount;
  const rowIndex = createMemo(() => {
    const m = new WeakMap<Ev, number>();
    chatEvents().forEach((r, i) => m.set(r, i));
    return m;
  });
  const neighbourOf = (row: Ev, delta: number): Ev | undefined => {
    const idx = rowIndex().get(row);
    if (idx === undefined) return undefined;
    return chatEvents()[idx + delta];
  };
  const echoCache = new Map<string, Ev>();
  function echoEv(p: PendingEcho): Ev {
    const key = `${p.id}:${p.sent ? "s" : "p"}`;
    const hit = echoCache.get(key);
    if (hit) return hit;
    if (echoCache.size > 64) echoCache.clear();
    const ev: Ev = {
      id: p.id,
      seq: Number.MAX_SAFE_INTEGER,
      ts: new Date(p.at).toISOString(),
      session: sel()?.session ?? "",
      branch: sel()?.branch ?? "br0",
      parent: null,
      type: "prompt",
      data: {
        source: p.source ?? "user",
        text: p.text,
        pending: !p.sent,
        ...(p.images?.length ? { images: p.images } : {}),
        ...(p.promptId ? { promptId: p.promptId } : {}),
      },
    };
    echoCache.set(key, ev);
    return ev;
  }
  const loadCfg = () => api("/api/config").then(setCfg).catch(() => {});
  const [authLocked, setAuthLocked] = createSignal(false);
  onMount(() => {
    const onUnauthorized = () => setAuthLocked(true);
    window.addEventListener("teapot:unauthorized", onUnauthorized);
    onCleanup(() => window.removeEventListener("teapot:unauthorized", onUnauthorized));
  });

  const [todoDraft, setTodoDraft] = createSignal("");
  const [todoViewMode, setTodoViewMode] = createSignal(true);
  const [todoDirty, setTodoDirty] = createSignal(false);
  let todoSeededFor = "";
  createEffect(() => {
    const id = selected();
    const serverTodo = agents().find((a) => a.id === id)?.todo ?? "";
    if (id && id !== todoSeededFor) {
      todoSeededFor = id;
      setTodoDirty(false);
      setTodoDraft(serverTodo);
    } else if (id && !todoDirty()) {
      setTodoDraft(serverTodo); 
    }
  });
  const saveTodo = async () => {
    const notify = (document.getElementById("todo-notify") as HTMLInputElement)?.checked ?? true;
    if (!selected()) return;
    try {
      await api(`/api/agents/${selected()}/todo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: todoDraft(), notify }),
      });
      setTodoDirty(false);
      setTodoViewMode(true);
      flashHint(`tasks saved${notify && todoDraft().trim() ? " & notification queued" : ""}`);
      refreshAgents();
    } catch (ex) {
      flashHint(`save failed: ${(ex as Error).message}`);
    }
  };

  const todoStats = createMemo(() => {
    let total = 0;
    let done = 0;
    for (const line of todoDraft().split("\n")) {
      const m = line.match(/^\s*[-*+] \[([ xX])\]/);
      if (!m) continue;
      total++;
      if (m[1]!.toLowerCase() === "x") done++;
    }
    return { total, done };
  });

function mergeAgentSnapshots(prev: Agent[], next: Agent[]): Agent[] {
  const prevById = new Map(prev.map((a) => [a.id, a]));
  return next.map((a) => {
    const p = prevById.get(a.id);
    return p && JSON.stringify(p) === JSON.stringify(a) ? p : a;
  });
}

  const refreshAgents = () =>
    api("/api/agents")
      .then((d) => {
        let agentSetChanged = false;
        setAgents((prev) => {
          if (prev.length !== (d.agents ?? []).length) agentSetChanged = true;
          if ((d.agents ?? []).some((a: Agent) => !prev.some((p) => p.id === a.id)))
            agentSetChanged = true;
          return mergeAgentSnapshots(prev, d.agents ?? []);
        });
        if (agentSetChanged) void refreshSessionIndex();
      })
      .catch(() => {});
  const refreshMetrics = () => api("/api/metrics").then(setMetrics).catch(() => {});
  const [tasks, setTasks] = createSignal<any[]>([]);
  const loadTasks = () => api("/api/tasks").then((d) => setTasks(d.tasks)).catch(() => {});
  const agentTasks = (id: string | null) => tasks().filter((t) => t.agent === id);

  const [expandedSubs, setExpandedSubs] = createSignal<Set<string>>((() => {
    try {
      const keys: string[] = JSON.parse(localStorage.getItem("teapot.expandedSubs") ?? "[]");
      return new Set(keys.filter((k) => typeof k === "string"));
    } catch { return new Set(); }
  })());
  const [collapsedSubs, setCollapsedSubs] = createSignal<Set<string>>((() => {
    try {
      const keys: string[] = JSON.parse(localStorage.getItem("teapot.collapsed") ?? "[]");
      return new Set(keys.filter((k) => typeof k === "string" && !k.startsWith("chat:")));
    } catch { return new Set(); }
  })());
  const subsCollapsed = (id: string): boolean =>
    collapsedSubs().has(id) || !expandedSubs().has(id);
  const toggleCollapse = (id: string) => {
    const next = new Set(expandedSubs());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedSubs(next);
    localStorage.setItem("teapot.expandedSubs", JSON.stringify([...next]));
    if (next.has(id) && collapsedSubs().has(id)) {
      const cleared = new Set(collapsedSubs());
      cleared.delete(id);
      setCollapsedSubs(cleared);
      localStorage.setItem("teapot.collapsed", JSON.stringify([...cleared]));
    }
  };

  const _workspaceOf = (id: string): string => workspaceOfPure(agents(), id);
  const chatGroupKey = (a: Agent): string => chatGroupKeyOf(agents(), a);

  const [wsCollapsed, setWsCollapsed] = createSignal<Set<string>>((() => {
    try {
      const raw = JSON.parse(localStorage.getItem("teapot.wsCollapsed") ?? "[]");
      const keys = Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];

      const VERSION = 2;
      const marker = Number(localStorage.getItem("teapot.wsCollapsed.v") ?? "0");
      if (marker < VERSION) {
        const kept = keys.filter((k) => !k.startsWith("chat:"));
        const dropped = keys.length - kept.length;
        if (dropped > 0) {
          localStorage.setItem("teapot.wsCollapsed", JSON.stringify(kept));
        }
        localStorage.setItem("teapot.wsCollapsed.v", String(VERSION));
        return new Set<string>(kept);
      }
      return new Set<string>(keys);
    } catch {
      return new Set<string>();
    }
  })());

  const chatCollapsed = createMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const k of wsCollapsed()) if (k.startsWith("chat:")) out.add(k);
    return out;
  });

  const treeRows = createMemo(() =>
    treeRowsOf(
      agents(),
      new Set(
        agents()
          .filter((a) => subsCollapsed(a.id))
          .map((a) => a.id),
      ),
      hideGhosts(),
      chatCollapsed(),
    ),
  );
  const toggleWsGroup = (
    groupKey: string,
    label: string,
    isCollapsed: boolean,
    alsoClear?: string,
  ) => {
    const next = new Set(wsCollapsed());
    if (isCollapsed) {
      next.delete(groupKey);
      if (alsoClear) next.delete(alsoClear);
    } else {
      next.add(groupKey);
      if (alsoClear) next.delete(alsoClear);
      const open = selected();
      if (open && (groupKey === `chat:${open}` || chatGroupKey(agents().find((x) => x.id === open)!) === groupKey))
        flashHint(`hid ${label} — click the header to show it`);
    }
    setWsCollapsed(next);
    try {
      localStorage.setItem("teapot.wsCollapsed", JSON.stringify([...next]));
    } catch {
    }
  };
  const basenameOf = (p: string): string => p.replace(/\/+$/, "").split(/[/\\]/).pop() || p;
  const wsCountLabel = (ws: string): string => {
    const n = wsChatCounts().get(ws) ?? 0;
    return `${n} chat${n === 1 ? "" : "s"}`;
  };
  const wsChatCounts = createMemo(() => wsChatCountsOf(agents()));
  const sidebarRows = createMemo(() =>
    sidebarRowsOf(agents(), treeRows(), wsCollapsed()),
  );

  const FEED_PAGE = 2000;

  const [branchFilter, setBranchFilter] = createSignal<string | null>(null);
  const evCache = new Map<string, Ev>();
  function cacheKey(ev: { id: string }): string {
    return `${timelineId() || (selected() ?? "?")}:${ev.id}`;
  }
  function stabilize(list: Ev[]): Ev[] {
    const out: Ev[] = Array.from({ length: list.length });
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      const k = cacheKey(e);
      const known = evCache.get(k);
      out[i] = known ?? e;
      if (!known) {
        evCache.set(k, e);
        if (evCache.size > 6000) {
          const oldest = evCache.keys().next().value;
          if (oldest !== undefined) evCache.delete(oldest);
        }
      }
    }
    return out;
  }

  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [loadingFeed, setLoadingFeed] = createSignal(false);
  const [olderDone, setOlderDone] = createSignal(false);
  let feedGeneration = 0;
  let lastBranchesGen = -1;

  function mergeEvents(incoming: Ev[]): void {
    const stable = stabilize(incoming);
    setEvents((prev) => {
      if (stable.length > 0 && prev.length > 0) {
        const newest = prev[prev.length - 1]!;
        const allNewer = stable.every((e) => e.seq > newest.seq);
        const known = new Set(prev.map((e) => e.id));
        if (allNewer && stable.every((e) => !known.has(e.id))) {
          return [...prev, ...stable];
        }
      }
      const map = new Map<string, Ev>();
      for (const e of prev) map.set(e.id, e);
      let added = false;
      for (const e of stable)
        if (!map.has(e.id)) {
          map.set(e.id, e);
          added = true;
        }
      if (!added) return prev;
      return [...map.values()].sort((a, b) => a.seq - b.seq);
    });
  }

  async function backfillUntilScrollable(): Promise<void> {
    const id = selected();
    if (!id || olderDone() || loadingOlder()) return;
    if (atBottom()) return;
    if (events().length >= eventsTotal()) {
      setOlderDone(true);
      return;
    }
    const measurable = () => {
      const f = feedEl();
      return f && f.clientHeight > 0 ? f : null;
    };
    let guard = 0;
    while (guard++ < 20 && !olderDone() && selected() === id) {
      const f = measurable();
      if (f && f.scrollHeight > f.clientHeight + 40) return; 
      if (events().length >= eventsTotal()) {
        setOlderDone(true);
        return;
      }
      const before = events().length;
      await loadOlder();
      if (events().length === before) return;
      if (atTail(tailSample()) && selected() === id) scrollBottom(true);
    }
  }

  async function loadOlder(): Promise<void> {
    const id = selected();
    const oldest = events()[0];
    if (!id || !oldest || loadingOlder() || olderDone()) return;
    setLoadingOlder(true);
    try {
      const f = feedEl();
      const prevH = f?.scrollHeight ?? 0;
      const prevTop = f?.scrollTop ?? 0;
      const bf = branchFilter();
      const tid = timelineId();
      const res = await api(eventsUrl(id, { before: oldest.id }, tid, bf));
      const page: Ev[] = res.events ?? [];
      if (page.length === 0) { setOlderDone(true); return; }
      if (selected() !== id || events()[0]?.id !== oldest.id) return;
      mergeEvents(page);
      requestAnimationFrame(() => {
        if (selected() === id) {
          const el = feedEl();
          if (el) el.scrollTop = prevTop + (el.scrollHeight - prevH);
        }
      });
    } catch {  }
    finally { setLoadingOlder(false); }
  }

  function sessionQuery(agentId: string, tid: string): string {
    if (!tid) return "";
    return masterSessionIndex().has(tid) ? `&session=${encodeURIComponent(tid)}` : "";
  }

  function eventsUrl(
    id: string,
    page: { before?: string; after?: string },
    tid: string,
    bf: string | null,
  ): string {
    const parts = [`/api/agents/${encodeURIComponent(id)}/events?limit=${FEED_PAGE}`];
    if (page.before) parts.push(`&before=${encodeURIComponent(page.before)}`);
    if (page.after) parts.push(`&after=${encodeURIComponent(page.after)}`);
    const sessQ = sessionQuery(id, tid);
    if (sessQ) parts.push(sessQ);
    if (bf) parts.push(`&branch=${encodeURIComponent(bf)}&lineage=true`);
    return parts.join("");
  }

  async function loadEvents(id: string, sessionId?: string) {
    const genAtStart = feedGeneration;
    const tid = sessionId ?? timelineId() ?? "";
    try {
      const bf = branchFilter();
      const needsBranches = genAtStart !== lastBranchesGen || !branches().length;
      if (!events().length) setLoadingFeed(true);
      void api(`/api/agents/${id}/skills`)
        .then((sk) => {
          if (genAtStart === feedGeneration && selected() === id) setAgentSkills(sk.skills ?? []);
        })
        .catch(() => {});
      const [ev, br] = await Promise.all([
        api(eventsUrl(id, {}, tid, bf)),
        needsBranches
          ? api(`/api/agents/${id}/branches`)
          : Promise.resolve({ branches: branches() }),
      ]);
      if (needsBranches) lastBranchesGen = genAtStart;
      if (genAtStart !== feedGeneration || selected() !== id) return; 
      setEvents((prev) => {
        const map = new Map<string, Ev>();
        for (const e of prev) map.set(e.id, e);
        for (const e of stabilize(ev.events)) map.set(e.id, e);
        return [...map.values()].sort((a, b) => a.seq - b.seq);
      });
      setEventsTotal(ev.total ?? ev.events.length);
      setBranches(br.branches);
    } catch {  }
    finally { setLoadingFeed(false); }
  }

  function feedEl() { return document.querySelector<HTMLElement>(".feed"); }
  function tailSample(): TailSample | null {
    const f = feedEl();
    if (!f) return null;
    return { top: f.scrollTop, height: f.scrollHeight, viewport: f.clientHeight };
  }
  function nearBottom() {
    const s = tailSample();
    return atTail(s);
  }
  function pinToTail() {
    const f = feedEl();
    if (!f) return;
    f.scrollTop = f.scrollHeight;
    ledger = { top: f.scrollTop, height: f.scrollHeight };
    setMissed(0);
  }
  function scrollBottom(force = false) {
    if (force || atBottom()) pinToTail();
  }

  const timelineCache = new Map<string, { events: Ev[]; total: number; at: number; bytes: number }>();
  const scrollMemory = new Map<string, { eid: string; delta: number; atTail: boolean }>();
  const SCROLL_MEMORY_MAX = 24;
  const TIMELINE_CACHE_MAX = 6;
  const TIMELINE_CACHE_MAX_BYTES = 24 * 1024 * 1024;
  const approxEventBytes = (e: Ev): number => {
    const d = e.data as Record<string, unknown> | undefined;
    let n = 64; 
    if (d) for (const v of Object.values(d)) if (typeof v === "string") n += v.length * 2;
    return n;
  };

  const latestSessionOf = (agentId: string, requested?: string | null): string | null =>
    resolveTimelineSession(
      sessionsByAgent().get(agentId),
      agents().find((a) => a.id === agentId)?.session,
      requested,
    );

  async function select(id: string, push = true, forceSession?: string | null) {
    const prevId = selected();
    const prevTid = timelineId();
    const prevEvents = events();
    const prevTotal = eventsTotal();
    feedGeneration++;
    if (!sessionsByAgent().size) void refreshSessionIndex(); 
    const resolved = latestSessionOf(id, forceSession);
    const requested = forceSession && masterSessionIndex().has(forceSession) ? forceSession : null;
    let tid = resolved ?? requested ?? id;
    if (prevId !== id || tid !== prevTid) {
      {
        const f = feedEl();
        const anchor = f ? firstVisibleRow(f) : null;
        const outKey = prevTid || prevId;
        if (f && outKey && anchor) {
          const row = f.querySelector<HTMLElement>(anchor.sel);
          const eid = row?.dataset.eid ?? "";
          const atTail = f.scrollHeight - f.scrollTop - f.clientHeight <= AT_TAIL_PX;
          if (eid) scrollMemory.set(outKey, { eid, delta: f.getBoundingClientRect().top - anchor.top, atTail });
          while (scrollMemory.size > SCROLL_MEMORY_MAX) {
            const oldest = scrollMemory.keys().next().value;
            if (oldest === undefined) break;
            scrollMemory.delete(oldest);
          }
        }
      }
      if (prevTid && prevEvents.length) {
        const bytes = prevEvents.reduce((n, e) => n + approxEventBytes(e), 0);
        if (bytes <= TIMELINE_CACHE_MAX_BYTES) {
          timelineCache.set(prevTid, { events: prevEvents, total: prevTotal, at: Date.now(), bytes });
        }
        const totalBytes = () => [...timelineCache.values()].reduce((n, v) => n + v.bytes, 0);
        while (timelineCache.size > TIMELINE_CACHE_MAX || totalBytes() > TIMELINE_CACHE_MAX_BYTES) {
          const oldest = [...timelineCache.entries()].sort((x, y) => x[1].at - y[1].at)[0];
          if (!oldest) break;
          timelineCache.delete(oldest[0]);
        }
      }
      setEvents([]);
      evCache.clear(); 
      clearLocallyAnswered();
      setCompacting(null);
      setMissed(0);
      setAtBottom(scrollMemory.get(tid)?.atTail ?? true);
      lastSample = undefined;
    }
    setSelected(id);
    setTimelineId(tid);
    saveDraft(drafts.get(id) ?? ""); 
    setBranchFilter(null);
    setOlderDone(false);
    setLoadingOlder(false);
    writePending(prevTid || prevId || "?", pendingMsgs());
    setPendingMsgs(pendingFor(tid || id));
    localStorage.setItem("teapot.session", id);
    navigate(tid, push); 
    const cached = timelineCache.get(tid);
    if (cached?.events.length) {
      setEvents(stabilize(cached.events));
      setEventsTotal(cached.total);
      setLoadingFeed(true);
      if (!scrollMemory.has(tid)) {
        requestAnimationFrame(() => {
          if (selected() === id) scrollBottom(true);
        });
      }
    }
    api(`/api/agents/${id}/load`, { method: "POST" }).then(refreshAgents).catch(() => {});
    await loadEvents(id, tid);
    if (selected() !== id) return; 
    setLiveByAgent((prev) => {
      const cur = prev.get(id) ?? null;
      const next = reconcileLiveBuffer(cur, events(), sel()?.status);
      if (next === cur) return prev;
      const m = new Map(prev);
      if (next) m.set(id, next);
      else m.delete(id);
      return m;
    });
    setCompacting(
      sel()?.ctx?.compacting ? { phase: String(sel()!.ctx!.compacting) } : null,
    );
    const restore = scrollMemory.get(tid);
    setAtBottom(restore ? restore.atTail : true);
    requestAnimationFrame(() => {
      if (selected() !== id) return;
      if (restore) {
        const f = feedEl();
        const row = f?.querySelector<HTMLElement>(`[data-eid="${CSS.escape(restore.eid)}"]`);
        if (f && row) {
          f.scrollTop += row.getBoundingClientRect().top - f.getBoundingClientRect().top + restore.delta;
          ledger = { top: f.scrollTop, height: f.scrollHeight };
          if (restore.atTail) scrollBottom(true);
          return;
        }
        if (restore.atTail) scrollBottom(true);
        return;
      }
      scrollBottom(true);
    });
    void backfillUntilScrollable();
  }

  const [connected, setConnected] = createSignal(false);
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => ws?.close());
  let pendingRefresh = false;
  let onTabVisible: (() => void) | null = null;
  document.addEventListener("visibilitychange", () => onTabVisible?.());
  onCleanup(() => { onTabVisible = null; });
  let firstConnect = true;
  let runFeedRefreshRef: (() => Promise<void>) | null = null;

  async function catchUpAfterReconnect(): Promise<void> {
    const id = selected();
    const cursor = events().at(-1)?.id;
    const tid = timelineId();
    const hidden = document.visibilityState === "hidden";
    if (!id || !cursor) {
      pendingRefresh = true;
      if (!hidden) void runFeedRefreshRef?.();
      return;
    }
    try {
      const bf = branchFilter();
      const q = eventsUrl(id, { after: cursor }, tid, bf);
      const r = (await api(q)) as { events?: Ev[]; gap?: boolean };
      const got = r.events ?? [];
      if (r.gap) {
        setEvents(stabilize(got));
        setEventsTotal(got.length);
      } else if (got.length) {
        mergeEvents(got);
        setEventsTotal((n) => n + got.length);
      }
      await refreshAgents();
      if (got.length && !hidden) void refreshMetrics();
    } catch {
      pendingRefresh = true;
    }
  }

  function connectWs() {
    firstConnect = true;
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    const sock = new WebSocket(`${proto}${location.host}/api/ws${wsTokenQuery()}`);
    ws = sock;
    sock.onopen = () => {
      setConnected(true);
      if (firstConnect) {
        firstConnect = false;
        return;
      }
      void catchUpAfterReconnect();
    };
    sock.onclose = () => {
      setConnected(false);
      setTimeout(connectWs, 1500); 
    };
    sock.onerror = () => sock.close();
    const FEED_IRRELEVANT = new Set(["state", "usage", "session_start"]);
    sock.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.kind === "ping") {
        try {
          sock.send(JSON.stringify({ kind: "pong" }));
        } catch {
        }
        return;
      }
      if (msg.kind === "pong") return;
      if (msg.kind === "hello" && Array.isArray(msg.agents)) {
        setAgents((prev) => mergeAgentSnapshots(prev, msg.agents as Agent[]));
        const list = agents();
        setLiveByAgent((prev) =>
          pruneDeadLiveBuffers(prev, (id) => list.find((x) => x.id === id)?.status),
        );
        return;
      }
      if (msg.kind === "event" && isTurnBoundary(msg.event)) {
        setLiveByAgent((prev) => clearLive(prev, msg.agentId));
        return; 
      }
      if (msg.kind === "llm-delta") {
        if (!deltaBelongsToTimeline(msg, selected(), timelineId())) return;
        setLiveByAgent((prev) => applyDelta(prev, msg.agentId, msg));
        if (msg.agentId === selected()) {
          const r = String(msg.reasoning ?? "");
          const t = String(msg.text ?? "");
          if (r && !t) {
            if (!thinkStartedAt()) setThinkStartedAt(Date.now());
          } else if (t) {
            setThinkStartedAt(0);
          }
        }
        return;
      }
      if (msg.kind === "compaction-progress") {
        if (msg.agentId !== selected()) return;
        if (msg.phase === "done") setCompacting(null);
        else setCompacting({ phase: msg.phase, summarized: msg.summarized });
        return;
      }
      if (msg.kind === "agent-update" && msg.snapshot) {
        setAgents((prev) => {
          const i = prev.findIndex((a) => a.id === msg.snapshot.id);
          const next = msg.snapshot;
          if (i === -1) return [...prev, next];
          return mergeAgentSnapshots(
            prev,
            prev.map((a, j) => (j === i ? msg.snapshot : a)),
          );
        });
        return; 
      }
      if (msg.kind === "metrics" && msg.metrics) {
        setMetrics(msg.metrics);
        return;
      }
      if (msg.kind === "tasks" && Array.isArray(msg.tasks)) {
        setTasks(msg.tasks);
        return;
      }
      if (msg.kind === "event") {
        const et = msg.event?.type;
        const ed = msg.event?.data ?? {};
        if (et === "system_note" && (ed.event === "prompt-delivered" || ed.event === "prompt-cancelled")) {
          const pid = String(ed.promptId ?? "");
          if (pid) {
            const holder = String((msg.event as { session?: string })?.session ?? "");
            const keys = new Set<string>();
            if (holder) keys.add(holder);
            keys.add(pendingKey());
            for (const [k, list] of pendingBySession) if (list.some((p) => p.promptId === pid)) keys.add(k);
            for (const k of keys) {
              const cur = pendingFor(k);
              if (!cur.some((p) => p.promptId === pid)) continue;
              writePending(k, cur.filter((p) => p.promptId !== pid));
            }
          }
        }
        if (FEED_IRRELEVANT.has(et) && !NOTE_FEED_TYPES.has(et)) return;
        maybeNotify(msg.agentId, msg.event);
        if (msg.event?.agent !== selected()) return;
        if (!eventBelongsOnTimeline(msg.event as { agent?: string; session?: string }, selected(), timelineId()))
          return;

        /**
         * A seq gap is FILLED by the socket, not by refetching `/events`.
         *
         * The socket delivers every event, so a gap only means the server had already written events
         * this client had not seen — not that anything is missing. Refetching on each gap made the UI
         * hammer `/api/agents/:id/events` (and `/skills`) whenever a burst of events arrived, which is
         * exactly the redundant traffic the operator noticed. Only a genuine RECONNECT needs a read,
         * and `catchUpAfterReconnect()` already does that.
         */
        mergeEvents([msg.event as Ev]);
        if (msg.event) settleLiveBuffer();
        pendingRefresh = true;
        if (document.visibilityState !== "visible") return;
        if (timer) return;
        timer = setTimeout(runFeedRefresh, 60);
      }
      if (document.visibilityState === "hidden") {
        pendingRefresh = true;
        return;
      }
      if (timer) return;
      timer = setTimeout(runFeedRefresh, 120);
    };
    pendingRefresh = false;
    const runFeedRefresh = async () => {
        timer = null;
        if (selected()) {
          const beforeId = events().at(-1)?.id;
          const beforeLen = events().length;
          const buf = live();
          if (buf && !reconcileLiveBuffer(buf, events(), sel()?.status)) setLive(null);
          if (events().at(-1)?.id !== beforeId) {
            if (atBottom()) {
              pinToTail();
              markSessionRead(selected()!);
            } else {
              setMissed((n) => n + Math.max(0, events().length - beforeLen));
              publishGap(tailSample());
            }
          }
        }
    };
    runFeedRefreshRef = runFeedRefresh;
    onTabVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refreshMetrics();
      void loadTasks();
      const id = selected();
      if (!id) return;
      if (pendingRefresh) {
        pendingRefresh = false;
        void runFeedRefresh();
        return;
      }
      const cursor = events().at(-1)?.id;
      if (!cursor) {
        pendingRefresh = true;
        void runFeedRefresh();
        return;
      }
      void catchUpAfterReconnect();
    };
  }

  const pathId = () => decodeURIComponent(location.pathname.split("/")[2] ?? "");
  function navigate(sessionId: string, push = true) {
    const linkable = linkableSessionId(
      sessionId,
      masterSessionIndex(),
      agents().map((a) => a.id),
    );
    if (!linkable) return; 
    const url = `/session/${encodeURIComponent(linkable)}`;
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }
  window.addEventListener("popstate", () => {
    const sid = pathId();
    const owner = masterSessionIndex().get(sid);
    if (owner && (owner !== selected() || sid !== timelineId())) select(owner, false, sid || null);
  });

  createEffect(() => {
    const a = sel();
    const base = a
      ? `${isSelLive() ? "▶ " : a.status === "error" ? "⚠ " : ""}${agentLabel(a)} · teapot`
      : "teapot";
    document.title = unreadCount() > 0 ? `(${unreadCount()}) ${base}` : base;
  });
  const anyOverlayOpen = (): boolean =>
    showNew() || showCfg() || editing() !== null || (isNarrow() && showRight());

  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (typing) {
      if (e.key === "Escape") (t as HTMLElement).blur();
      return;
    }
    if (e.key === "Escape") {
      if (showNew()) { setShowNew(false); return; }
      if (showCfg()) { setShowCfg(false); return; }
      if (editing()) { setEditing(null); return; }
      if (isNarrow() && showRight()) { closeRight(); return; }
      const s = sel();
      if (s && isSelLive()) {
        api(`/api/agents/${s.id}/stop`, { method: "POST" }).then(refreshAgents);
        return;
      }
      return;
    }
    if (anyOverlayOpen()) return;
    if (e.key === "/") {
      e.preventDefault();
      document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
    } else if (e.key === "d") {
      toggleRight();
    } else if (e.key === "t") {
      toggleTerm();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const list = treeRows().map((r) => r.a);
      if (list.length === 0) return;
      e.preventDefault();
      const idx = list.findIndex((a) => a.id === selected());
      const next = e.key === "ArrowDown" ? Math.min(idx + 1, list.length - 1) : Math.max(idx - 1, 0);
      if (next !== idx) select(list[next].id);
    }
  });

  const [termOpen, setTermOpen] = createSignal(localStorage.getItem("teapot.term") === "1");
  type BgJob = {
    id: string; cmd: string; owner: string; running: boolean; code: number | null;
    startedAt: number; tail: string; bytes: number; truncated: boolean;
    detached?: boolean; pid?: number | null;
  };
  const [bgJobs, setBgJobs] = createSignal<BgJob[]>([]);
  const [showBg, setShowBg] = createSignal(false);
  const refreshBg = async () => {
    const id = selected();
    if (!id) return;
    const r = (await api(`/api/agents/${encodeURIComponent(id)}/bg-jobs`).catch(() => null)) as { jobs?: BgJob[] } | null;
    if (r?.jobs) setBgJobs(r.jobs);
  };
  createEffect(() => {
    void selected();
    void refreshBg();
  });
  createEffect(() => {
    if (!showBg()) return;
    const t = setInterval(() => void refreshBg(), 2000);
    onCleanup(() => clearInterval(t));
  });

  const [renaming, setRenaming] = createSignal(false);
  const [renameDraft, setRenameDraft] = createSignal("");
  const beginRename = () => {
    const a = sel();
    if (!a) return;
    setRenameDraft(agentLabel(a));
    setRenaming(true);
  };
  const commitRename = async () => {
    if (!renaming()) return; 
    const a = sel();
    setRenaming(false);
    const next = renameDraft().replace(/\s+/g, " ").trim();
    if (!a || !next || next === agentLabel(a)) return;
    const r = (await api(
      `/api/agents/${encodeURIComponent(a.id)}/session-title?session=${encodeURIComponent(a.session)}`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: next }) },
    ).catch((e) => ({ error: String(e) }))) as { title?: string; error?: string };
    if (r?.error) {
      flashHint(`rename failed: ${r.error}`);
      return;
    }
    setSessionTitles((m) => new Map(m).set(a.session, next));
    void refreshAgents();
  };

  const toggleTerm = () => {
    const next = !termOpen();
    setTermOpen(next);
    localStorage.setItem("teapot.term", next ? "1" : "0");
  };

  type TermTab = { key: string; agentId: string; title: string };
  type TermSession = {
    el: HTMLDivElement;
    term: any;
    fit: any;
    ws: WebSocket;
    ro: ResizeObserver | null;
  };
  const [termTabs, setTermTabs] = createSignal<TermTab[]>([]);
  const [paneL, setPaneL] = createSignal(0);
  const [paneR, setPaneR] = createSignal(-1);
  const [splitView, setSplitView] = createSignal(false);
  const [focusedPane, setFocusedPane] = createSignal(0);
  const [termHeight, setTermHeight] = createSignal(
    Number(localStorage.getItem("teapot.termH")) ||
      Math.max(220, Math.round(window.innerHeight * 0.35)),
  );
  const liveTerms = new Map<string, TermSession>();
  let termSeq = 0;
  const paneHosts: (HTMLDivElement | null)[] = [null, null];

  const activeTab = () =>
    termTabs()[focusedPane() === 0 ? paneL() : paneR()] ?? null;

  function focusTab(i: number) {
    const tab = termTabs()[i];
    if (!tab) return;
    const focused = focusedPane();
    const mineIdx = focused === 0 ? paneL() : paneR();
    const otherIdx = focused === 0 ? paneR() : paneL();
    const setMine = (v: number) => (focused === 0 ? setPaneL(v) : setPaneR(v));
    const setOther = (v: number) => (focused === 0 ? setPaneR(v) : setPaneL(v));
    if (otherIdx === i) {
      setOther(mineIdx);
      setMine(i);
      return;
    }
    if (mineIdx !== i) setMine(i);
  }

  const addFromSelected = () => addTab();

  async function addTab(agentId?: string) {
    const who = agentId ?? selected();
    if (!who) return;
    if (termTabs().filter((t) => t.agentId === who).length >= 10) {
      flashHint(`max 10 shells per agent (${who}) — that's already a lot`);
      return;
    }
    try {
      const r = (await api("/api/terminals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: who }),
      })) as { terminal?: { id: string; agentId: string; title: string } };
      const t = r.terminal;
      if (!t) {
        flashHint("could not open a shell");
        return;
      }
      const at = indexAfterAppend(termTabs());
      setTermTabs((list) => [...list, { key: t.id, agentId: t.agentId, title: t.title }]);
      if (focusedPane() === 0) setPaneL(at);
      else setPaneR(at);
    } catch (ex) {
      flashHint(`could not open a shell: ${(ex as Error).message}`);
    }
  }

  function closeTab(i: number) {
    const tab = termTabs()[i];
    if (!tab) return;
    void api(`/api/terminals/${encodeURIComponent(tab.key)}`, { method: "DELETE" }).catch(() => {});
    const s = liveTerms.get(tab.key);
    if (s) {
      s.ro?.disconnect();
      try { s.ws.close(); } catch {  }
      s.term.dispose();
      liveTerms.delete(tab.key);
    }
    const rest = termTabs().filter((_, j) => j !== i);
    setTermTabs(rest);
    setPaneL((p) => paneIndexAfterClose(p, i, rest.length));
    setPaneR((p) => (p === -1 ? -1 : paneIndexAfterClose(p, i, rest.length)));
  }

  createEffect(() => {
    void themeAuto();
    void fixedTheme();
    void sysPrefersLight();
    void sysLightTheme();
    void sysDarkTheme();
    for (const [, s] of liveTerms) retintTerminal(s.term);
  });

  function disposeAllTerms() {
    for (const [, s] of liveTerms) {
      s.ro?.disconnect();
      try { s.ws.close(); } catch {  }
      s.term.dispose();
    }
    liveTerms.clear();
  }

  function ensureSession(tab: TermTab, host: HTMLElement): TermSession {
    let s = liveTerms.get(tab.key);
    if (s) retintTerminal(s.term);
    if (!s) {
      const el = document.createElement("div");
      el.className = "termsession";
      host.appendChild(el);
      const t = new Terminal({
        cursorBlink: true,
        fontSize: 12.5,
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        theme: themeColors(),
      });
      const f = new FitAddon();
      t.loadAddon(f);
      t.open(el);
      const proto = location.protocol === "https:" ? "wss://" : "ws://";
      const termUrl = () =>
        `${proto}${location.host}/api/agents/${encodeURIComponent(tab.agentId)}/term?terminal=${encodeURIComponent(tab.key)}${wsTokenQuery()}`;
      let w = new WebSocket(termUrl());
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let permanent = false;
      const wire = (sock: WebSocket) => {
        sock.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.kind === "data") t.write(msg.data);
          else if (msg.kind === "ping") {
          } else if (msg.kind === "exit") {
            permanent = true;
            t.write(`\r\n\x1b[2m[terminal exited ${msg.code ?? ""}]\x1b[0m\r\n`);
            setTermTabs((list) => list.filter((x) => x.key !== tab.key));
            liveTerms.get(tab.key)?.term.dispose();
            liveTerms.delete(tab.key);
          } else if (msg.kind === "attach" && msg.error) {
            permanent = true;
            t.write(`\r\n\x1b[2m[${msg.error}]\x1b[0m\r\n`);
          }
        };
        sock.onclose = () => {
          if (permanent || !liveTerms.has(tab.key)) return; 
          if (reconnectTimer) return;
          t.write(`\r\n\x1b[2m[connection lost — reconnecting…]\x1b[0m\r\n`);
          reconnectTimer = setTimeout(function again() {
            reconnectTimer = undefined;
            if (!liveTerms.has(tab.key)) return; 
            const next = new WebSocket(termUrl());
            w = next;
            wire(next);
            next.addEventListener("open", () => pushResize());
          }, 1500);
        };
      };
      wire(w);
      t.onData((d: string) => {
        if (w.readyState === WebSocket.OPEN) w.send(JSON.stringify({ kind: "input", data: d }));
      });
      let last = { cols: 0, rows: 0 };
      let pendingRetry: ReturnType<typeof setInterval> | undefined;
      const resizeTimer: ReturnType<typeof setTimeout>[] = [];
      const pushResize = () => {
        try { f.fit(); } catch {  }
        if (w.readyState !== WebSocket.OPEN) {
          scheduleRetry();
          return;
        }
        if (t.cols !== last.cols || t.rows !== last.rows) {
          last = { cols: t.cols, rows: t.rows };
          w.send(JSON.stringify({ kind: "resize", cols: t.cols, rows: t.rows }));
        }
      };
      function scheduleRetry() {
        if (pendingRetry) return;
        pendingRetry = setInterval(() => {
          if (!liveTerms.has(tab.key)) {
            clearInterval(pendingRetry);
            pendingRetry = undefined;
            return;
          }
          if (w.readyState === WebSocket.OPEN) {
            clearInterval(pendingRetry);
            pendingRetry = undefined;
            pushResize();
          }
        }, 400);
      };
      w.addEventListener("open", () => pushResize());
      const measureEl = el.parentElement ?? el;
      const ro = new ResizeObserver(() => {
        if (resizeTimer[0]) clearTimeout(resizeTimer[0]);
        resizeTimer[0] = setTimeout(pushResize, 250);
      });
      ro.observe(measureEl);
      if (measureEl !== el) ro.observe(el); 
      setTimeout(pushResize, 60);
      s = { el, term: t, fit: f, ws: w, ro };
      liveTerms.set(tab.key, s);
    } else if (s.el.parentElement !== host) {
      host.appendChild(s.el); 
      setTimeout(() => { try { s!.fit(); } catch {  } }, 30);
    }
    return s;
  }

  function mountPane(idx: number) {
    const host = paneHosts[idx];
    if (!host) return;
    const tab = termTabs()[idx === 0 ? paneL() : paneR()];
    if (!tab) {
      const owned = [...liveTerms.values()].some((t) => t.el.parentElement === host);
      if (owned) host.replaceChildren();
      return;
    }
    const s = ensureSession(tab, host);
    for (const [key, other] of liveTerms) {
      if (key !== tab.key && other.el.parentElement === host) other.el.remove();
    }
    requestAnimationFrame(() => {
      if (s.el.parentElement !== host) host.appendChild(s.el);
      try { s.fit(); } catch {  }
      if (focusedPane() === (idx === 0 ? 0 : 1)) {
        try { s.term.focus(); } catch {  }
      }
    });
  }

  createEffect(() => {
    void termTabs();
    void splitView();
    void paneL();
    void paneR();
    void termHeight();
    requestAnimationFrame(() => {
      mountPane(0);
      if (splitView()) mountPane(1);
    });
  });

  let _termFollowAgent: string | null = null;
  createEffect(() => {
    if (!termOpen()) return;
    const id = selected();
    if (!id) return;
    if (id === _termFollowAgent) return;
    _termFollowAgent = id;
    const mine = termTabs()
      .map((t, i) => ({ t, i }))
      .filter((x) => x.t.agentId === id);
    if (mine.length) {
      focusTab(mine[mine.length - 1]!.i);
    }
  });

  createEffect(() => {
    const n = termTabs().length;
    const l = clampPaneIndex(paneL(), n);
    if (l !== paneL()) setPaneL(l);
    if (splitView()) {
      const r = clampPaneIndex(paneR(), n);
      if (r !== paneR()) setPaneR(r);
    }
  });

  const startGrip = (e: PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = termHeight();
    const move = (ev: PointerEvent) => {
      const h = Math.min(Math.max(startH - (ev.clientY - startY), 140), Math.round(window.innerHeight * 0.85));
      setTermHeight(h);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem("teapot.termH", String(termHeight()));
      requestAnimationFrame(() => { mountPane(0); if (splitView()) mountPane(1); });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toggleSplit = () => {
    const next = !splitView();
    setSplitView(next);
    if (next) {
      if (paneR() < 0 || paneR() === paneL() || paneR() >= termTabs().length) {
        setPaneR(rightPaneSeed(paneL(), termTabs().length));
      }
    }
    requestAnimationFrame(() => { mountPane(0); if (splitView()) mountPane(1); });
  };

  onCleanup(disposeAllTerms);

  const setPaneHost = (idx: number) => (el: HTMLDivElement) => {
    paneHosts[idx] = el;
    if (el) requestAnimationFrame(() => {
      mountPane(idx);
      if (splitView()) mountPane(1);
      setTimeout(() => mountPane(idx), 200);
    });
  };

  onMount(() => {
    loadCfg();
    refreshAgents().then(async () => {
      await refreshSessionIndex();
      const want = pathId();
      const owner = want ? masterSessionIndex().get(want) : undefined;
      const initial =
        (owner ? agents().find((a) => a.id === owner) : undefined) ??
        agents().find((a) => a.id === want && !masterSessionIndex().has(want)) ??
        agents().find((a) => a.id === localStorage.getItem("teapot.session")) ??
        agents()[0];
      if (initial) select(initial.id, false, want || null);
    });
    refreshMetrics();
    loadTasks();
    loadPersonas();
    connectWs();
    void api("/api/terminals")
      .then((r: { terminals?: { id: string; agentId: string; title: string }[] }) => {
        const list = r.terminals ?? [];
        if (!list.length) return;
        setTermTabs(list.map((t) => ({ key: t.id, agentId: t.agentId, title: t.title })));
        if (termOpen()) {
          setPaneL(0);
          setPaneR(-1);
        }
      })
      .catch(() => {
      });
    onCleanup(() => {});
  });

  const SLASH_COMMANDS = [
    { cmd: "/start", desc: "start working toward the goal" },
    { cmd: "/stop", desc: "interrupt the running agent" },
    { cmd: "/fork", desc: "branch the conversation here" },
    { cmd: "/goal", desc: "/goal <text> — set goal & notify the agent" },
    { cmd: "/compact", desc: "force a context compaction now" },
    { cmd: "/skill", desc: "/skill <name> — force-load a skill and follow it" },
  ];

  const [personas, setPersonas] = createSignal<{ key: string; label: string }[]>([]);
  const loadPersonas = () => api("/api/personas").then((d) => setPersonas(d.personas)).catch(() => {});
  const [mentionFork, setMentionFork] = createSignal(false);
  const mentionQuery = () => {
    const m = draft().match(/^@([A-Za-z0-9._-]*)$/);
    return m ? m[1]!.toLowerCase() : null;
  };
  const mentionMatches = () => {
    const q = mentionQuery();
    if (q === null) return [];
    const list = [
      ...personas().map((p) => ({ key: p.key, label: `${p.label} — spawns a sub-agent`, kind: "persona" as const })),
      ...agents()
        .filter((a) => a.id !== selected())
        .map((a) => ({ key: a.id, label: `${a.status} — send directly`, kind: "agent" as const })),
    ];
    return list.filter((x) => x.key.toLowerCase().startsWith(q));
  };
  // oxlint-disable-next-line no-unused-vars
  const filteredCmds = () => {
    const d = draft();
    if (!d.startsWith("/") || d.includes(" ") || d.includes("\n")) return [];
    return SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(d.slice(1).toLowerCase()));
  };

  type Suggest = { insert: string; title: string };
  const NO_ARG_COMMANDS = new Set(["start", "stop", "fork", "compact"]);
  const [agentSkills, setAgentSkills] = createSignal<{ name: string; description: string }[]>([]);
  const [features, setFeatures] = createSignal<{
    imageResize: { available: boolean; tool: string | null; maxEdge: number; found: { name: string; present: boolean }[] };
    pty: { available: boolean; provider: string | null };
  } | null>(null);
  const [cmdIdx, setCmdIdx] = createSignal(-1);
  const suggestions = (): Suggest[] => {
    const d = draft();
    if (!d.startsWith("/") || d.includes("\n")) return [];
    const m = d.match(/^\/([a-z]*)(?:\s+(.*))?$/i);
    if (!m) return [];
    const cmdName = m[1]!.toLowerCase();
    const argPart = (m[2] ?? "").trim();
    if (!argPart && cmdName !== "skill") {
      const rows = SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(cmdName));
      const exact = rows.find((c) => c.cmd.slice(1) === cmdName);
      if (exact && NO_ARG_COMMANDS.has(cmdName)) return [];
      return rows.map((c) => ({ insert: c.cmd + " ", title: c.desc }));
    }
    if (cmdName === "skill") {
      let rows = agentSkills().filter((s) => s.name.toLowerCase().startsWith(argPart.toLowerCase()));
      if (rows.length === 1 && rows[0]!.name.toLowerCase() === argPart.toLowerCase()) return [];
      return rows.map((s) => ({ insert: `/skill ${s.name} `, title: s.description || "(bundled skill)" }));
    }
    return [];
  };
  // oxlint-disable-next-line no-unassigned-vars
  let composerEl: HTMLTextAreaElement | undefined;
  let composerMirror: HTMLDivElement | undefined;
  let composerMirrorHost: HTMLDivElement | undefined;
  let composerMirrorStyleAdded = false;
  function measureComposerContent(el: HTMLTextAreaElement): number {
    if (!composerMirror) {
      composerMirror = document.createElement("div");
      composerMirror.setAttribute("aria-hidden", "true");
      const s = composerMirror.style;
      s.position = "absolute";
      s.visibility = "hidden";
      s.pointerEvents = "none";
      s.top = "0";
      s.left = "-9999px";
      s.whiteSpace = "pre-wrap";
      s.overflowWrap = "anywhere";
      s.wordBreak = "break-word";
      composerMirror.dataset.mirror = "";
    }
    const cs = getComputedStyle(el);
    for (const prop of [
      "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
      "padding-top", "padding-bottom", "padding-left", "padding-right",
      "border-top-width", "border-bottom-width", "box-sizing",
    ]) {
      composerMirror.style.setProperty(prop, cs.getPropertyValue(prop));
    }
    composerMirror.style.width = `${el.clientWidth}px`;
    composerMirror.setAttribute("data-mirror-text", el.value.endsWith("\n") ? `${el.value} ` : el.value);
    if (!composerMirrorHost) {
      composerMirrorHost = document.createElement("div");
      composerMirrorHost.setAttribute("aria-hidden", "true");
      composerMirrorHost.style.cssText =
        "position:absolute;left:-9999px;top:0;pointer-events:none";
      document.body.appendChild(composerMirrorHost);
    }
    if (composerMirror.parentElement !== composerMirrorHost) composerMirrorHost.appendChild(composerMirror);
    if (!composerMirrorStyleAdded) {
      const style = document.createElement("style");
      style.textContent = '[data-mirror]::after{content:attr(data-mirror-text);white-space:pre-wrap;display:block}';
      document.head.appendChild(style);
      composerMirrorStyleAdded = true;
    }
    return composerMirror.scrollHeight;
  }
  let lastAppliedContentH = 0;
  const autosizeComposer = () => {
    if (!composerEl) return;
    const maximized = composerMaximized();
    if (!composerEl.value && !maximized) {
      composerEl.style.height = "";
      lastAppliedContentH = 0;
      return;
    }
    const contentH = measureComposerContent(composerEl);
    const wanted = maximized ? -1 : composerHeight(contentH, MAX_COMPOSER_H);
    composerEl.style.height = wanted === -1 ? "" : `${wanted}px`;
    lastAppliedContentH = contentH;
  };
  let lastSample: TailSample | undefined;
  let ledger: { top: number; height: number } | null = null;
  let lastSampleHeight: number | undefined;
  const RESYNC_BUDGET_PER_GESTURE = 4;
  const RESYNC_MAX_DELTA_PX = 240;
  let resyncBudget = RESYNC_BUDGET_PER_GESTURE;
  let lastSampleViewport: number | undefined;
  createEffect(() => {
    const v = draft(); 
    if (!composerEl) return;
    if (!shouldWriteComposerValue(imeInProgress)) return;
    if (composerValueChanged(composerEl.value, v)) composerEl.value = v;
    autosizeComposer();
  });
  onMount(() => {
    let pending = 0;
    const onResize = () => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        autosizeComposer();
      });
    };
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      if (pending) cancelAnimationFrame(pending);
    });
  });

  const [pendingImages, setPendingImages] = createSignal<{ url: string; name: string }[]>([]);
  const addImages = (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    for (const f of list) {
      if (f.size > 8_000_000) {
        flashHint(`"${f.name}" is over 8 MB — skipped`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setPendingImages((prev) =>
          [...prev, { url: String(reader.result), name: f.name }].slice(0, 4),
        );
      };
      reader.readAsDataURL(f);
    }
  };
  const sendText = async (text: string, targetId?: string, source?: "harness") => {
    const id = targetId ?? selected();
    if (!id) return;
    const images = pendingImages();
    const echoKey = agents().find((a) => a.id === id)?.session || id;
    try {
      const r = await api(`/api/agents/${id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, start: true, ...(source ? { source } : {}), ...(images.length ? { images } : {}) }),
      });
      writePending(echoKey, [
        ...pendingFor(echoKey),
        {
          id: `@p${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          text,
          at: Date.now(),
          promptId: (r as any).promptId,
          ...(images.length ? { images: images.map((i) => i.url) } : {}),
        },
      ]);
      setPendingImages([]);
      if (shouldRestoreAfterSend(composerMaximized())) setComposerMaximized(false);
      autosizeComposer();
      if (atBottom()) {
        requestAnimationFrame(() => {
          if (atBottom()) pinToTail();
        });
      }
    } catch (ex) {
      saveDraft(text); 
      console.error("send failed:", ex);
    }
  };

  const send = async (e: Event) => {
    e.preventDefault();
    const id = selected();
    const text = draft().trim();
    if (!id || !text) return;

    if (text.startsWith("@")) {
      const sp = text.indexOf(" ");
      const name = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
      const arg = sp === -1 ? "" : text.slice(sp + 1).trim();
      const isPersona = personas().some((p) => p.key.toLowerCase() === name);
      const knownAgent = agents().some((a) => a.id.toLowerCase() === name);
      try {
        if (isPersona) {
          if (!arg) { flashHint(`usage: @${name} <task>`); return; }
          const r = await api(`/api/agents/${selected()}/spawn`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ persona: name, task: arg, context: mentionFork() ? "fork" : "none" }),
          });
          flashHint(`🧩 spawned ${(r as any).id}${mentionFork() ? " (forked context)" : ""}`);
          refreshAgents(); saveDraft("");
        } else if (knownAgent) {
          if (!arg) { flashHint(`usage: @${name} <message>`); return; }
          await api(`/api/agents/${encodeURIComponent(name)}/prompt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: arg, start: true }),
          });
          flashHint(`→ delivered to @${name}`);
          saveDraft("");
        } else {
          flashHint(`unknown @${name} — personas: ${personas().map((p) => p.key).join(", ") || "(none)"}`);
          return;
        }
      } catch (ex) {
        flashHint(`@${name} failed: ${(ex as Error).message}`);
      }
      return;
    }

    if (text.startsWith("/")) {
      const sp = text.indexOf(" ");
      const name = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
      const arg = sp === -1 ? "" : text.slice(sp + 1).trim();
      if (name === "goal" && !arg) { saveDraft("/goal "); return; } 
      if (name === "skill" && !arg) { saveDraft("/skill "); return; }
      saveDraft("");
      try {
        await executeSlash(name, arg);
      } catch (ex) {
        saveDraft(draft() ? `${text}\n${draft()}` : text);
        throw ex;
      }
      return;
    }

    saveDraft("");
    await sendText(text);
  };

  const executeSlash = async (name: string, arg: string): Promise<void> => {
    const id = selected();
    if (!id) return;
    const post = (p: string, body?: unknown) =>
      api(`/api/agents/${id}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }).then(refreshAgents);
    try {
      if (name === "start") await post("/start");
      else if (name === "stop") await post("/stop");
      else if (name === "fork") { await post("/fork", {}); await select(id); }
      else if (name === "compact") {
        const r: any = await post("/compact");
        flashHint(r?.ran ? "context compacted" : "nothing to compact yet");
      }
      else if (name === "goal") {
        if (!arg) { flashHint("usage: /goal <text>"); return; }
        await post("/goal", { text: arg, notify: true });
        flashHint("goal saved & notification queued");
      }
      else if (name === "skill") {
        if (!arg) { flashHint("usage: /skill <name>"); return; }
        await sendText(
          `[harness] Force-load and follow the skill "${arg}" now: call load_skill("${arg}") and execute its playbook for the current task.`,
          undefined,
          "harness",
        );
        flashHint(`skill "${arg}" dispatched`);
      }
      else {
        flashHint(`unknown command "${name}" — /start /stop /fork /goal /skill /compact`);
      }
    } catch (ex) {
      flashHint(`/${name} failed: ${(ex as Error).message}`);
    }
  };

  let rightbarEl: HTMLDivElement | undefined;
  let rightbarTop = 0;
  createEffect(() => {
    agents(); 
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!rightbarEl) return;
        const target = Math.min(rightbarTop, rightbarEl.scrollHeight);
        if (Math.abs(rightbarEl.scrollTop - target) > 1) rightbarEl.scrollTop = target;
      });
    });
  });
  const act = (path: string) =>
    () => selected() && api(`/api/agents/${selected()}${path}`, { method: "POST" }).then(refreshAgents);

  const archiveSelected = async () => {
    const id = selected();
    if (!id) return;
    const doomed = new Set([id, ...descendantsOf(agents(), id).map((a) => a.id)]);
    const subs = doomed.size - 1;
    if (
      !confirm(
        `archive agent ${id}?\n\n` +
          (subs > 0 ? `Its ${subs} sub-agent${subs === 1 ? "" : "s"} will be archived too.\n\n` : "") +
          "They stop running and leave the list, but the config and full session history are " +
          "KEPT — restore any of them from ⚙️ settings → archive.",
      )
    )
      return;
    await api(`/api/agents/${id}/archive`, { method: "POST" }).catch(() => {});
    setAgents(agents().filter((a) => !doomed.has(a.id)));
    void refreshSessionIndex(true);
    const next = pickAfterArchive(agents(), doomed);
    if (next) select(next.id);
    else {
      setSelected(null);
      setEvents([]);
    }
  };

  const stopChildren = async () => {
    if (!selected()) return;
    const r = await api(`/api/agents/${selected()}/stop-children`, { method: "POST" });
    flashHint(`stopped: ${((r as any).stopped ?? []).join(", ") || "(none)"}`);
    refreshAgents();
  };

  const forkSelected = () =>
    api(`/api/agents/${sel()!.id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then(async () => {
      await refreshSessionIndex(true);
      await select(sel()!.id);
    });

  const [goalDraft, setGoalDraft] = createSignal("");
  const [goalHeight, setGoalHeight] = createSignal(storedTextareaHeight("goal"));
  const [goalPreviewHeight, setGoalPreviewHeight] = createSignal(storedTextareaHeight("goalPreview"));
  const goalPreviewStyle = (): Record<string, string> => {
    const base: Record<string, string> = {
      "max-height": "none",
      "overflow-y": "auto",
      resize: "vertical",
    };
    if (goalPreviewHeight() > 0) base.height = `${goalPreviewHeight()}px`;
    return base;
  };
  const trackGoalPreviewHeight = (el: HTMLElement) => {
    const stop = trackTextareaHeight(el, (h) => {
      setGoalPreviewHeight((cur) => {
        if (Math.abs(cur - h) < 1) return cur;
        rememberTextareaHeight("goalPreview", h);
        return h;
      });
    });
    onCleanup(stop);
  };
  const goalHeightStyle = () => (goalHeight() > 0 ? { height: `${goalHeight()}px` } : undefined);
  const trackGoalHeight = (el: HTMLTextAreaElement) => {
    const stop = trackTextareaHeight(el, (h) => {
      setGoalHeight((cur) => {
        if (Math.abs(cur - h) < 1) return cur;
        rememberTextareaHeight("goal", h);
        return h;
      });
    });
    onCleanup(stop);
  };
  const [goalVerifyDraft, setGoalVerifyDraft] = createSignal("");
  const [_goalDirty, setGoalDirty] = createSignal(false);
  const [goalNotify, setGoalNotify] = createSignal(true);
  let goalSeededFor = "";
  createEffect(() => {
    const id = selected();
    if (!id) return;
    const g = sel()?.goal;
    if (id !== goalSeededFor) {
      goalSeededFor = id; 
      setGoalDirty(false);
      setGoalDraft("");
      setGoalVerifyDraft("");
      void g; 
    }
  });
  const setGoal = async (e: Event) => {
    e.preventDefault();
    if (!selected() || !goalDraft().trim()) return;
    try {
      await api(`/api/agents/${selected()}/goal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: goalDraft(),
          notify: goalNotify(),
          ...(goalVerifyDraft().trim() ? { verify: goalVerifyDraft() } : {}),
        }),
      });
      setGoalDraft("");
      setGoalVerifyDraft("");
      setGoalDirty(false);
      refreshAgents();
    } catch (ex) {
      flashHint(`goal save failed: ${(ex as Error).message}`);
    }
  };

  return (
    <>
    <Show when={authLocked()}>
      <div class="overlay">
        <div class="modal" style="max-width:360px">
          <div class="modal-head"><b>🔒️ sign in</b><span /></div>
          <form
            onsubmit={(e) => {
              e.preventDefault();
              const el = document.getElementById("pw-input") as HTMLInputElement;
              localStorage.setItem("teapot.token", el.value);
              location.reload();
            }}
            style="display:flex;flex-direction:column;gap:10px"
          >
            <input id="pw-input" type="password" placeholder="password" autofocus />
            <button type="submit" class="primarybtn">unlock</button>
            <span class="muted" style="font-size:11px">the token is stored locally and sent as Bearer to this server only</span>
          </form>
        </div>
      </div>
    </Show>
    {}
    <Show when={activeBgImage()}>
      {(src) => (
        <div class="bgphoto" aria-hidden="true">
          <img
            src={bgSrc(src(), BG_WIDTHS[BG_WIDTHS.length - 1])}
            srcset={bgSrcSet(src())}
            sizes="100vw"
            alt=""
            decoding="async"
          />
          <span class="bgphoto-veil" />
        </div>
      )}
    </Show>
    <div class={"layout" + (showRight() ? "" : " right-hidden") + (showLeft() ? " left-open" : "")}>
      {}
      <Show when={narrow() && showLeft()}>
        <div class="leftbarbackdrop" onclick={closeLeft} />
      </Show>
      {}
      <nav class={"sidebar" + (showLeft() ? " open" : "")}>
        {}
        <Show when={narrow()}>
          <div class="sidehead">
            <b>agents</b>
            <button class="iconbtn" title="close the agent list" onclick={closeLeft}>✕</button>
          </div>
        </Show>
        <div class="agent-list">
          <For each={sidebarRows()}>
            {(row) => (
              <>
              {}
              <Show when={row.wsHeader !== undefined && row.wsHeader !== ""}>
                <div
                  class="wsheader"
                  title={
                    row.wsCollapsedGroup
                      ? `${row.wsHeader} — collapsed (${wsCountLabel(row.wsHeader!)} hidden). Click to show.`
                      : (wsChatCounts().get(row.wsHeader!) ?? 0) > 1
                        ? `${row.wsHeader} — ${wsCountLabel(row.wsHeader!)} in this directory`
                        : row.wsHeader || ""
                  }
                  onclick={() => toggleWsGroup(`ws:${row.wsHeader}`, basenameOf(row.wsHeader!), row.wsCollapsedGroup === true, row.collapsedVia)}
                ><span class="wscaret">{row.wsCollapsedGroup ? "▸" : "▾"}</span>{basenameOf(row.wsHeader!)}
                  {}
                  <Show when={(wsChatCounts().get(row.wsHeader!) ?? 0) > 1 || row.wsCollapsedGroup}>
                    <span class="wscount">{wsChatCounts().get(row.wsHeader!) ?? 0}</span>
                  </Show>
                </div>
              </Show>
              {}
              {}
              <Show when={!row.headerOnly && !row.wsCollapsedGroup}>
              <div
                class={"agent-item" + (row.a.id === selected() ? " sel" : "") + (row.depth > 0 ? " sub-row" : "") + (row.chatCollapsedGroup ? " collapsed" : "")}
                style={row.depth > 0 ? `padding-left:${10 + row.depth * 14}px` : ""}
                // a COLLAPSED chat must be selectable. What made it read as
                // unselectable was its APPEARANCE — `opacity: .5` plus
                // `cursor: default`, so a collapsed parent looked greyed out and
                // disabled. That was a styling bug, and it is fixed in the CSS:
                // the name is full-contrast and the row keeps `cursor: pointer`.
                //
                // an earlier version of this ALSO expanded the chat on
                // select. That was my over-correction — the operator's collapse
                // state is theirs, and forcing it open on every visit made the
                // sub-agent list impossible to keep out of the way. Clicking the
                // row now only selects; the CARET is the control that expands,
                // and both directions remain reversible.
                onclick={() => select(row.a.id)}
                title={
                  row.a.parent
                    ? 
                      (() => {
                        const named = subAgentDisplayName(row.a.id, personas().map((p) => p.key));
                        return named
                          ? `sub-agent of @${row.a.parent} — "${named}"`
                          : `sub-agent of @${row.a.parent}`;
                      })()
                    : undefined
                }
              >
                {}
                {}
                <Show
                  when={shouldShowCollapseCaret({
                    isSub: !!row.a.parent,
                    collapsed: row.chatCollapsedGroup === true,
                    hasChildren: agents().some((x) => x.parent === row.a.id),
                  })}
                  fallback={<span class="caret-spacer" />}
                >
                  {(() => {
                    const isChat = !row.a.parent;
                    const off = isChat
                      ? chatCollapsed().has(`chat:${row.a.id}`) || subsCollapsed(row.a.id)
                      : subsCollapsed(row.a.id);
                    return (
                      <span
                        class="caret"
                        title={
                          isChat
                            ? off
                              ? `show ${row.a.id}`
                              : `hide ${row.a.id} and its sub-agents`
                            : off
                              ? "expand sub-agents"
                              : "collapse sub-agents"
                        }
                        onclick={(e: MouseEvent) => {
                          e.stopPropagation();
                          if (isChat) {
                            if (off) {
                              if (!expandedSubs().has(row.a.id)) {
                                const next = new Set(expandedSubs());
                                next.add(row.a.id);
                                setExpandedSubs(next);
                                localStorage.setItem("teapot.expandedSubs", JSON.stringify([...next]));
                              }
                              if (collapsedSubs().has(row.a.id)) {
                                const next = new Set(collapsedSubs());
                                next.delete(row.a.id);
                                setCollapsedSubs(next);
                                localStorage.setItem("teapot.collapsed", JSON.stringify([...next]));
                              }
                            } else if (expandedSubs().has(row.a.id)) {
                              const next = new Set(expandedSubs());
                              next.delete(row.a.id);
                              setExpandedSubs(next);
                              localStorage.setItem("teapot.expandedSubs", JSON.stringify([...next]));
                            }
                            toggleWsGroup(`chat:${row.a.id}`, row.a.id, off);
                          } else toggleCollapse(row.a.id);
                        }}
                      >{off ? "▸" : "▾"}</span>
                    );
                  })()}
                </Show>
                {}
                <span
                  class={`dot ${row.a.status}`}
                  title={
                    row.a.status === "needs_operator"
                      ? "waiting for your answer"
                      : row.a.status === "waiting"
                        ? "waiting on its own work — resumes by itself"
                        : row.a.status
                  }
                />
                <span
                  class={row.a.workspaceMissing ? " ghost" : ""}
                  title={
                    row.a.workspaceMissing
                      ? `workspace not found on disk (${row.a.workspace}) — it will be created when this session runs`
                      : agentLabelWithId({ id: row.a.id, sessionTitle: row.a.sessionTitle ?? sessionTitles().get(row.a.session ?? "") })
                  }
                >{agentLabel({ id: row.a.id, sessionTitle: row.a.sessionTitle ?? sessionTitles().get(row.a.session ?? "") })}</span>
                {row.a.workspaceMissing ? <span class="ghosttag" title="workspace missing">👻</span> : null}
                <Show when={subtreeUnread(row.a.id) > 0}>
                  <span class="notifbadge" title={`${subtreeUnread(row.a.id)} unread notification${subtreeUnread(row.a.id) > 1 ? "s" : ""} (including sub-agents)`}>
                    🔔️{subtreeUnread(row.a.id)}
                  </span>
                </Show>
                {}
                <Show
                  when={
                    subsCollapsed(row.a.id) ||
                    (row.chatCollapsedGroup === true && chatCollapsed().has(`chat:${row.a.id}`))
                  }
                >
                  {(() => {
                    const kids = descendantsOf(agents(), row.a.id);
                    const running = kids.filter(
            (k) => k.live ?? (k.status === "running" || k.status === "waiting" || k.status === "needs_operator"),
          ).length;
                    return kids.length > 0 ? (
                      <span
                        class={"subcount" + (running > 0 ? " live" : "")}
                        title={`${kids.length} sub-agent${kids.length > 1 ? "s" : ""} (${running} active)`}
                      >
                        🧩 {kids.length}{running > 0 ? ` · ▶${running}` : ""}
                      </span>
                    ) : null;
                  })()}
                </Show>
                <Show when={row.a.parent}><span class="subtag">🧩</span></Show>
                <Show when={agentTasks(row.a.id).length > 0}>
                  <span class="mini-cron" title={agentTasks(row.a.id).map((t) => `${t.id}: ${t.schedule}`).join("\n")}>⏰</span>
                </Show>
                <Show when={row.a.goal.status === "done"}><span class="goaldone" title="goal done">✓</span></Show>
              </div>
              </Show>
              </>
            )}
          </For>
        </div>
        <div class="sidebar-footer">
          {}
          <div class="footer-row" style="justify-content:flex-end">
            <button
              class={"iconbtn notifbtn" + (unreadCount() > 0 ? " has-unread" : "")}
              title={unreadCount() > 0 ? `${unreadCount()} unread notifications` : "notifications"}
              onclick={(e: MouseEvent) => {
                e.stopPropagation();
                setShowNotifs(!showNotifs());
                if (!showNotifs()) setNotifs((l) => l.map((n) => ({ ...n, read: true })));
              }}
            >
              🔔️<Show when={unreadCount() > 0}><i class="notifdot">{unreadCount()}</i></Show>
            </button>
            <IconBtn
              icon="👻"
              active={hideGhosts()}
              title={hideGhosts() ? "show ghost sessions again (👻 workspace missing on disk)" : "hide ghost sessions (👻 — their workspace directory no longer exists)"}
              onClick={(e) => {
                e.stopPropagation();
                const next = !hideGhosts();
                setHideGhosts(next);
                localStorage.setItem("teapot.hideGhosts", next ? "1" : "0");
                if (next && selected() && sel()?.workspaceMissing) {
                  const firstVisible = agents().find((a) => !a.workspaceMissing);
                  if (firstVisible) select(firstVisible.id);
                }
              }}
            />
            <IconBtn icon="＋" title="new agent" onClick={() => { loadCfg(); setShowNew(true); }} />
            {}
            <IconBtn icon="⚙️" title="settings" onClick={() => { loadCfg(); setShowCfg(true); }} />
          </div>
          <div class="brand-row">
            <div class="brand">
              🫖 teapot <span class="version">v{__APP_VERSION__}</span>
              <span class={"conn" + (connected() ? " ok" : "")} title={connected() ? "live (websocket)" : "reconnecting…"} />
            </div>
          </div>
          <div class="metrics">
            <Show when={metrics()}>
              {}
              master rss {metrics().rssMb}MB · heap {metrics().heapUsedMb}MB
              <Show when={metrics().heapTotalMb !== undefined}> · total {metrics().heapTotalMb}MB</Show>
              <Show when={metrics().externalMb !== undefined}> · ext {metrics().externalMb}MB</Show>
              <br />
              load1 {metrics().loadavg1} · up {Math.floor(metrics().uptimeSec / 60)}m
            </Show>
          </div>
        </div>
      </nav>

      {}
      <section class="channel" style={{ "--termh": `${termHeight()}px` } as any}>
        {}
        <Show when={sel()?.id} keyed fallback={<div style="display:grid;place-items:center;height:100%" class="muted">select an agent</div>}>
          <header class="chan-head">
            {}
            <Show when={narrow()}>
              <button
                class="iconbtn ham"
                title="agent list"
                aria-expanded={showLeft()}
                onclick={() => setShowLeft(!showLeft())}
              >☰</button>
            </Show>
            <span class="hash" title="rename this chat" onclick={() => beginRename()}>#</span>
            {}
            <Show
              when={renaming()}
              fallback={
                <span class="title" title={`${agentLabelWithId(sel(), sel()!.session)} — click to rename`} onclick={() => beginRename()}>
                  {agentLabel(sel())}
                </span>
              }
            >
              <input
                class="title titleedit"
                value={renameDraft()}
                ref={(el) => {
                  requestAnimationFrame(() => {
                    el.focus();
                    el.select();
                  });
                }}
                oninput={(e) => setRenameDraft(e.currentTarget.value)}
                onkeydown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setRenaming(false);
                  }
                }}
                onblur={() => void commitRename()}
                spellcheck={false}
              />
            </Show>
            {}
            <span
              class={`badge ${sel()!.status}`}
              title={
                sel()!.statusReason && !/^(round complete|prompt|api start|goal set|created via web|start)$/.test(sel()!.statusReason)
                  ? `${sel()!.status} — ${sel()!.statusReason}`
                  : undefined
              }
            >
              {sel()!.status}
            </span>
            <Show when={queuedCount() > 0}>
              <span
                class="badge queued"
                title={(() => {
                  const q = sel()!.pendingPromptQueue ?? [];
                  const n = q.length || sel()!.pendingPromptIds?.length || sel()!.pendingPrompts || 0;
                  const mine = q.length ? q.filter((x) => (x.source ?? "user") === "user").length : n;
                  const harness = n - mine;
                  const label = `${n} message${n > 1 ? "s" : ""} queued${harness ? ` — ${mine} from you, ${harness} from the harness` : " from you"}`;
                  const stopped = sel()!.status === "stopped";
                  return (
                    `${label}. ${stopped ? "This agent is STOPPED, so nothing will run until you press start (or it is resumed)." : "They are handed to the model at its next turn boundary — the timeline shows them as queued… until then."}` +
                    (mine ? " Yours can be withdrawn with ✕ cancel while still queued." : "")
                  );
                })()}
              >
                {}
                ⏳ {queuedCount()} {queuedCount() === 1 ? "message" : "messages"} queued
                {sel()!.status === "stopped" ? " (stopped)" : ""}
              </span>
            </Show>
            {}
            <Show when={bgJobs().length > 0}>
              <button
                type="button"
                class="badge bgjobs"
                aria-expanded={showBg()}
                onclick={() => {
                  setShowBg(!showBg());
                  if (showBg()) void refreshBg();
                }}
                title={`background shells — ${bgJobs().filter((j) => j.running).length} running, ${bgJobs().length} total (click to inspect)`}
              >
                ⚙️ {bgJobs().filter((j) => j.running).length || bgJobs().length}
                {bgJobs().some((j) => j.running) ? " running" : " done"}
              </button>
            </Show>
            <Show when={agentTasks(sel()!.id).length > 0}>
              <span class="badge cron" title={`scheduled tasks:\n${agentTasks(sel()!.id).map((t) => `${t.schedule} · ${t.id}${t.forked ? " (forked)" : ""}`).join("\n")}`}>
                ⏰ {agentTasks(sel()!.id).length}
              </span>
            </Show>
            {}
            <span class="sub" title={`${sel()!.model} · ${sel()!.session}/${sel()!.branch} · turns ${sel()!.stats.turns} · tools ${sel()!.stats.toolCalls}`}>
              {sel()!.model} · {sel()!.session}/{sel()!.branch} · {sel()!.stats.turns}↻ {sel()!.stats.toolCalls}⚙️
            </span>
            <span class="head-actions">
              {}
              {}
              {}
              <button
                class={"runbtn" + (isSelLive() ? " danger" : "")}
                title={
                  isSelLive()
                    ? "interrupt: aborts the current LLM call; the running tool finishes first"
                    : "run toward the goal (starts the loop)"
                }
                onclick={() => (isSelLive() ? act("/stop") : act("/start"))()}
              >
                {isSelLive() ? "■ stop" : "▶ start"}
              </button>
              {}
              <Show when={agents().some((a) => a.parent === selected())}>
                <IconBtn icon="⏹" title="stop every sub-agent this agent spawned (descendants included)" onClick={stopChildren} />
              </Show>
              <span class="head-sep" aria-hidden="true" />
              {}
              <IconBtn icon="🗄" title="archive this agent — reversible: it leaves the list but keeps its config and history (restore in ⚙️ settings → archive)" onClick={archiveSelected} />
              <IconBtn icon="⑂" title="fork: branch off the conversation here — try things without disturbing the main line" onClick={forkSelected} />
              <IconBtn icon="⌨" title="terminal (t)" onClick={toggleTerm} />
              {}
              <IconBtn icon="▤" title="toggle details panel (d)" active={showRight()} onClick={toggleRight} />
            </span>
            {}
            <Show when={showBg()}>
              <div class="bgjobs-pop" role="dialog" aria-label="background shells">
                <div class="bgjobs-head">
                  <span>background shells</span>
                  <button type="button" class="iconbtn" title="close" onclick={() => setShowBg(false)}>✕</button>
                </div>
                <Show
                  when={bgJobs().length > 0}
                  fallback={<div class="muted bgjobs-empty">no background jobs for this agent</div>}
                >
                  <For each={bgJobs()}>
                    {(j) => (
                      <div class="bgjob">
                        <div class="bgjob-line">
                          <span class={"bgjob-dot " + (j.running ? "running" : "done")} title={j.running ? "running" : "finished"} />
                          <code class="mono bgjob-cmd" title={j.cmd}>{oneLine(j.cmd, 80)}</code>
                          <span class="muted bgjob-meta">
                            {j.detached
                              ? `detached · pid ${j.pid ?? "?"}`
                              : j.running
                                ? fmtDur(Date.now() - j.startedAt)
                                : `exit ${j.code ?? "?"}`}
                            {j.truncated ? " · truncated" : ""}
                          </span>
                          {}
                          <button
                            type="button"
                            class="bgjob-kill"
                            title={
                              j.detached
                                ? `this job survived a harness restart (pid ${j.pid ?? "?"}) — its output can no longer be read here; stop it yourself if needed`
                                : j.running
                                  ? "kill this job (whole process group)"
                                  : "forget this finished job"
                            }
                            onclick={async () => {
                              await api(`/api/agents/${encodeURIComponent(sel()!.id)}/bg-jobs/${encodeURIComponent(j.id)}`, { method: "DELETE" }).catch(() => {});
                              await refreshBg();
                            }}
                          >{j.detached ? "forget" : j.running ? "kill" : "clear"}</button>
                        </div>
                        {}
                        <Show
                          when={j.tail.trim()}
                          fallback={
                            <Show when={j.detached}>
                              <div class="muted bgjob-detached">
                                this job outlived a harness restart, so its output is no longer captured
                                here. it is still running as pid {j.pid ?? "?"} — read its own log, or
                                stop it yourself.
                              </div>
                            </Show>
                          }
                        >
                          <pre class="mono bgjob-tail">{j.tail}</pre>
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </Show>
          </header>

          <div class="feed" ref={(el) => attachFeedObserver(el)} onscroll={(e) => {
            const el = e.currentTarget;
            const now: TailSample = { top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight };
            const cause = classifyScroll(now, ledger, lastSampleHeight, lastSampleViewport);
            if (
              cause === "layout" &&
              !atBottom() &&
              resyncBudget > 0 &&
              Math.abs(now.height - (lastSampleHeight ?? now.height)) > 1
            ) {
              resyncBudget--;
              resyncAfterUnskip(el, unskipAnchor);
            }
            ledger = null;
            lastSampleHeight = now.height;
            lastSampleViewport = now.viewport;
            lastSample = now;
            publishGap(now);
            const wasFollowing = atBottom();
            const t = performance.now();
            if (t - unskipAnchorAt > 100) {
              unskipAnchorAt = t;
              unskipAnchor = firstVisibleRow(el);
            }
            const follow = nextFollowing(wasFollowing, cause, now);
            if (follow !== wasFollowing) setAtBottom(follow);
            if (cause === "reader") resyncBudget = RESYNC_BUDGET_PER_GESTURE;
            if (follow && cause !== "reader") {
              if (missed()) setMissed(0);
              markReadIfFollowing();
              if (shouldPin(follow, now) && distanceToTail(now) > 0) pinToTail();
            } else if (follow && atTail(now)) {
              if (missed()) setMissed(0);
              markReadIfFollowing();
            }
            if (now.top <= 4 && selected() && !loadingOlder() && !olderDone() && events().length > 0) {
              void loadOlder();
            }
          }}>
            <Show when={compacting()}>
              {(c) => (
                <div class="divider-msg compacting" title="the harness is compressing old turns into notes so work can continue within the context window">
                  🗜 {c().phase === "harvesting" ? "saving durable lessons…" : `summarizing ${c().summarized ? fmtK(c().summarized!) + " " : ""}older messages…`}
                </div>
              )}
            </Show>
            <Show when={olderDone() && chatEvents().length > 0}>
              <div class="divider-msg">── beginning of log ──</div>
            </Show>
            <Show when={loadingOlder()}>
              <div class="divider-msg">loading older events…</div>
            </Show>
            <Show when={chatEvents().length > 0} fallback={
              loadingFeed()
                ? <div style="display:grid;place-items:center;height:100%" class="muted">
                    <span><span class="spinner" aria-hidden="true" /> loading timeline…</span>
                  </div>
                : <div style="display:grid;place-items:center;height:100%" class="muted">no events yet — say something or press ▶ start</div>
            }>
              {}
              <For each={chatEvents()}>
                {(row) => (
                  <MessageRow
                    e={row}
                    prev={() => neighbourOf(row, -1)}
                    next={() => neighbourOf(row, 1)}
                    // only worth labelling when the session HAS more than one
                    // branch (a fork). With a single branch every row repeated the
                    // same constant.
                    showBranch={branches().length > 1}
                    res={() => pairInfo().resFor.get(row.id)}
                    // an unpaired tool_result is rendered as a COMPLETED
                    // tool row of its own — its call fell out of the events
                    // window while the command ran. Without this the result was
                    // a bare anonymous row and the run read as unfinished.
                    orphan={pairInfo().orphanCalls.has(row.id)}
                    onOption={(t) => void sendText(t)}
                    // pass the ACCESSOR, not the Set. A <For> child is a
                    // non-reactive closure, so `answeredQuestionIds()` was
                    // evaluated once when the row was built and never re-read.
                    // The old derivation only ever changed when `events()`
                    // changed, which re-created the rows and hid the bug; an
                    // optimistic answer changes nothing about `events()`, so
                    // the row kept a snapshot from before the click.
                    answeredIds={answeredQuestionIds}
                    onAnswered={markAnswered}
                    // a row showing MIRRORED SUB-AGENT activity is the
                    // child's work, not this agent's, so it must not wear the
                    // parent's live chrome ("writing…", the running blink)
                    // just because the parent happens to be running.
                    agentActive={
                      isTimelineLive() && isOwnLiveWork(row)
                    }
                    // A row that EXPANDS when its result arrives (a `<details>` opening,
                    // a tool body growing) is one of the growth paths — decided by the
                    // policy, from geometry sampled at the moment the row resized.
                    onResize={() => {
                      if (atBottom()) pinToTail();
                    }}
                    // a logged `blobs/<hash>` reference needs the owning agent to become a URL (#blobs)
                    agentId={selected() ?? undefined}
                    onCancel={
                      row.data?.source === "user" &&
                      row.data?.pending && row.data?.promptId && row.data?.sent !== true
                        ? () => {
                            const pid = String(row.data.promptId);
                            api(`/api/agents/${selected()}/prompt/cancel`, {
                              method: "POST",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({ promptId: pid }),
                            })
                              .then((r: any) => {
                                const back = String(r.text ?? "");
                                saveDraft(draft() ? `${back}\n\n${draft()}` : back);
                                writePending(pendingKey(), pendingMsgs().filter((p) => p.promptId !== pid));
                                flashHint("message withdrawn — draft restored");
                              })
                              .catch(() => flashHint("withdraw failed — it may have already been sent"));
                          }
                        : undefined
                    }
                    onEdit={
                      row.type === "prompt" &&
                      row.data?.source === "user" &&
                      !(row.data?.pending && row.data?.sent !== true) &&
                      !row.data?.cancelled
                        ? async () => {
                            if (isSelLive()) {
                              await api(`/api/agents/${selected()}/stop`, { method: "POST" }).catch(() => {});
                              await refreshAgents();
                            }
                            setEditing({ eventId: row.id, text: String(row.data?.text ?? "") });
                          }
                        : undefined
                    }
                  />
                )}
              </For>
              {}
              {}
              <Show when={loadingFeed()}>
                <div class="feedloading">
                  <span class="spinner" aria-hidden="true" /> loading newer events…
                </div>
              </Show>
              {}
              <Show when={isTimelineLive() && live()}>
                <div class="msg live">
                  <div class="avatar" style="background:#5865f233;border:1px solid #5865f266">🫖</div>
                  <div class="msg-body">
                    <div class="msg-head">
                      <span class="author" style="color:var(--acc)">agent</span>
                      <span class="ts">streaming…</span>
                    </div>
                    {}
                    <Show when={liveReasoning().trim() !== ""}>
                      <details class="reasoning" open>
                        <summary>
                          💭 thinking <ThinkingTimer startedAt={liveStartedAt()} />
                        </summary>
                        {}
                        <div
                          class="mono thinkscroll"
                          ref={(el) => {
                            let stick = true;
                            el.addEventListener("scroll", () => {
                              stick = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                            });
                            createEffect(() => {
                              liveReasoning(); 
                              if (stick) el.scrollTop = el.scrollHeight;
                            });
                          }}
                        >
                          {liveReasoning()}
                        </div>
                      </details>
                    </Show>
                    <Show
                      when={liveText()}
                      fallback={<div class="content muted">thinking…</div>}
                    >
                      <Show when={liveIsCompact()} fallback={<div class="content" innerHTML={renderMarkdown(liveText() + "▍")} />}>
                        <div class="muted" style="font-size:11.5px;margin-bottom:4px">🗜 summarizing older context…</div>
                        <div class="content" innerHTML={renderMarkdown(liveBody() + "▍")} />
                      </Show>
                    </Show>
                  </div>
                </div>
              </Show>
            </Show>
          </div>

          <Show when={termOpen()}>
            <div class="termdrawer" style={{ height: `${termHeight()}px` } as any}>
              <div class="termgrip" onpointerdown={startGrip} ondblclick={() => { setTermHeight(Math.max(220, Math.round(window.innerHeight * 0.35))); localStorage.setItem("teapot.termH", String(termHeight())); }} title="drag to resize · double-click to reset" />
              <div class="termbar">
                <div class="termtabs">
                  <For each={termTabs()}>
                    {(t, i) => (
                      <span
                        class={"termtab" + (focusedPane() === 0 && paneL() === i() ? " active" : "") + (splitView() && focusedPane() === 1 && paneR() === i() ? " active" : "")}
                        onclick={() => focusTab(i())}
                        title={`${t.title} — click to show in focused pane`}
                      >
                        ⌨ {t.title}
                        <button class="tabx" onclick={(e) => { e.stopPropagation(); closeTab(i()); }} title="close this shell">✕</button>
                      </span>
                    )}
                  </For>
                  <IconBtn icon="＋" title="new shell in this workspace" onClick={addFromSelected} />
                </div>
                <div style="display:flex;gap:4px;align-items:center">
                  <span class="muted mono" style="flex:1;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    {activeTab() ? agents().find((a) => a.id === activeTab()!.agentId)?.workspace.split("/").filter(Boolean).pop() : sel()?.workspace}
                  </span>
                  <IconBtn icon="◫" title={splitView() ? "single pane" : "split panes (50/50)"} onClick={toggleSplit} />
                  <IconBtn icon="▾" title="hide the terminal (shells keep running; reopen with t) — close individual shells with their ✕ tab buttons" onClick={toggleTerm} />
                </div>
              </div>
              <div class="termbody" classList={{ split: splitView() }}>
                <div class="termpane" classList={{ focused: focusedPane() === 0 }} onpointerdown={() => setFocusedPane(0)} ref={setPaneHost(0)}>
                  <Show when={paneL() < 0 || paneL() >= termTabs().length}>
                    <div class="termempty muted">no shell here — ＋ opens one, tabs fill the focused pane</div>
                  </Show>
                </div>
                <Show when={splitView()}>
                  <div class="termsplit" />
                  <div class="termpane" classList={{ focused: focusedPane() === 1 }} onpointerdown={() => setFocusedPane(1)} ref={setPaneHost(1)}>
                    <Show when={paneR() < 0 || paneR() >= termTabs().length}>
                      <div class="termempty muted">no shell here — click a tab or ＋ to add</div>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
          </Show>

          <div class={"composer" + (composerMaximized() ? " maximized" : "")}>
            <Show when={gapToTailPx() > 32 && !atBottom()}>
              <button
                class="jump"
                onclick={() => {
                  scrollBottom(true);
                  markReadIfFollowing();
                }}
              >
                ↓ {missed() > 0 ? `${missed()} new message${missed() > 1 ? "s" : ""}` : "jump to present"}
              </button>
            </Show>
            <Show when={suggestions().length > 0}>
              <div class="cmds">
                <For each={suggestions()}>
                  {(s, i) => (
                    <div
                      class={"cmdrow" + (i() === cmdIdx() ? " active" : "")}
                      title={s.title}
                      onclick={() => { saveDraft(s.insert); setCmdIdx(-1); }}
                    >
                      <b class="mono">{s.insert.trim()}</b>
                      <span class="muted">{s.title}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={mentionMatches().length > 0}>
              <div class="cmds">
                <For each={mentionMatches()}>
                  {(m) => (
                    <div class="cmdrow" title={m.label} onclick={() => { saveDraft(`@${m.key} `); setCmdIdx(-1); }}>
                      <b>@{m.key}</b>
                      <span class="muted">{m.label}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <form onsubmit={send}>
              {}
              <Show when={pendingImages().length > 0}>
                <div class="imgstage">
                  <For each={pendingImages()}>
                    {(im, i) => (
                      <span class="imgchip" title={im.name}>
                        <img src={im.url} alt={im.name} />
                        <button
                          type="button"
                          class="imgx"
                          title="remove"
                          onclick={() => setPendingImages((l) => l.filter((_, j) => j !== i()))}
                        >✕</button>
                      </span>
                    )}
                  </For>
                  <span class="muted" style="font-size:11px;align-self:center">
                    {pendingImages().length} image{pendingImages().length > 1 ? "s" : ""} attached
                  </span>
                </div>
              </Show>
              <textarea
                ref={(el) => {
                  composerEl = el;
                  el.value = draft();
                }}
                rows={1}
                placeholder={`message #${sel()!.id} — / for commands · paste or 📎 to attach images`}
                oncompositionstart={() => {
                  imeInProgress = true;
                }}
                oncompositionend={() => {
                  requestAnimationFrame(() => {
                    imeInProgress = false;
                  });
                  saveDraft(composerEl?.value ?? "");
                }}
                onpaste={(e) => {
                  const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
                  if (imgs.length) {
                    e.preventDefault();
                    addImages(imgs);
                  }
                }}
                oninput={(e) => {
                  saveDraft(e.currentTarget.value);
                  setCmdIdx(0); 
                  autosizeComposer();
                }}
                onkeydown={(e) => {
                  const sugg = suggestions();
                  if (sugg.length > 0 && e.key === "ArrowDown") {
                    e.preventDefault();
                    setCmdIdx((i) => Math.min(i + 1, sugg.length - 1));
                    return;
                  }
                  if (sugg.length > 0 && e.key === "ArrowUp") {
                    e.preventDefault();
                    setCmdIdx((i) => Math.max(i - 1, 0));
                    return;
                  }
                  if (sugg.length > 0 && (e.key === "Tab" || e.key === "Enter") && !e.shiftKey && cmdIdx() >= 0 && !imeInProgress) {
                    e.preventDefault();
                    saveDraft(sugg[cmdIdx()]!.insert);
                    setCmdIdx(-1);
                    return;
                  }
                  if (e.key === "Escape" && sugg.length > 0) {
                    setCmdIdx(-1); 
                    return;
                  }
                  if (
                    shouldSendOnKey({
                      key: e.key,
                      shiftKey: e.shiftKey,
                      composing: imeInProgress,
                      maximized: composerMaximized(),
                    })
                  ) {
                    e.preventDefault();
                    void send(e);
                  }
                }}
              />
              <Show when={draft().startsWith("@") && draft().includes(" ")}>
                <label
                  class="forkchip"
                  title="inherit the conversation prefix byte-exactly — the sub-agent's provider prefix cache starts warm"
                >
                  <input type="checkbox" checked={mentionFork()} onchange={(e) => setMentionFork(e.currentTarget.checked)} />
                  fork ctx
                </label>
              </Show>
              <button
                type="button"
                class="iconbtn maxbtn"
                title={composerMaximized() ? "restore composer (hide timeline)" : "maximize composer — hide the timeline and fill the main column"}
                onclick={() => {
                  const next = !composerMaximized();
                  setComposerMaximized(next);
                  requestAnimationFrame(() => autosizeComposer());
                }}
              >{composerMaximized() ? "⤡" : "⤢"}</button>
              <IconBtn
                icon="📎"
                title="attach images (or paste them straight into the box)"
                onClick={() => document.getElementById("composer-file")?.click()}
              />
              <Show when={pendingImages().length}>
                <span class="muted" style="font-size:11.5px;white-space:nowrap">🖼 {pendingImages().length}</span>
              </Show>
              <button type="submit">send</button>
              {}
              <input
                id="composer-file"
                type="file"
                accept="image/*"
                multiple
                style="display:none"
                onchange={(e) => {
                  if (e.currentTarget.files?.length) addImages(e.currentTarget.files);
                  e.currentTarget.value = ""; 
                }}
              />
            </form>
            {}
            {}
            <Show when={flash()}>
              <div class="hint flashhint">{flash()}</div>
            </Show>
          </div>
        </Show>
      </section>

      {}
      {}
      {}
      <Show when={narrow() && showRight()}>
        <div class="rightbarbackdrop" onclick={() => setRight(false)} />
      </Show>
      <aside
        class={"rightbar" + (showRight() ? " open" : "")}
        ref={rightbarEl}
        onscroll={(e) => { rightbarTop = (e.currentTarget as HTMLDivElement).scrollTop; }}
      >
        {}
        <div class="rightbarhead">
          <span class="muted">details</span>
          <IconBtn icon="✕" title="close details panel (esc)" onClick={closeRight} />
        </div>
        {}
        <Show when={sel()?.id} keyed fallback={null}>
          {(_aid) => (
          <>
          {}

          {}
          <Show when={sel()!.id} keyed fallback={null}>
            {(aid) => (
              <FilesPanel agentId={aid} workspace={sel()!.workspace} />
            )}
          </Show>

          <h3 title="switch provider/model live — applies from the agent's next turn">
            🧦 model
            <Show when={models().length}>
              <span class="muted" style="text-transform:none;letter-spacing:0">· {models().length} models</span>
            </Show>
          </h3>
          <div class="modelbox">
            <select
              value={modelProvider()}
              onchange={(e) => {
                const next = e.currentTarget.value;
                providerTouched = true;
                setModelProvider(next);
                setModelDraft(
                  modelOnProviderSwitch(
                    cfg().providers,
                    next,
                    agents().find((a) => a.id === selected()),
                  ),
                );
                loadModels(next);
              }}
              title="provider (OpenAI-compatible endpoint)"
            >
              <For each={providerList()}>{(p) => <option value={p}>{p}{p === cfg().defaultProvider ? " ★" : ""}</option>}</For>
            </select>
            <div style="display:flex;gap:4px">
              <input
                type="text"
                list="model-list"
                placeholder={modelPlaceholderFor(cfg().providers, modelProvider(), sel(), effectiveProviderOf(sel(), cfg().providers, cfg().defaultProvider))}
                value={modelDraft()}
                oninput={(e) => setModelDraft(e.currentTarget.value)}
                style="flex:1;min-width:0"
              />
              <datalist id="model-list">
                <For each={models()}>{(m) => <option value={m.id} />}</For>
              </datalist>
            </div>
            {}
            <Show when={sel()!.effortSupported}>
              <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
                <label class="muted" style="font-size:11.5px;white-space:nowrap">effort</label>
                <select
                  style="flex:1;min-width:0"
                  value={effortDraft()}
                  onchange={(e) => setEffortDraft(e.currentTarget.value)}
                >
                  <option value="">provider default</option>
                  {}
                  <For each={sel()!.effortOptions?.length ? sel()!.effortOptions : REASONING_EFFORT_OPTIONS}>
                    {(v) => <option value={v}>{v}</option>}
                  </For>
                </select>
              </div>
            </Show>
            {}
            <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
              <button
                title="apply the provider, model and effort above to this session — takes effect from the agent's next turn"
                style="flex:1"
                onclick={async (e) => {
                  if (!selected()) return;
                  const btn = e.currentTarget as HTMLButtonElement;
                  btn.disabled = true;
                  try {
                    await api(`/api/agents/${selected()}/model`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        provider: modelProvider(),
                        model: modelDraft().trim() || undefined,
                        contextWindowTokens:
                          models().find((m) => m.id === (modelDraft().trim() || undefined))?.contextLength,
                        ...(sel()!.effortSupported ? { reasoningEffort: effortDraft() } : {}),
                      }),
                    });
                    btn.textContent = "✓ applied";
                    refreshAgents();
                  } catch (ex) {
                    alert(`apply failed: ${(ex as Error).message}`);
                  } finally {
                    setTimeout(() => { btn.textContent = "apply"; btn.disabled = false; }, 1200);
                  }
                }}
              >apply</button>
            </div>
            <div class="meta">current: {sel()!.model}</div>
            <Show when={modelSpec()}>
              <div class="meta" style="color:var(--fg)">{modelSpec()}</div>
            </Show>
          </div>

          {}
          <div class="ctrlrow">
            <label
              title="auto-continue fires after a round ONLY when all hold: ① this toggle is on ② a goal is set and its status is 'active' ③ the round ended cleanly (no error / not stopped). It stops when the goal is marked done, or if you press ■ stop. Sending any prompt also starts an idle agent regardless."
            >
              <input
                type="checkbox"
                checked={sel()!.autoContinue ?? true}
                onchange={(e) => {
                  if (!selected()) return;
                  api(`/api/agents/${selected()}/auto-continue`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ value: e.currentTarget.checked }),
                  }).then(refreshAgents);
                }}
              />
              auto-continue
            </label>
          </div>

          <h3 title="what the agent is working toward. Stored with the session; the agent reads it via get_goal(). Auto-continue keeps looping while the status is 'active' and stops when marked done.">🎯 goal
            <Show
              when={!!sel()!.goal.text.trim()}
              fallback={<span class="badge" title="no goal set yet">no goal</span>}
            >
              <span class={`badge ${sel()!.goal.status === "active" ? "running" : sel()!.goal.status}`}>{sel()!.goal.status}</span>
            </Show>
          </h3>
          <div class="statrow" style="margin-bottom:6px">
            <span class="k">status</span>
            <For each={["active", "done", "paused"] as const}>
              {(s) => (
                <button
                  class={"goalstate" + (!!sel()!.goal.text.trim() && sel()!.goal.status === s ? ` on ${s}` : "")}
                  disabled={!!sel()!.goal.text.trim() && sel()!.goal.status === s}
                  title={
                    s === "active"
                      ? "agent keeps working toward the goal (with auto-continue)"
                      : s === "done"
                        ? "mark achieved — auto-continue stops"
                        : "parked on purpose — resume by setting active again"
                  }
                  onclick={() => {
                    if (!selected()) return;
                    api(`/api/agents/${selected()}/goal`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ status: s }),
                    }).then(refreshAgents);
                  }}
                >{s === "active" ? "▶ working" : s === "done" ? "✓ done" : "⏸ paused"}</button>
              )}
            </For>
          </div>
          <Show
            when={sel()!.goal.text}
            fallback={<div class="card muted">no goal yet — write one below and press ✓ save. Then ▶ start (or any message) sets it in motion.</div>}
          >
            <div class="card goalcard" ref={trackGoalPreviewHeight} style={goalPreviewStyle()}>
              <div class="content" innerHTML={renderMarkdown(String(sel()!.goal.text))} />
            </div>
            <Show when={sel()!.goal.verify}>
              <Card
                title="🔍️ verification contract"
                tone="tool"
                body={String(sel()!.goal.verify)}
              />
            </Show>
            <Show when={sel()!.goal.audit}>
              {(a) => (
                <Card
                  title={a().verdict === "approved" ? "✅ audit: approved" : "⚠ audit: changes required"}
                  meta={relTime(a().at)}
                  tone={a().verdict === "approved" ? "ok" : "warn"}
                  body={
                    isPlaceholderDetail(a().feedback)
                      ? "_the auditor returned a verdict with no detail_"
                      : a().feedback
                  }
                />
              )}
            </Show>
          </Show>
          {}
          <form onsubmit={setGoal} style="display:flex;flex-direction:column;gap:6px;margin-top:8px;margin-bottom:6px">
            <textarea
              id="goal-input"
              ref={trackGoalHeight}
              rows={3}
              placeholder="set new goal…"
              value={goalDraft()}
              oninput={(e) => { setGoalDraft(e.currentTarget.value); setGoalDirty(true); }}
              style={{
                ...(goalHeightStyle() ?? {}),
                background: "var(--bg-darkest)", border: "none", "border-radius": "6px",
                padding: "6px 8px", color: "var(--fg)", font: "inherit",
                width: "100%", resize: "vertical",
              }}
              title="drag the bottom edge to make this taller — the height is remembered"
            />
            <textarea
              id="goal-verify-input"
              rows={2}
              placeholder="verification contract (optional) — e.g. 'npm test passes; endpoint documented'. finish(goalComplete=true) is then audited against this."
              title="pi-goal-x-style verification contract — an independent reviewer checks the agent's finish against these requirements"
              value={goalVerifyDraft()}
              oninput={(e) => { setGoalVerifyDraft(e.currentTarget.value); setGoalDirty(true); }}
              style="background:var(--bg-darkest);border:1px solid var(--bg-light);border-radius:6px;padding:6px 8px;color:var(--fg);font:inherit;font-size:12.5px;width:100%;resize:vertical"
            />
            <div style="display:flex;justify-content:flex-end;align-items:center;gap:10px">
              <label
                class="muted"
                style="display:flex;align-items:center;gap:4px;font-size:11.5px;white-space:nowrap;cursor:pointer"
                title="queue a harness prompt telling the agent about the new goal at its next turn boundary"
              >
                <input id="goal-notify" type="checkbox" checked={goalNotify()} onchange={(e) => setGoalNotify(e.currentTarget.checked)} /> notify agent
              </label>
              <button type="submit" class="primarybtn">✓ save goal</button>
            </div>
          </form>

          <h3 title="todo.md — a shared checklist in the session dir. Write tasks like '- [ ] fix login'; the agent ticks them off via set_todo, you edit here. With notify on, it's told at its next turn boundary.">
            ✅ tasks
            <Show when={todoStats().total > 0}>
              <span class="badge" style={todoStats().done === todoStats().total ? "color:var(--ok)" : "color:var(--warn)"}>
                {todoStats().done}/{todoStats().total} done
              </span>
            </Show>
          </h3>
          <Show when={todoStats().total > 0}>
            <div class="bartrack" style="margin-bottom:6px">
              <div
                class={"barfill " + (todoStats().done === todoStats().total ? "" : "warn")}
                style={{ width: `${Math.round((todoStats().done / todoStats().total) * 100)}%` }}
              />
            </div>
          </Show>
          <TodoEditor
            draft={todoDraft()}
            preview={todoViewMode()}
            onDraft={(text: string) => {
              setTodoDraft(text);
              setTodoDirty(true);
            }}
          />
          <div style="display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:4px">
            <IconBtn
              icon={todoViewMode() ? "✎" : "👁"}
              title={todoViewMode() ? "edit markdown" : "rendered checklist"}
              onClick={() => setTodoViewMode(!todoViewMode())}
            />
            <label
              class="muted"
              style="display:flex;align-items:center;gap:4px;font-size:11.5px;white-space:nowrap;cursor:pointer"
              title="queue a harness prompt telling the agent the task list changed"
            >
              <input id="todo-notify" type="checkbox" checked /> notify agent
            </label>
            <button
              onclick={saveTodo}
              class="okbtn"
            >✓ save tasks</button>
          </div>

          <h3 title="latest report_progress snapshot. The harness asks for one after real activity (time AND output gates); errors show under ⚠ problems">📈 progress</h3>
          <Show
            when={sel()!.latestProgress}
            fallback={<div class="muted">none yet</div>}
          >
            {(p) => (
              <div class="card prog">
                <div class="progrow"><b>doing</b><span class="content inline-md" innerHTML={renderMarkdownCached(p().doing)} /></div>
                <Show when={p().recent}><div class="progrow"><b>recent</b><span class="content inline-md" innerHTML={renderMarkdownCached(p().recent)} /></div></Show>
                <Show when={p().problems}><div class="progrow warn"><b>⚠ problems</b><span class="content inline-md" innerHTML={renderMarkdownCached(p().problems)} /></div></Show>
                <Show when={p().next}><div class="progrow"><b>next</b><span class="content inline-md" innerHTML={renderMarkdownCached(p().next)} /></div></Show>
                <Show when={p().goalStatus}><div class="progrow"><b>goal</b><span>{p().goalStatus}</span></div></Show>
                <div class="meta muted">{relTime(p().ts)}</div>
              </div>
            )}
          </Show>

          {}
          <h3 title="context is how much of the model's window the live conversation occupies. Past the threshold, the oldest turns are summarized into notes so work can continue.">📊 runtime</h3>
          <div class="card runcard">
            <Show
              when={sel()!.ctx}
              keyed
              fallback={
                <div class="statrow">
                  <span class="k">context</span>
                  <span class="muted">no window known for this model yet</span>
                </div>
              }
            >
              {(c) => {
                const ctxVals = createMemo(() => {
                  const cv = c;
                  const modelMeta = models().find((m) => m.id === sel()!.model);
                  const effectiveWindow = cv.window || modelMeta?.contextLength || 0;
                  const pct = effectiveWindow
                    ? Math.min(999, (cv.usedTokens / effectiveWindow) * 100)
                    : 0;
                  return {
                    usedTokens: cv.usedTokens,
                    compactAt: cv.compactAt,
                    compacting: cv.compacting,
                    window: cv.window,
                    effectiveWindow,
                    pct,
                    cls:
                      !effectiveWindow ? "" : pct >= 85 ? "crit" : pct >= 70 ? "warn" : "ok",
                    derivedBudget: effectiveWindow ? Math.round(effectiveWindow * 0.75) : 0,
                    usingDerived: cv.compactAtIsManual !== true,
                  };
                });
                const v = () => ctxVals();
                const fmtPct = (x: number) => {
                  const r = Math.round(x * 10) / 10;
                  return Number.isInteger(r) ? String(r) : r.toFixed(1);
                };
                return (
                  <div
                    class="ctxblock"
                    title="estimated live context vs the model's real window. Past the window, old turns are summarized into notes (compaction); the compact line below shows where that starts."
                  >
                    <div class="statrow">
                      <span class="k">context</span>
                      <b>~{fmtK(v().usedTokens)} tok</b>
                      <Show when={v().effectiveWindow}>
                        <span class={`pill ${v().cls}`}>
                          {fmtPct(v().pct)}% of {fmtK(v().effectiveWindow)}
                        </span>
                      </Show>
                    </div>
                    <Show when={v().effectiveWindow}>
                      <div class="bartrack">
                        <div class={`barfill ${v().cls}`} style={{ width: `${Math.min(100, v().pct)}%` }} />
                      </div>
                    </Show>
                    {}
                    <div class="statrow" style="margin-top:4px">
                      <span class="k">compact at</span>
                      <b>{fmtK(v().usingDerived ? v().derivedBudget : v().compactAt)} tok</b>
                      <span class="muted" style="color:var(--dim)">
                        {v().usingDerived ? "75% of window" : "manual"}
                      </span>
                    </div>
                    <Show when={compacting() || v().compacting}>
                      <div class="statrow" title="a compaction pass is running right now — the summarizer's output streams in the timeline">
                        <span class="k">🗜</span>
                        <b>compacting…</b>
                        <span class="muted" style="font-size:11px;color:var(--acc)">
                          {compacting()?.phase ?? String(v().compacting)}
                        </span>
                      </div>
                    </Show>
                    <div class="ctrlrow" style="margin-top:6px">
                      <label title="when on, older turns are automatically summarized when context exceeds the budget">
                        <input
                          type="checkbox"
                          checked={sel()!.autoCompact !== false}
                          onchange={(e) => {
                            if (!selected()) return;
                            api(`/api/agents/${selected()}/auto-compact`, {
                              method: "POST",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({ value: e.currentTarget.checked }),
                            }).then(refreshAgents);
                          }}
                        />
                        auto-compact
                      </label>
                    </div>
                  </div>
                );
              }}
            </Show>
            {}
            <div class="rtgrid">
              {}
              <div class="rtcell" title="prompt tokens billed this session">
                <span>tokens in</span>
                <b>{fmtK(sel()!.stats.inputTokens)}</b>
              </div>
              <div class="rtcell" title="completion tokens billed this session">
                <span>tokens out</span>
                <b>{fmtK(sel()!.stats.outputTokens)}</b>
              </div>
              <div class="rtcell" title="assistant turns this session">
                <span>turns</span>
                <b>{sel()!.stats.turns}</b>
              </div>
              <div class="rtcell" title="tool calls this session">
                <span>tools</span>
                <b>{sel()!.stats.toolCalls}</b>
              </div>
              <div
                class="rtcell"
                title={`how many times old turns were summarized into notes to make room. ${sel()!.stats.compactions ? "Each one keeps the recent stretch verbatim." : "Not yet — the context has fit so far."}`}
              >
                <span>compacted</span>
                <b>{sel()!.stats.compactions ?? 0}</b>
                {}
              </div>
              <Show when={(sel()!.stats.costUsd ?? 0) > 0}>
                <div
                  class="rtcell"
                  title={`≈ ${(sel()!.stats.costUsd ?? 0).toFixed(4)} this session, from the model's per-token pricing and per-turn usage. Cached input is estimated at ~10% of the prompt rate; treat as an approximation, not an invoice.`}
                >
                  <span>cost</span>
                  <b>${costFmt(sel()!.stats.costUsd ?? 0)}</b>
                  {}
                </div>
              </Show>
              <Show when={(sel()!.stats.cachedInputTokens ?? 0) > 0}>
                <div
                  class="rtcell"
                  title={`${fmtK(sel()!.stats.cachedInputTokens)} input tokens were served from the provider's prompt cache — billed far cheaper than fresh input`}
                >
                  <span>cached</span>
                  <b>{Math.round((sel()!.stats.cachedInputTokens / Math.max(1, sel()!.stats.inputTokens)) * 100)}%</b>
                  {}
                </div>
              </Show>
            </div>
          </div>

          {}
          <h3>🌿 branches <span class="muted" style="text-transform:none;letter-spacing:0">· click to filter the feed</span>
            {}
            <Show when={branchFilter()}>
              <div class="muted" style="font-size:11px;text-transform:none;letter-spacing:0">
                showing <b>{branchFilter()}</b> and the history it inherited before forking
              </div>
            </Show>
          </h3>
          <For each={branches()}>
            {(b) => (
              <div
                class={"branch-row" + (b.branch === sel()!.branch || b.branch === branchFilter() ? " cur" : "")}
                title={b.branch === branchFilter() ? "click to show all branches again" : `show only ${b.branch}`}
                onclick={() => {
                  const next = branchFilter() === b.branch ? null : b.branch;
                  const changing = next !== branchFilter();
                  setBranchFilter(next);
                  if (!selected()) return;
                  if (changing) {
                    feedGeneration++;
                    setEvents([]);
                    setEventsTotal(0);
                    setOlderDone(false);
                  }
                  loadEvents(selected()!);
                }}
              >
                <span>{b.branch}{b.branch === sel()!.branch ? " (current)" : ""}</span>
                <span>{b.events} events</span>
              </div>
            )}
          </For>

          {}
          <h3 title="cron tasks, all agents — click a row to open that agent. Edit them in ⚙️ settings → scheduled tasks.">
            ⏰ schedule
            <Show when={tasks().length > 0}>
              <span class="muted" style="text-transform:none;letter-spacing:0">· {tasks().length} · all agents</span>
            </Show>
          </h3>
          <Show
            when={tasks().length > 0}
            fallback={<div class="muted">no scheduled tasks — add them in ⚙️ settings ("scheduled tasks")</div>}
          >
            <For each={tasks()}>
              {(t) => (
                <div
                  class={"sched-row" + (t.agent === selected() ? " cur" : "")}
                  title={`${oneLine(t.prompt, 200)}\nclick to open #${t.agent}`}
                  onclick={() => select(t.agent)}
                >
                  <div class="sched-top">
                    <b>{t.id}</b>
                    <span class="muted">@{t.agent}</span>
                    <Show when={t.forked}><span title="runs on a forked branch so chatter stays off the main line">⑂</span></Show>
                  </div>
                  {}
                  <div class="sched-meta">
                    {t.schedule} → next {t.next ? relTime(t.next) : "—"}{t.last ? ` · last ${relTime(t.last)}` : " · never ran"}
                  </div>
                  <div class="sched-prompt muted">{oneLine(t.prompt, 90)}</div>
                </div>
              )}
            </For>
          </Show>
          </>
          )}
        </Show>
      </aside>
    </div>
    <Show when={showNotifs()}>
      {}
      {}
      <div class="notifbackdrop" onclick={() => setShowNotifs(false)} />
      <div class="notifpanel">
        <div class="notifhead">
          notifications
          <span style="display:flex;gap:8px;align-items:center">
            <Show when={notifs().length > 0}>
              <button class="editbtn" onclick={() => setNotifs([])}>clear all</button>
            </Show>
            <button class="iconbtn" title="close notifications" onclick={() => setShowNotifs(false)}>✕</button>
          </span>
        </div>
        <Show
          when={notifs().length > 0}
          fallback={<div class="muted" style="padding:10px">nothing yet — progress, finishes, questions and errors will land here</div>}
        >
          <div class="notiflist">
            <For each={notifs()}>
              {(n) => (
                <div
                  class={"notifitem " + n.kind + (n.read ? " read" : "")}
                  title={`from ${n.agentId}`}
                  onclick={() => {
                    setNotifs((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
                    if (selected() !== n.agentId && agents().some((a) => a.id === n.agentId)) select(n.agentId);
                    setShowNotifs(false);
                    if (n.eventId)
                      setTimeout(() => jumpToEvent(n.eventId!), selected() !== n.agentId ? 350 : 60);
                  }}
                >
                  <div class="nhead">
                    <span class="nicon">{n.kind === "finish" ? "✅" : n.kind === "question" ? "❓️" : n.kind === "error" ? "⚠️" : "📈"}</span>
                    <span class="ntitle">{n.title}</span>
                    <span class="meta muted">{relTime(new Date(n.at).toISOString())}</span>
                    <button
                      class="iconbtn nreadbtn"
                      title={n.read ? "already read" : "mark as read"}
                      onclick={(e: MouseEvent) => {
                        e.stopPropagation();
                        setNotifs((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
                      }}
                    >{n.read ? "✓" : "○"}</button>
                  </div>
                  <Show when={n.body}>
                    <div class="nbody">{truncate(n.body, 160)}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
    <Show when={showNew()}>
      <NewAgentModal
        providers={Object.keys(cfg().providers ?? {})}
        onClose={() => setShowNew(false)}
        onCreated={(id) => { setShowNew(false); refreshAgents(); select(id); }}
      />
    </Show>
    <Show when={showCfg()}>
      <ConfigModal
        cfg={cfg()}
        onClose={() => setShowCfg(false)}
        announcedOAuth={announcedOAuth}
        skills={agentSkills()}
        hasSelection={!!selected()}
        agentId={selected()}
        features={features()}
        onSaved={() => {
          loadCfg();
          loadTasks();
        }}
        // theme state lives in App (it paints `<html>`), so the appearance panel edits it
        // through these rather than keeping a second copy that would drift
        theme={{
          themes: customThemes,
          activeId: fixedTheme,
          paintedId: paintedThemeId,
          auto: themeAuto,
          setAuto: (v: boolean) => {
            setThemeAuto(v);
            localStorage.setItem("teapot.theme.auto", v ? "1" : "0");
          },
          dark: sysDarkTheme,
          setDark: setSysDarkTheme,
          light: sysLightTheme,
          setLight: setSysLightTheme,
          setThemes: setCustomThemes,
          setActive: setFixedTheme,
          preview: (id: string | null) => setPreviewTheme(id),
          commitAppearance: (v: { auto: boolean; dark: string; light: string; fixed: string }) => {
            localStorage.setItem("teapot.theme.auto", v.auto ? "1" : "0");
            localStorage.setItem("teapot.theme.dark", v.dark);
            localStorage.setItem("teapot.theme.light", v.light);
            localStorage.setItem("teapot.theme", v.fixed);
          },
        }}
      />
    </Show>
    <Show when={editing()} fallback={null}>
      {(ed) => {
        const idx = () => events().findIndex((e) => e.id === ed().eventId);
        const afterCount = () => Math.max(0, events().length - idx() - 1);
        // no mode choice: the events after the edited prompt are DISCARDED. A "summarize" mode made
        // the fork wait on a model round trip (the reported lag) and had no re-entrancy guard, so a
        // second edit during it collided. Neither Pi nor OpenCode offers it, and it was never used
        // here, so the choice is gone rather than made asynchronous.
        return (
          <Modal title="edit prompt — forks the conversation" onClose={() => setEditing(null)}>
            <form
              onsubmit={async (ev) => {
                ev.preventDefault();
                const ta = document.getElementById("edit-text") as HTMLTextAreaElement;
                try {
                  await api(`/api/agents/${selected()}/edit-prompt`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ eventId: ed().eventId, text: ta.value }),
                  });
                  setEditing(null);
                  refreshAgents();
                  const id = selected();
                  if (id) await select(id);
                } catch (ex) {
                  alert(`edit failed: ${(ex as Error).message}`);
                }
              }}
              style="display:flex;flex-direction:column;gap:10px"
            >
              <textarea id="edit-text" class="mono w100" rows={6} value={ed().text} />
              <Show when={afterCount() > 0}>
                <div style="font-size:12.5px;color:var(--dim)">
                  {afterCount()} event(s) came after this prompt and will be discarded — the new branch
                  starts from your edited text.
                </div>
              </Show>
              <div style="display:flex;justify-content:flex-end;gap:8px">
                <button type="button" onclick={() => setEditing(null)}>cancel</button>
                <button type="submit" class="primarybtn">
                  ⑂ fork & resend
                </button>
              </div>
            </form>
          </Modal>
        );
      }}
    </Show>

    </>
  );
}

/* ---------- one chat message row ---------- */
/* ---------- live elapsed-time ticker for a still-running bash call ---------- */

/** Live elapsed-seconds readout for the current thinking stretch. */

/* ---------- per-tool timeline rendering ---------- */

/**
 * A `<pre>` that highlights itself with shiki when a grammar is available.
 *
 * Renders PLAIN first and swaps in the highlighted markup when it arrives, so a tool card never
 * waits on a grammar download to show its text — the same progressive approach the file preview
 * uses. Highlighting goes through `highlightLangChunks` (language by name) because tool content has
 * no file path: a JSON argument object and a bash command are the two cases worth colouring.
 *
 * Lazily imported so the shiki core stays out of the initial bundle, and the run counter guards
 * against a swapped-in result for content that has since changed.
 */
/**
 * Highlighted code for a tool card, cached by CONTENT rather than by component instance.
 *
 * An instance-local signal is discarded whenever the row's subtree is rebuilt, and the rebuilt
 * instance starts empty and has to race the grammar download again. MEASURED before the row's
 * dependency was narrowed: 20 tool rows produced 118 constructions, and whether a given card ended
 * up highlighted depended on how many times its parent re-ran — "bashでshikiが当たってるカードと
 * 当たってないカードがある".
 *
 * Keying on `lang` plus the text means a remount renders highlighted on its FIRST pass (the signal
 * is seeded from the cache) and an identical block in another row costs nothing. The map is
 * bounded because a long session shows thousands of distinct commands.
 */

/** The un-rendered source text of a chat row — what "copy raw" should give. */

/**
 * Free-text answer row under an ask_user embed. The agent's reply arrives as
 * a regular user prompt, so this just routes through onOption — but it lets
 * the operator answer with something that wasn't among the offered options.
 */

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + " …" : s;
}

/** "in 5m" / "3m ago" — for schedule next/last columns */

/** compact token counts with k/m/b suffixes: 12345 → "12k", 2.2M → "2.2m" */

/** session cost in USD: cents below $1, whole dollars above — no noise */
function costFmt(usd: number): string {
  if (usd >= 100) return Math.round(usd).toLocaleString();
  if (usd >= 10) return usd.toFixed(1);
  if (usd >= 1) return usd.toFixed(2);
  if (usd >= 0.01) return usd.toFixed(3);
  return usd.toFixed(4);
}

/** single-line preview with collapsed whitespace */

/* ---------- copy-to-clipboard button ---------- */
/** Centered icon button — the shared home for emoji-glyph buttons. Emoji
 *  baselines sit off-center in plain text buttons, so every icon button
 *  should render through this (inline-flex centers the glyph properly). */

/** Copy `text` using the best path this environment actually supports.
 *
 *  #52 — every Copy button was dead. `navigator.clipboard` only exists in a
 *  SECURE context, and teapot serves the UI over plain `http://127.0.0.1` by
 *  default, so the property is ABSENT — `navigator.clipboard.writeText(text)`
 *  threw synchronously, before a promise existed, so the `.catch()` fallback
 *  written underneath it never ran and the legacy path was dead code.
 *
 *  So: feature-DETECT rather than assume. `clipboard` may be undefined, null,
 *  or present without a usable `writeText` (older browsers, embedded webviews),
 *  and a present API may still reject on permission or an unfocused document.
 *  Each of those must reach the legacy path, and a genuine failure must say so.
 */

/* ---------- modal shell ---------- */

/* ---------- new agent ---------- */
function NewAgentModal(props: { providers: string[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [dir, setDir] = createSignal("~");
  const [entries, setEntries] = createSignal<string[]>([]);
  const [name, setName] = createSignal("");
  const [provider, setProvider] = createSignal(props.providers[0] ?? "");
  const [model, setModel] = createSignal("");
  const [err, setErr] = createSignal("");

  async function browse(p?: string) {
    const d = await api(`/api/fs?path=${encodeURIComponent(p ?? dir())}`);
    setDir(d.path);
    setParent(d.parent ?? "");
    setEntries(d.entries ?? []);
  }
  onMount(() => browse(dir()));
  const [parent, setParent] = createSignal("");

  const create = async (e: Event) => {
    e.preventDefault(); setErr("");
    try {
      const r = await api("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: dir(), id: name(), provider: provider() || undefined, model: model() || undefined, start: false }),
      });
      props.onCreated(r.agent.id);
    } catch (ex) { setErr(String((ex as Error).message)); }
  };

  return (
    <Modal title="new agent" onClose={props.onClose}>
      <form onsubmit={create} style="display:flex;flex-direction:column;gap:10px">
        <label>workspace directory
          <div style="display:flex;gap:6px">
            <input type="text" class="w100 mono" value={dir()} oninput={(e) => setDir(e.currentTarget.value)} />
            <button type="button" onclick={() => browse(dir())}>go</button>
            <button type="button" title="parent directory" onclick={() => parent() ? browse(parent()) : browse("..")}>↑</button>
          </div>
        </label>
        <div class="dirlist">
          <For each={entries()}>{(n) =>
            <div class="direntry" onclick={() => browse(`${dir()}/${n}`.replace(/\/+/g, "/"))}>📁 {n}</div>
          }</For>
        </div>
        <div style="display:flex;gap:10px">
          <label style="flex:1">agent name <input type="text" placeholder="(directory name)" value={name()} oninput={(e) => setName(e.currentTarget.value)} /></label>
          <label style="flex:0 1 auto;min-width:0">provider
            <select value={provider()} onchange={(e) => setProvider(e.currentTarget.value)}>
              <For each={props.providers}>{(p) => <option>{p}</option>}</For>
            </select>
          </label>
          <label style="flex:1">model <input type="text" placeholder="(provider default)" value={model()} oninput={(e) => setModel(e.currentTarget.value)} /></label>
        </div>
        <Show when={err()}><span style="color:var(--err);font-size:13px">{err()}</span></Show>
        <button type="submit" style="align-self:flex-end">create</button>
      </form>
    </Modal>
  );
}
