import { createSignal, onMount, onCleanup, For, Show, createMemo, createEffect, untrack, Index } from "solid-js";
import { renderMarkdown } from "./md";
import { needsSettlePin } from "./lib/scroll-policy";
import { jumpTargetMatches } from "./lib/jump-target";
import { closeLightbox, lightboxSrc, openLightbox } from "./lib/lightbox";
import { evictOver, weighJson } from "./lib/retention";
import { renderMarkdownCached } from "./lib/markdown";
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
import { pickInitialAgent } from "./lib/session-restore";
import { outputLang } from "./lib/tool-output-lang";
import { mergeThemes } from "./lib/theme-merge";
import { previewLayers, veilColour, backgroundImageValue } from "./lib/theme-preview";
import { BG_WIDTHS, bgSrc, bgSrcSet } from "./lib/bg-srcset";
import { descendantsOf, shouldShowCollapseCaret, subAgentDisplayName } from "./lib/sidebar-tree";
import { copyText } from "./lib/clipboard";
import { groupedWith, type RowLike } from "./lib/row-grouping";
import { answeredQuestionIdsOf, type QuestionEvent } from "./lib/question-answered";
import { mergeQueued, queuedOnSend, reconcilePending, type PendingEcho } from "./lib/pending-echo";
import { resolveTimelineSession } from "./lib/session-index";
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
  correctionAllowed,
  distanceToTail,
  gapToTail,
  nextFollowing,
  shouldPin,
  shouldShowJumpToPresent,
  type ScrollCause,
  type TailSample,
} from "./lib/scroll-policy";
import { composerHeight } from "./lib/composer-size";
import { keyReleasesFollow, wheelReleasesFollow } from "./lib/scroll-gesture";
import { restoreTop, spotFromRows, type RowGeom, type SavedSpot } from "./lib/scroll-return";
import { bindStoredHeight } from "./lib/resizable-height";
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
  themeWant,
  type CustomTheme,
  type ThemePalette,
} from "./lib/theme-store";

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
  bgRunning?: number;
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

  /**
   * THE theme on screen — the only place that answers it.
   *
   * Order: a theme being previewed (clicking a card shows it immediately, before it is saved), then
   * "follow the system", then the fixed choice. With auto on there are two chosen themes, one per slot, and
   * the system decides which one is painted — but a preview overrides that, because the preview IS what you
   * are looking at.
   *
   * Keep this the ONLY place that answers it. It has already been split three ways once (a getter for the
   * background image, another for the editor, and the paint effect), and the two that ignored the preview
   * made the appearance editor describe a theme that was not on screen.
   */
  const resolvedPainted = () =>
    resolveActiveTheme({
      want: themeWant({
        preview: previewTheme(),
        auto: themeAuto(),
        prefersLight: sysPrefersLight(),
        dark: sysDarkTheme(),
        light: sysLightTheme(),
        fixed: fixedTheme(),
      }),
      customIds: customThemes().map((t) => t.id),
      presetIds: THEMES.map((t) => t.key),
      fallback: "dark",
    });
  const paintedThemeId = () => resolvedPainted().active;
  const activeBgImage = () => customThemes().find((t) => t.id === paintedThemeId())?.backgroundImage ?? "";

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
    const onResize = () => {
      const now = isNarrow();
      if (now === narrow()) return;
      setNarrow(now);
      /**
       * Crossing the boundary is asymmetric, on purpose:
       *
       *  - narrowing must NOT close the panel (#50): the operator is reading it and the window shrank around
       *    them, so the current state is kept unless THIS mode has its own stored choice;
       *  - widening restores the wide preference (or its default, open): a panel that was closed only because
       *    the display was narrow has no reason to stay closed (#195).
       */
      const stored = localStorage.getItem(panelKey(now));
      if (stored !== null || !now) setShowRight(readPanel(now));
    };
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
    onResize(); 
  });

  let lastContentHeight = 0;
  let unskipAnchor: { sel: string; top: number } | null = null;
  let unskipAnchorAt = 0;
  let feedMo: MutationObserver | undefined;
  let feedMoEl: HTMLElement | undefined;
  let feedMoRaf = 0;
  /**
   * A restore waiting for the feed element that will render it.
   *
   * The feed is RE-CREATED on a session switch, so a `scrollTop` applied to the previous element is discarded —
   * MEASURED: the captured element reported `0` for every sample after the switch. The restore therefore waits in
   * `attachFeedObserver`, which runs exactly when the new feed mounts.
   */

  /** when the viewport last moved by the reader's hand — corrections are refused while this is recent (#192) */
  let lastScrollAt = 0;
  /** while now < this, a layout-classified sample may not re-enable the follow (#212) */
  let readerUntil = 0;
  const READER_LOCK_MS = 400;
  /**
   * Re-anchor the view after the feed's content changed size above the viewport.
   *
   * `resyncAfterUnskip` already knows how to do this — it was simply only reachable from `onscroll`, and a
   * content growth is precisely the case where no scroll event fires.
   */
  const reanchorAfterContentChange = () => {
    /**
     * Content growth inside the feed does NOT fire its ResizeObserver (that observes the element's own box), so this
     * mutation path is the only one that sees new rows — and while a tail-seek is in progress it must pin, not
     * re-anchor. MEASURED: coming back to a session that gained rows left a 631px gap with "jump to present" showing,
     * because the rows landed after the switch's frame-count settle and nothing looked at the feed again.
     */
    if (performance.now() < tailSeekingUntil) {
      if (performance.now() < readerUntil) return;
      const f0 = feedEl();
      // unconditionally: during a tail-seek the target IS the bottom, and the measurement can be taken before the
      // new rows have a height at all (distance 0 with an empty box), which is how the pin kept being skipped
      if (f0) pinTailAndRebaseline(f0);
      return;
    }
    if (atBottom()) return; // following the tail: the pin owns the position
    if (!unskipAnchor) return; // nothing has been read yet, so there is no anchor to hold
    const f = feedEl();
    if (!f) return;
    /**
     * A live session mutates the feed every frame (streaming tokens, tool rows), so a correction is scheduled
     * every frame — including while the reader is scrolling. Then the saved anchor is one or two frames old and
     * "correcting" toward it moves the viewport by the distance scrolled since: MEASURED as +154/+188/+407/+656
     * px during an upward scroll, and never in an idle session because nothing scheduled a correction there.
     *
     * So a correction is only allowed once the reader has stopped, and until then the anchor is RE-BASELINED to
     * where they actually are, so the next correction is measured from the right place.
     */
    if (!correctionAllowed(performance.now(), lastScrollAt)) {
      unskipAnchor = firstVisibleRow(f);
      unskipAnchorAt = performance.now();
      return;
    }
    /**
     * Only a change in the CONTENT'S SIZE moves what is on screen, and only that difference is worth correcting.
     *
     * The mutation observer fires for every streaming token and every tool row repaint — most of which change
     * nothing above the viewport, so the honest delta is zero. Correcting anyway used the saved anchor's stale
     * position and moved the viewport by the difference. "タイムラインに新しいイベントが届いた時だけその差分が
     * 補正されればいい" is exactly the rule: measure, and correct only what actually changed.
     */
    if (f.scrollHeight === lastSampleHeight) {
      unskipAnchor = firstVisibleRow(f);
      unskipAnchorAt = performance.now();
      return;
    }
    if (!anchorStillDescribesView(f)) return;
    const before = f.scrollHeight;
    resyncAfterUnskip(f, unskipAnchor, RESYNC_MAX_CONTENT_DELTA_PX);
    lastSampleHeight = f.scrollHeight;
    if (before !== lastSampleHeight) ledger = { top: f.scrollTop, height: f.scrollHeight };
  };
  /**
   * Is the saved anchor still the row at the top of the viewport?
   *
   * `unskipAnchor` is only refreshed by a scroll, so after anything else moved the content it can describe a
   * row that is no longer at the top. Correcting toward such an anchor moves the view by exactly the
   * staleness — an arbitrary jump that looks random and happens "sometimes".
   */
  const anchorStillDescribesView = (f: HTMLElement): boolean => {
    if (!unskipAnchor) return false;
    const first = firstVisibleRow(f);
    if (!first) return false;
    if (first.sel === unskipAnchor.sel) return true;
    // re-baseline instead of correcting toward a row the reader is not looking at
    unskipAnchor = first;
    unskipAnchorAt = performance.now();
    return false;
  };
  const scheduleReanchor = () => {
    if (feedMoRaf) return;
    feedMoRaf = requestAnimationFrame(() => {
      feedMoRaf = 0;
      reanchorAfterContentChange();
    });
  };
  let feedRo: ResizeObserver | undefined;
  let feedRoEl: HTMLElement | undefined;
  let feedRoRaf = 0;
  let feedRoLastBox = "";
  /**
   * Until this moment, the feed is being taken back to the tail — so growth re-pins, whatever `atBottom()` says.
   *
   * MEASURED: leaving a session at its tail, appending six rows while away and coming back left the viewport 583px
   * short with "jump to present" showing. By then `atBottom()` is false, and every pin path is gated on it, so nothing
   * recovers — a frame-count settle cannot cover a session whose rows (and their heights) land later.
   *
   * Set on a session switch, on the terminal drawer opening/closing and on the composer maximizing: all three change the
   * feed's box or content, and all three should keep a follower at the bottom.
   */
  let tailSeekingUntil = 0;
  /**
   * Did the reader INTEND to follow, as of the last reading of their own gesture?
   *
   * A re-wrap can shrink the content so much that the browser clamps `scrollTop` onto the new tail, and then `atBottom()`
   * reads true even though the reader was parked in the middle — which sent them to the bottom on a width change
   * ("画面横幅でズレるのはセッション移動した時以外も"). The intent is what decides: following → the tail, otherwise the
   * anchor.
   */
  let intentFollowing = true;
  let tailWatchRaf = 0;
  /**
   * While a tail-seek is active, pin the feed on every frame — from ONE watchdog, not from per-switch closures.
   *
   * MEASURED: coming back to a session that had gained rows sat 631px above the tail with "jump to present" showing, and
   * a manual `scrollTop = scrollHeight` closed it and kept it closed. So the position was closable and nothing was
   * fighting it — the per-switch settle loop simply never ran, because it bails when `feedGeneration` has moved on (the
   * switch itself increments it, and a second `select()` for the URL does too). This watchdog knows nothing about
   * generations: if a seek is active, the bottom is the target.
   */
  const tailWatch = () => {
    tailWatchRaf = 0;
    if (performance.now() >= tailSeekingUntil) return;
    /**
     * A GESTURE cancels the seek: the operator has taken the viewport over, and a watchdog that keeps pulling would be
     * the "マウスホイールでスクロールできない" bug again. The gesture latch (`readerUntil`) is the same signal every other
     * correction uses.
     */
    if (performance.now() < readerUntil) {
      tailWatchRaf = requestAnimationFrame(tailWatch);
      return;
    }
    const f = feedEl();
    if (f && distanceToTail({ top: f.scrollTop, height: f.scrollHeight, viewport: f.clientHeight }) > 1) {
      pinTailAndRebaseline(f);
    }
    tailWatchRaf = requestAnimationFrame(tailWatch);
  };
  const seekTail = (ms = 1500) => {
    tailSeekingUntil = performance.now() + ms;
    if (!tailWatchRaf) tailWatchRaf = requestAnimationFrame(tailWatch);
  };
  /**
   * Pin, and RE-BASELINE the anchor the layout corrections measure against.
   *
   * A pin that leaves an old `unskipAnchor` behind is undone later: MEASURED, coming back to a session that had gained
   * rows sat at a constant 631px above the tail, because after the seek window expired `reanchorAfterContentChange`
   * "corrected" toward a row captured before the growth and moved the viewport back up.
   */
  const pinTailAndRebaseline = (f: HTMLElement): void => {
    f.scrollTop = f.scrollHeight;
    ledger = { top: f.scrollTop, height: f.scrollHeight };
    setAtBottom(true);
    setMissed(0);
    unskipAnchor = firstVisibleRow(f);
    unskipAnchorAt = performance.now();
  };
  /** the feed's client width at the last box sample — a change means every row re-wrapped */
  let lastFeedWidth = 0;
  /** a width change can move the anchor much further than a scroll correction ever should */
  const RESYNC_MAX_DELTA_PX_RESIZE = 1200;
  const restoreAfterBoxChange = () => {
    feedRoRaf = 0;
    const f = feedEl();
    if (!f) return;

    const contentChanged = f.scrollHeight !== lastSampleHeight;
    lastSampleHeight = f.scrollHeight;
    lastSampleViewport = f.clientHeight;
    const widthChanged = f.clientWidth !== lastFeedWidth;
    lastFeedWidth = f.clientWidth;
    if (!widthChanged && (atBottom() || performance.now() < tailSeekingUntil)) {
      // following stays following: reflow changes every row's height, the tail is still the tail
      pinToTail();
      return;
    }
    if (widthChanged && (intentFollowing || performance.now() < tailSeekingUntil)) {
      pinToTail();
      publishGap(tailSample());
      return;
    }
    /**
     * A WIDTH change re-wraps every row, and the reader must keep looking at the same message.
     *
     * "画面横幅変えた時のタイムライン位置もおかしい (追従なら追従維持、そうでないなら画面内の適当なメッセージをアンカーに
     * する)". Following already returned above; otherwise the last known first-visible row is the anchor, and its own
     * movement is exactly what has to be cancelled. The `anchorStillDescribesView` guard below is skipped on purpose —
     * after a reflow that same row is usually NOT the top row any more, which is why the correction never fired.
     */
    if (widthChanged) {
      /**
       * A width change does not move `scrollTop` — and neither do we.
       *
       * In plain HTML the browser keeps the scroll OFFSET across a resize; only the wrapping changes, so the rows on
       * screen shift but the position does not ("普通にHTML書いてたらそんなことなくない?"). Every earlier attempt to
       * "correct" here is what moved the reader: measuring an anchor before the re-wrap, guessing a delta, clamping it
       * — and one of those paths landed on the tail. The only case that may still move is the browser clamping a
       * position past the end because the content got SHORTER, which nothing can prevent.
       *
       * So: following → stay at the tail; otherwise leave `scrollTop` exactly where the browser left it.
       */
      if (intentFollowing || performance.now() < tailSeekingUntil) pinToTail();
      publishGap(tailSample());
      return;
    }
    if (!contentChanged) {
      /**
       * Keep an anchor warm even when nothing needs correcting.
       *
       * A width change can only be held if SOME row was recorded before it: a page that has not been scrolled yet had
       * none, so the first re-wrap of the window moved the viewport by however much the rows grew ("画面横幅でズレるの
       * はセッション移動した時以外も"). Refreshing it here means the first resize already has one.
       */
      if (!unskipAnchor) {
        unskipAnchor = firstVisibleRow(f);
        unskipAnchorAt = performance.now();
      }
      publishGap(tailSample());
      return;
    }
    if (!correctionAllowed(performance.now(), lastScrollAt)) {
      unskipAnchor = firstVisibleRow(f);
      unskipAnchorAt = performance.now();
      publishGap(tailSample());
      return;
    }
    if (!anchorStillDescribesView(f)) {
      publishGap(tailSample());
      return;
    }
    // the same cap the scroll path uses: an uncapped correction is how a 445px jump got through
    resyncAfterUnskip(f, unskipAnchor, RESYNC_MAX_DELTA_PX);
    publishGap(tailSample());
  };

  function resyncAfterUnskip(
    f: HTMLElement,
    anchor: { sel: string; top: number } | null,
    maxDelta = RESYNC_MAX_DELTA_PX,
  ): void {
    if (!anchor) return;
    const el = f.querySelector<HTMLElement>(anchor.sel);
    if (!el) return;
    const delta = el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) < 1) return;
    if (Math.abs(delta) > maxDelta) return;
    f.scrollTop += delta;
    ledger = { top: f.scrollTop, height: f.scrollHeight };
  }
  const scheduleRestore = () => {
    if (feedRoRaf) return;
    feedRoRaf = requestAnimationFrame(restoreAfterBoxChange);
  };
  /**
   * A reader gesture is an EVENT, not a deduction from geometry.
   *
   * `https://github.com/fluxerapp/fluxer` does exactly this in `useScrollAnchor`: while an anchor is being held, `wheel`,
   * `touchstart`, `touchmove` and `pointerdown` on the container (plus `keydown` on the window) CANCEL it. Nothing
   * infers "the operator is reading" from a `scrollTop` delta.
   *
   * Ours inferred it, and that is the reported bug: "スクロール追従が上向きスクロールだと勘違いしてキャンセルする可能性".
   * Streaming makes the content grow, the browser re-anchors, `scrollTop` moves DOWN a little, and the sample looks
   * like an upward gesture. With gestures as the signal, a growth can never cancel the follow and a real gesture always
   * does — including the ones geometry cannot see (a scrollbar drag, a trackpad fling, a keyboard page-up).
   */
  let detachedGestureListeners: (() => void) | null = null;
  const attachGestureLatch = (f: HTMLElement) => {
    detachedGestureListeners?.();
    const up = (e: Event) => {
      if (!wheelReleasesFollow((e as WheelEvent).deltaY)) return;
      readerUntil = performance.now() + READER_LOCK_MS;
      if (atBottom()) setAtBottom(false);
    };
    const taken = () => {
      readerUntil = performance.now() + READER_LOCK_MS;
      if (atBottom()) setAtBottom(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (keyReleasesFollow(e.key)) taken();
    };
    f.addEventListener("wheel", up, { passive: true });
    f.addEventListener("touchmove", taken, { passive: true });
    f.addEventListener("touchstart", taken, { passive: true });
    // a scrollbar drag and a text selection both start here; fluxer's `useScrollAnchor` cancels on the same event
    f.addEventListener("pointerdown", taken, { passive: true });
    window.addEventListener("keydown", onKey, { capture: true });
    detachedGestureListeners = () => {
      f.removeEventListener("wheel", up);
      f.removeEventListener("touchmove", taken);
      f.removeEventListener("touchstart", taken);
      f.removeEventListener("pointerdown", taken);
      window.removeEventListener("keydown", onKey, { capture: true } as never);
      detachedGestureListeners = null;
    };
  };

  const attachFeedObserver = (f: HTMLElement | null) => {
    if (!f) return;
    attachGestureLatch(f);
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
    /**
     * Watch the CONTENT, not just the box.
     *
     * `.feed` sets `overflow-anchor: none`, so when something above the viewport grows the browser does not
     * compensate and `scrollTop` does not change — which means no `onscroll` either, and the re-anchor
     * (`resyncAfterUnskip`) never ran. A late shiki highlight or an image finishing its load therefore slid
     * what you were reading: "セッション移動後のスクロール追従は確実にバグがある / 数秒後に `v0.37.95 を
     * 公開中` までスクロールが戻る".
     *
     * A mutation covers the highlighting and row insertion; the capture-phase `load` is what catches media
     * that only acquires its height later, since `load` does not bubble.
     */
    // guarded: the smoke harness renders the real bundle in happy-dom, which has no MutationObserver
    if (typeof MutationObserver !== "undefined") {
      feedMo ??= new MutationObserver(scheduleReanchor);
      if (feedMoEl && feedMoEl !== f) feedMoEl.removeEventListener("load", scheduleReanchor, true);
      feedMoEl = f;
      feedMo.observe(f, { childList: true, subtree: true, attributes: true, characterData: true });
      f.addEventListener("load", scheduleReanchor, true);
    }
  };
  onMount(() => {
    window.addEventListener("resize", scheduleRestore);
    onCleanup(() => {
      window.removeEventListener("resize", scheduleRestore);
      feedRo?.disconnect();
      feedRo = undefined;
      feedRoEl = undefined;
      feedMo?.disconnect();
      feedMo = undefined;
      if (feedMoEl) feedMoEl.removeEventListener("load", scheduleReanchor, true);
      feedMoEl = undefined;
      if (feedMoRaf) cancelAnimationFrame(feedMoRaf);
      if (feedRoRaf) cancelAnimationFrame(feedRoRaf);
    });
  });

  /**
   * A `data-eid` selector that also works where `CSS.escape` does not exist (happy-dom).
   *
   * Calling `CSS.escape` unguarded from a rAF/timer throws an uncaught ReferenceError, which took the whole bundle
   * smoke down when the tail watchdog started using `firstVisibleRow` ("UNCAUGHT ReferenceError: CSS is not defined").
   * Event ids are `e<number>`, so the fallback only has to survive quotes and backslashes.
   */
  const eidSelector = (eid: string): string => {
    const esc = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape?.(eid) ?? eid.replace(/["\\]/g, "\\$&");
    return `[data-eid="${esc}"]`;
  };
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
    return eid ? { sel: eidSelector(eid), top: at(found).top } : null;
  }
  /**
   * The details panel has ONE preference per width mode, and its DEFAULT is per mode too.
   *
   * On a narrow display the panel is an overlay on top of the timeline (see the backdrop below), so "in the
   * way" is not a matter of taste — but closing it there must not follow the operator back to a wide display.
   * Two keys, one rule each: whichever mode you are in reads its own key and a manual toggle writes it there;
   * the default is open when wide, closed when narrow.
   * Reported as "幅が狭い表示のときにデフォルトで右パネルを閉じる / これ閉じると元の表示に戻した時に右パネル
   * 閉じられててストレス".
   */
  const panelKey = (narrowNow: boolean) => (narrowNow ? "teapot.panel.narrow" : "teapot.panel");
  const readPanel = (narrowNow: boolean) => {
    const v = localStorage.getItem(panelKey(narrowNow));
    return v === null ? !narrowNow : v === "1";
  };
  const [showRight, setShowRight] = createSignal(readPanel(isNarrow()));
  const setRight = (next: boolean) => {
    setShowRight(next);
    localStorage.setItem(panelKey(narrow()), next ? "1" : "0");
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
    /**
     * Re-read the system preference when the tab becomes visible again.
     *
     * A machine that slept with this tab suspended does not reliably deliver the media query's `change` event
     * on wake — the preference flipped while nothing was listening. Without this, "follow the system" stopped
     * following it in exactly the situation it exists for: colours and background image disagreed with the OS
     * after sleep (#196 "スリープ中に(?)システムテーマが切り替わると背景画像が変わらない").
     */
    const onWake = () => {
      if (document.visibilityState !== "visible") return;
      const now = sysMql?.matches ?? false;
      if (now !== sysPrefersLight()) setSysPrefersLight(now);
    };
    document.addEventListener("visibilitychange", onWake);
    onCleanup(() => {
      sysMql?.removeEventListener("change", onChange);
      document.removeEventListener("visibilitychange", onWake);
    });
  });
  createEffect(() => {
    const { active, repaired } = resolvedPainted();
    const custom = customThemes().find((t) => t.id === active) ?? null;
    if (repaired) {
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
  let pinSettleTimer: ReturnType<typeof setTimeout> | undefined;
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
    /**
     * Two frames is not always enough, and the residual gap is what #188 reports.
     *
     * This effect re-runs when the events change, which is BEFORE images and shiki finish laying out —
     * a picture that decodes a frame later makes the feed taller AFTER the pin, leaving the operator
     * 1-3px short of the bottom with no second pin. So pin again on the next frame if the height moved
     * while we were waiting, and keep the follow decision honest by only doing it while at bottom.
     */
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!atBottom()) return;
        pinToTail();
        // a late layout pass (image decode, font swap, shiki) can grow the feed again
        requestAnimationFrame(() => {
          if (!atBottom()) return;
          const h = f.scrollHeight;
          if (h !== lastContentHeight) {
            lastContentHeight = h;
            pinToTail();
          }
        });
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
    /**
     * Add what the server knows and this client does not — at the END, never in front.
     *
     * This PREPENDED the server's queue entries, so while a POST was in flight the server's copy of the prompt the
     * operator had just typed was placed ahead of its own echo, and two queued prompts came out reversed:
     * "メッセージ1 → メッセージ2 の順で送った結果、タイムライン上では上から 2 → 1 の順に並んでる" (#211).
     */
    // forget ids the server no longer reports: the cancel has been accepted
    if (withdrawnPids.size) {
      const live = new Set(queue.map((q) => String(q.id ?? "")));
      for (const pid of [...withdrawnPids]) if (!live.has(pid)) withdrawnPids.delete(pid);
    }
    const next = mergeQueued(pendingFor(key), queue.filter((q) => !withdrawnPids.has(String(q.id ?? ""))));
    if (next !== pendingFor(key)) writePending(key, next);
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
    /**
     * A background job finishing is a NOTIFICATION, not a conversation turn.
     *
     * It used to be reported only by waking the agent, so suppressing the pointless round for a finished goal also
     * suppressed the only sign the operator had that the job was done — "goal doneで通知しないのは違うのでは?". The bell
     * now fires from the `background-exit` note itself, which is logged whatever the goal state is.
     */
    if (ev.type === "system_note" && ev.data?.event === "background-exit") {
      const who = agents().find((a) => a.id === agentId)?.id ?? agentId;
      const failed = ev.data.failed === true;
      const secs = Math.round(Number(ev.data.durationMs ?? 0) / 1000);
      addNotif({
        agentId,
        kind: failed ? "error" : "progress",
        title: `${who}: ${failed ? "⚠" : "✓"} background job ${String(ev.data.jobId ?? "?")} ` +
          (failed ? `FAILED (exit ${String(ev.data.code ?? "?")})` : `finished (${secs}s)`),
        body: String(ev.data.cmd ?? "").slice(0, 200),
      });
      return;
    }
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
  /**
   * Scroll to one event, and only to the one on screen.
   *
   * `data-eid` is not an identity: ids are per-session counters, so looking one up while the feed still renders the
   * PREVIOUS session finds a row with the same id there and scrolls to it. Reported as a session switch that "flew to
   * `<div class="msg withdrawn" data-eid="e90468" data-session="teapot-10-16854917">`" — a row from the session that
   * was on screen a moment earlier.
   *
   * So the row must match the timeline being shown, and it is waited for (bounded) rather than jumped to after a
   * guessed delay: the notification calls this 350ms/60ms after selecting, and those numbers were the whole
   * synchronisation.
   */
  const jumpToEvent = (eventId: string, tries = 0) => {
    const want = timelineId();
    const el = document.querySelector<HTMLElement>(eidSelector(eventId));
    const ok = !!el && jumpTargetMatches(el.dataset.session, want);
    if (el && ok) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("flash-target");
      setTimeout(() => el.classList.remove("flash-target"), 1600);
      return;
    }
    if (tries < 30) requestAnimationFrame(() => jumpToEvent(eventId, tries + 1));
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
      serverPendingIds: sel()?.pendingPromptIds ?? [],
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
    /**
     * The key must cover EVERYTHING the row renders, not just the id.
     *
     * It was `${id}:${sent}`, so the echo cached before the POST returned kept being handed back after the response
     * labelled it with its `promptId` — and every affordance gated on that id silently never appeared.
     * Reported as "cancelボタンが一番上のやつにしか出てないわ": the row that happened to be cached with a promptId
     * (one that came from the server's queue, which carries the id from the start) kept its ✕ cancel, and every
     * locally cached echo lost it.
     */
    const key = `${p.id}:${p.sent ? "s" : "p"}:${p.promptId ?? ""}`;
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
        /**
         * …but the row only SAYS "queued" when the agent was busy when the prompt was sent.
         *
         * The echo was labelled queued for every send, so a prompt to an IDLE agent flashed "queued…" for a frame or two
         * ("idle状態でプロンプトを送っても一瞬queuedになる問題"). A prompt sent to an idle agent starts it; it queues
         * behind nothing.
         */
        queued: !p.sent && p.queued === true,
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
  /**
   * The ONE way to drop the rendered timeline.
   *
   * `events()` was emptied in three places (session switch, archive, branch switch) but `evCache` was
   * cleared in only the first — so the other two abandoned a whole feed of event objects, and a session
   * that was archived or had its branch changed kept it alive for the life of the tab (#186). Clearing
   * the cache wherever the timeline is emptied makes that divergence impossible.
   */
  const clearTimelineState = (): void => {
    setEvents([]);
    evCache.clear();
    evCacheBytes = 0;
  };
  /** approximate bytes held by `evCache`, maintained incrementally so the cap is cheap to enforce */
  let evCacheBytes = 0;
  const EV_CACHE_MAX = 4000;
  const EV_CACHE_MAX_BYTES = 8 * 1024 * 1024;
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
        /**
         * A COUNT cap lets a handful of huge tool results pin megabytes (#186).
         *
         * MEASURED: the median event is small, but a `tool_result` can be 8,000 chars and an image
         * event carries a data URL — 6,000 entries of those is tens of megabytes of live objects held
         * only for render stability. The cap is also on BYTES now, because "6,000 events" says nothing
         * about how much they weigh.
         */
        evCacheBytes += approxEventBytes(e);
        while (evCache.size > EV_CACHE_MAX || evCacheBytes > EV_CACHE_MAX_BYTES) {
          const oldest = evCache.keys().next().value;
          if (oldest === undefined) break;
          const gone = evCache.get(oldest);
          if (gone) evCacheBytes -= approxEventBytes(gone);
          evCache.delete(oldest);
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

  /**
   * The next `loadEvents` REPLACES the timeline instead of merging into it.
   *
   * Merging is right for a refresh of the session already on screen. After a switch it would mix two sessions' rows
   * (their ids only look unique within a session), so the old array has to go — just not before the new one exists.
   */
  let replaceEventsOnLoad = false;
  /**
   * True while a switch's events are still arriving and the feed is showing the OUTGOING session's rows.
   *
   * Keeping those rows is what removed the empty frame (and with it the ancient-position jump), but it also removed the
   * only feedback the operator had: "loading timeline… が表示されなくなって、遷移中が単にラグいだけの表示になって最悪".
   * The rows stay; a small banner says what is happening.
   */
  const [switchingFeed, setSwitchingFeed] = createSignal(false);

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
      if (replaceEventsOnLoad) {
        replaceEventsOnLoad = false;
        evCache.clear();
        /**
         * Swap the rows and put the viewport where it belongs in the SAME task.
         *
         * A switch replaces every row — the incoming session's events are objects that have never been rendered, so
         * Solid has nothing to reuse and rebuilds the list. During that rebuild the feed is momentarily short and the
         * browser clamps `scrollTop` to 0; MEASURED in real Firefox on two 27k-event sessions, the operator saw that
         * position for about a second (`74405 → 0 → 74373`).
         *
         * Correcting it on the next animation frame is too late — the frame has already painted. Reading `scrollHeight`
         * forces the new layout synchronously, so writing the target here means the collapsed position never reaches
         * the screen, and no hiding or per-frame pinning is needed.
         */
        setEvents(stabilize(ev.events));
        setSwitchingFeed(false);
        const f = feedEl();
        if (f) {
          const spot = scrollSpot.get(tid) ?? scrollSpot.get(id);
          if (!spot) f.scrollTop = f.scrollHeight;
        }
      } else {
        setEvents((prev) => {
          const map = new Map<string, Ev>();
          for (const e of prev) map.set(e.id, e);
          for (const e of stabilize(ev.events)) map.set(e.id, e);
          return [...map.values()].sort((a, b) => a.seq - b.seq);
        });
      }
      setEventsTotal(ev.total ?? ev.events.length);
      setBranches(br.branches);
    } catch {
      // nothing arrived: an empty feed is the honest state, and the next select will replace it atomically
      if (replaceEventsOnLoad) {
        replaceEventsOnLoad = false;
        setSwitchingFeed(false);
        clearTimelineState();
      }
    }
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
  /**
   * Put the viewport on the true bottom, and keep it there until the layout stops moving.
   *
   * `scrollTop = scrollHeight` clamps to the exact (fractional) maximum, so the assignment itself is
   * right. What it cannot do is survive what happens AFTER: a scrollbar that appears or disappears, the
   * composer growing a line, a font or image finishing layout, a row settling. Each of those changes
   * `scrollHeight` or `clientHeight` and leaves the viewport a fraction short — reported as "1秒後に
   * 1pxくらいスクロールが戻される", and as the scrollbar reappearing after it had gone (#188 follow-up).
   *
   * So the pin is re-asserted over the next frames and once more after the layout settles. Every
   * re-check is gated on `atBottom()`, which is false the moment the operator scrolls up — so this can
   * never fight a reader.
   */
  function pinToTail() {

    const f = feedEl();
    if (!f) return;
    const apply = (): boolean => {
      if (!f.isConnected) return false;
      f.scrollTop = f.scrollHeight;
      ledger = { top: f.scrollTop, height: f.scrollHeight };
      return true;
    };
    if (!apply()) return;
    setMissed(0);
    const settle = (frames: number) => {
      if (!f.isConnected || !atBottom()) return;
      if (needsSettlePin(atBottom(), { top: f.scrollTop, height: f.scrollHeight, viewport: f.clientHeight })) apply();
      if (frames > 0) requestAnimationFrame(() => settle(frames - 1));
    };
    requestAnimationFrame(() => settle(2));
    if (pinSettleTimer) clearTimeout(pinSettleTimer);
    pinSettleTimer = setTimeout(() => settle(0), 250);
  }
  function scrollBottom(force = false) {
    if (force || atBottom()) pinToTail();
  }

  const timelineCache = new Map<string, { events: Ev[]; total: number; at: number; bytes: number }>();
  /**
   * Where the operator was reading in each session, taken from the LIVE feed as they leave it (#205).
   *
   * This feature was removed in v0.37.124 after four measured failure modes: a saved anchor from a stale frame
   * (81929 → 53721), a `data-eid` matching a DIFFERENT session, a restore applied to a feed element that had been
   * re-created, and `settle`/`pin-follow` dragging the view back to the tail right after the restore. Every one of them
   * is now structurally impossible: the spot is captured from the outgoing element and carries its session, the
   * restore resolves a ROW (not a number) in the current feed and only then writes `scrollTop`, and the switch's pin
   * stands down entirely when a restore was applied.
   */
  const scrollSpot = new Map<string, SavedSpot>();
  /**
   * Prompt ids this client has withdrawn but the server has not dropped yet.
   *
   * `mergeQueued` tops the list up from the server's `pendingPromptQueue`, so a just-cancelled prompt came straight back
   * — at the END, which also re-ordered everything behind it: "queuedのメッセージ取り消したときにオーダーが乱れる" and the
   * layout churn that came with it.
   */
  const withdrawnPids = new Set<string>();
  /**
   * Row geometry in CONTENT coordinates.
   *
   * `getBoundingClientRect()` is viewport-relative, and the feed element KEEPS its `scrollTop` across a switch (the
   * rows are replaced, the scroll container is not), so a rect top on the incoming session is offset by whatever the
   * outgoing one had scrolled to. Adding the reader's offset to that wrote the wrong `scrollTop` — the restore landed
   * somewhere arbitrary and the operator's verdict was "実測したら一瞬でわかる" (#205).
   *
   * Passing `scrollTop` converts to the coordinate space that survives the switch: distance from the start of content.
   */
  const rowGeometry = (f: HTMLElement, scrollTop = 0, untilBelowTop = false): RowGeom[] => {
    const feedTop = untilBelowTop ? f.getBoundingClientRect().top : Number.NEGATIVE_INFINITY;
    const out: RowGeom[] = [];
    for (const r of f.querySelectorAll<HTMLElement>("[data-eid]")) {
      const b = r.getBoundingClientRect();
      out.push({
        eid: r.dataset.eid ?? "",
        session: r.dataset.session ?? "",
        top: b.top + scrollTop,
        height: b.height,
      });
      // a couple of rows past the edge is all the capture needs, and it keeps the click from laying out 2000 rows
      if (untilBelowTop && b.top > feedTop + 4) break;
    }
    return out;
  };
  /**
   * Scroll position is NOT restored across a session switch.
   *
   * It was, and it caused the same report three times: "セッション遷移したときに遥か昔のメッセージに飛ばされる".
   * The save silently skipped frames where the feed was empty (so an anchor from an EARLIER visit survived), and
   * even with that fixed the feed's re-render on a switch defeats the restore — MEASURED with labelled call sites:
   * the position was applied (`from=2446 delta=-953`) and `settle`/`pin-follow` immediately pulled it back to the
   * tail. Two mechanisms, each individually reasonable, fighting over one value.
   *
   * So a switch opens the timeline where a timeline is read from: the end. Positioning WITHIN a session is
   * untouched, which is the only case that behaves predictably.
   */
  const TIMELINE_CACHE_MAX = 6;
  /**
   * Retained sessions, in bytes, and lower than it was.
   *
   * 24MB of event objects is 1.5-3x that once JS object overhead is counted (each event is a nested
   * object with a `data` sub-object and several strings), so the previous budget could hold ~70MB of
   * heap just to make a switch feel instant (#186). Three sessions is enough for the back-and-forth the
   * operator actually does; beyond that the re-fetch is one request.
   */
  const TIMELINE_CACHE_MAX_BYTES = 8 * 1024 * 1024;
  /**
   * What an event really costs to retain.
   *
   * The old version counted only the top-level string values, ignoring `data`'s own keys and nesting —
   * a `tool_result` with 8,000 chars was counted as ~8KB when the object graph is larger. `weighJson`
   * walks the whole shape (#186).
   */
  const approxEventBytes = (e: Ev): number => weighJson(e);

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
    // "" means "no session resolved", which is NOT the agent id: an agent id in the URL resolves to that
    // agent's latest session, so writing one here merges two tabs onto one timeline
    const tid = resolved ?? requested ?? "";
    if (prevId !== id || tid !== prevTid) {

      if (prevTid && prevEvents.length) {
        const bytes = prevEvents.reduce((n, e) => n + approxEventBytes(e), 0);
        if (bytes <= TIMELINE_CACHE_MAX_BYTES) {
          timelineCache.set(prevTid, { events: prevEvents, total: prevTotal, at: Date.now(), bytes });
        }
        evictOver(timelineCache, { maxEntries: TIMELINE_CACHE_MAX, maxBytes: TIMELINE_CACHE_MAX_BYTES });
      }
      /**
       * Capture the spot from the OUTGOING feed while it still exists.
       *
       * A feed sitting at the tail is nothing worth remembering — remembering "bottom" and restoring it later is how a
       * reader gets pinned where they did not want to be.
       */
      {
        const el = feedEl();
        /**
         * SHOW the switch before measuring anything.
         *
         * The capture below walks the feed's rows, and measuring every row forced a layout of the whole timeline before
         * the click handler could paint — so the operator saw "click → lag → old timeline + loading → new content"
         * instead of the banner appearing immediately ("少なくとも 旧タイムライン表示+loading が先に来るべきでは?").
         * The banner is set here, first, and the measurement after it is bounded to the rows near the top edge.
         */
        setSwitchingFeed(true);
        if (el) {
          /**
           * Key the spot by the session the ROWS declare, not by `timelineId()`.
           *
           * `prevTid` is whatever the timeline resolved to when the switch started, and on a slower machine that can
           * still be the AGENT id for the first frames after a switch — MEASURED as a Windows-only CI failure of the
           * #205 smoke ("landed at 1600, not the 250 the reader left at"), while the same run on Linux saved and
           * restored fine. The rendered rows carry `data-session`, which is the identity that matters, so it wins.
           */
          const rows = rowGeometry(el, 0, true);
          const session = prevTid || rows.find((r) => r.session)?.session || "";
          const here = { top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight };
          // capture in VIEWPORT coordinates (rows and the feed's top are measured the same way)
          const spot = session ? spotFromRows(rows, el.getBoundingClientRect().top, session) : null;
          if (spot && distanceToTail(here) > 1) scrollSpot.set(session, spot);
          else if (session) scrollSpot.delete(session);

        }
      }
      /**
       * Do NOT empty the feed here.
       *
       * `clearTimelineState()` set `events` to `[]`, the feed's rows disappeared for a frame or two, `scrollHeight`
       * collapsed, the browser clamped `scrollTop` to 0 — and when the new rows arrived the viewport was at the TOP,
       * i.e. on the oldest message on screen. Reported as "時々セッションロード時にタイムラインが表示されて、一瞬中身が
       * 空になって、直後に中身が戻ってくる" and, by the operator, as the likely cause of the "遥か昔のタイムライン位置まで
       * 飛ばされる" jumps. The rows are now REPLACED in one `setEvents` when the new session's events land
       * (`replaceEventsOnLoad`), so the feed never has a zero-content frame.
       */
      clearLocallyAnswered();
      replaceEventsOnLoad = true;
      /**
       * No cache for the session being opened → show the LOADING state, not the timeline being left.
       *
       * Keeping the outgoing rows was the fix for the empty-frame scroll jump, but on a FIRST visit there is nothing
       * worth keeping: the operator saw the previous session's tail under a loading banner ("初回遷移では遷移元の
       * タイムライン末尾にloadingがついてる"). With a cache the content is the target session's own, so it is rendered
       * immediately and the swap is a no-op for the eye.
       */
      if (!timelineCache.get(tid)?.events.length) clearTimelineState();
      setSwitchingFeed(true);
      setCompacting(null);
      setMissed(0);
      setAtBottom(true);
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
      requestAnimationFrame(() => {
        if (selected() === id) scrollBottom(true);
      });
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
    setAtBottom(true);
    /**
     * Keep pinning for a few frames, not one.
     *
     * The switch empties the feed and re-fills it in stages (cached events first, then the fetch), so a single
     * `requestAnimationFrame` can pin before the taller render lands — leaving the viewport at whatever scrollTop the
     * shorter render allowed, i.e. an arbitrary position "in the middle of an old conversation". MEASURED while
     * empty: `scrollTop 0, rows 0`. Bounded, and it stops as soon as the tail is reached.
     */
    /**
     * The switch owns the scroll position until the tail is reached — and the backfill runs FIRST.
     *
     * Two separate mistakes made this land in the middle of an old conversation:
     *
     *  1. the pin bailed out when `atBottom()` was false, but a switched-into feed is not "at bottom" yet — it is
     *     empty or short, at `scrollTop 0`. So the guard fired immediately and nothing was ever pinned;
     *  2. `backfillUntilScrollable()` then PREPENDED older pages for a session whose first page did not fill the
     *     viewport. Prepending keeps the visible content still by construction, so the viewport stayed on that old
     *     content while the tail grew far below it.
     *
     * Reported as "セッション移動時のタイムラインスクロールは確実にまだバグが残ってる / mediapad-t5-… を開いたら
     * `1. カーネルが安定して残るようにした ✅` の付近まで飛ばされたし" — an early message of a huge session.
     *
     * So the order is: backfill, then pin; the pin's only veto is that ANOTHER switch took over (feedGeneration) or
     * that the operator is reading (the reader lock), never `atBottom()`.
     */
    const settleGen = feedGeneration;
    /**
     * Keep pinning until the content settles, not until twelve frames have passed.
     *
     * MEASURED in real Firefox: leaving a session at its tail, appending six rows while away, and coming back left the
     * viewport 583px short with the "jump to present" button showing — the follow was not maintained. Twelve frames is
     * ~200ms, and the returned session's rows (and their heights) can land after that; once the gap exists, `atBottom`
     * is false and every other pin path refuses, so nothing recovers.
     *
     * So: a deadline, and re-asserting the follow each time the position is corrected.
     */
    seekTail(3000);
    const settleUntil = performance.now() + 3000;
    const settleAtTail = () => {
      if (selected() !== id || settleGen !== feedGeneration) return;
      if (Date.now() < readerUntil) return;
      const f = feedEl();
      if (f) pinTailAndRebaseline(f);
      if (performance.now() < settleUntil) requestAnimationFrame(settleAtTail);
    };
    /**
     * Restore the reader's place, or land at the tail — never a guess in between (#205).
     *
     * The three answers are deliberately distinct: `applied` means the anchor row was FOUND in this timeline and its
     * position was written; `give-up` means this timeline genuinely does not contain it (deleted message, different
     * branch, older page never loaded) so the tail is the honest answer; `wait` means no rows have rendered yet.
     */
    const attemptRestore = (): "applied" | "wait" | "give-up" => {
      // the spot was keyed by the session the rows carry; `tid` is the same session once it has resolved, and the
      // agent id is the honest fallback for a timeline that has not resolved yet
      const spot = scrollSpot.get(tid) ?? scrollSpot.get(id);
      if (!spot) return "give-up";
      const f = feedEl();
      if (!f) return "wait";
      // content coordinates: the feed still holds the outgoing session's scrollTop
      const rows = rowGeometry(f, f.scrollTop);
      if (!rows.length) return "wait";
      const top = restoreTop(spot, rows, f.scrollHeight - f.clientHeight);

      if (top === null) {
        scrollSpot.delete(tid);
        scrollSpot.delete(id);
        return "give-up";
      }
      f.scrollTop = top;
      /**
       * A restored position is NOT the tail, and every pin path is gated on `atBottom()`.
       *
       * Writing `scrollTop` does not update that signal by itself — the scroll event arrives a frame later — so the
       * events effect saw "still at the bottom" and pinned straight back to the tail. MEASURED: the restore computed
       * 68961 and the feed ended at 74347. Dropping the follow here is the same thing the gesture latch does, and it
       * is honest: after a restore the reader is not following.
       */
      setAtBottom(false);
      readerUntil = performance.now() + READER_LOCK_MS;
      /**
       * …and the switch's tail-seek must be DISARMED, not merely outlived.
       *
       * The watchdog pins every frame for its whole window and only yields to `readerUntil` (400ms), so a restored
       * session was pulled to the bottom a moment later: "ロード中に変な位置 -> アンカーに戻る -> タイムライン一番下に
       * 移動する". A restore is the definitive answer for this switch, so it ends the seek.
       */
      tailSeekingUntil = 0;
      scrollSpot.delete(tid);
      scrollSpot.delete(id);
      /**
       * Close the loop on the anchor row.
       *
       * One open-loop write lands "somewhere near" it: MEASURED in real Firefox on a 99k-event session, the reader sat
       * at `e101165 / 59532px` and came back to `e101166 / 59605px` — off by exactly one row (73px), because the row
       * heights below it were still settling when the position was computed. Re-measuring the anchor and correcting the
       * delta converges in a frame or two and does not care why the layout moved.
       */
      /**
       * Find the row by its data attributes, not by a CSS selector.
       *
       * `CSS.escape` does not exist in happy-dom, and this closure runs from a timer — so the ReferenceError escaped as
       * an uncaught exception and took the whole bundle smoke down with it ("UNCAUGHT ReferenceError: CSS is not
       * defined"). Comparing `dataset` values needs no escaping and cannot be fooled by an id with quotes in it.
       */
      const findAnchor = (): HTMLElement | null => {
        const g = feedEl();
        if (!g) return null;
        for (const el of g.querySelectorAll<HTMLElement>("[data-eid]")) {
          if (el.dataset.eid === spot.eid && el.dataset.session === spot.session) return el;
        }
        return null;
      };
      const settle = (tries: number) => {
        if (selected() !== id) return;
        const g = feedEl();
        if (!g) return;
        const row = findAnchor();
        if (!row) return;
        const want = g.getBoundingClientRect().top - spot.offset;
        const delta = row.getBoundingClientRect().top - want;
        if (Math.abs(delta) < 2 || tries <= 0) return;
        g.scrollTop += delta;
        requestAnimationFrame(() => settle(tries - 1));
      };
      requestAnimationFrame(() => settle(6));
      return "applied";
    };
    void (async () => {
      await backfillUntilScrollable();
      if (selected() !== id || settleGen !== feedGeneration) return;
      /**
       * Give the restore a DEADLINE, not a frame count.
       *
       * Twelve frames is ~200ms on this machine and ~700ms on a slow one, and a session whose events arrive after that
       * window loses its restore entirely — MEASURED as a Windows-only CI failure where the same bundle restored fine
       * on Linux. Waiting on time rather than on frames makes the outcome the same everywhere; the tail is still the
       * answer once the deadline passes.
       */
      const restoreBy = performance.now() + 1500;
      const restoreTries = () => {
        if (selected() !== id || settleGen !== feedGeneration) return;
        const verdict = attemptRestore();
        // a restore that has just been written must NOT be followed by the switch pin, which is what undid this
        // feature in v0.37.124 ("applied tries=0 from=2446 delta=-953" — restored, then dragged back)
        if (verdict === "applied") return;
        if (verdict === "wait" && performance.now() < restoreBy) {
          requestAnimationFrame(restoreTries);
          return;
        }
        requestAnimationFrame(settleAtTail);
      };
      requestAnimationFrame(restoreTries);
    })();
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
      if (msg.kind === "terminal-closed" && msg.terminalId) {
        /**
         * The pty is gone (reaped while nothing was attached, or it exited). Drop the tab so the strip does not keep
         * a control for something that no longer exists — "長時間放置すると開いてたターミナルが消失する" was the tab
         * outliving its shell (#219).
         */
        setTermTabs((list) => {
          const i = list.findIndex((t) => t.key === msg.terminalId);
          if (i < 0) return list;
          flashHint(
            msg.reason === "idle"
              ? "a terminal was closed after being idle — open a new shell with ＋"
              : "a terminal exited",
          );
          return list.filter((_, j) => j !== i);
        });
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
        scheduleFeedRefresh();
      }
      if (document.visibilityState === "hidden") {
        pendingRefresh = true;
        return;
      }
      scheduleFeedRefresh();
    };
    /**
     * Coalesce refreshes into ONE animation frame instead of a 60/120ms timer.
     *
     * A timer lands the re-render AFTER the frame the gesture produced, so the scroll is applied, the picture is
     * stable, and then the feed re-renders underneath it — reported as "スクロールすると何故か微妙なラグの後に
     * スクロール位置がズレる". A frame callback runs before paint, so the anchor correction the refresh performs
     * happens while the position is still being settled rather than as a visible second step. It is also the
     * shape fluxer uses for the same problem (pending value + one rAF flush, no debounce timers).
     */
    let refreshRaf = 0;
    function scheduleFeedRefresh() {
      if (refreshRaf) return;
      refreshRaf = requestAnimationFrame(() => {
        refreshRaf = 0;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        void runFeedRefresh();
      });
    }
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
  /**
   * Write the session into the URL.
   *
   * `sessionId` is a SESSION id, always — `select()` resolves it from session data and never falls back to an
   * agent id, so this function needs no heuristic and cannot be fooled by a stale agent list. An empty value
   * means "this agent has no session resolved yet", and the honest response is to leave the URL alone rather
   * than to invent a link that resolves to something else.
   */
  function navigate(sessionId: string, push = true) {
    if (!sessionId) return;
    const url = `/session/${encodeURIComponent(sessionId)}`;
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
    /**
     * Opening the drawer shrinks the feed, and a follower must end up with the terminal's top edge as its bottom.
     *
     * "ターミナルを開いたときにスクロール追従の基準がターミナルの上辺にならないことがある" — the box changes over a couple
     * of frames (the drawer animates and xterm fits), so a single pin used a stale height. `seekTail` keeps pinning
     * through the transition wherever the content's bottom actually is.
     */
    seekTail(900);
  };

  type TermTab = { key: string; agentId: string; title: string; cwd?: string };
  type TermSession = {
    el: HTMLDivElement;
    term: any;
    fit: any;
    ws: WebSocket;
    ro: ResizeObserver | null;
  };
  const [termTabs, setTermTabs] = createSignal<TermTab[]>([]);
  /**
   * A tab is named after the shell's WORKING DIRECTORY.
   *
   * The operator wants to see where a shell is, but a double-click-to-rename would fight the single click that
   * switches tabs ("シェルのリネームもやりたいけど、タブ切り替えと操作が被る"), and "shell 1 / shell 2" says nothing.
   * The basename is short enough for a tab and the full path is in the tooltip.
   */
  const tabLabel = (t: TermTab) => {
    const base = (t.cwd ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    return base && base.length <= 24 ? base : t.title;
  };
  const refreshTermTabs = async () => {
    const r = (await api("/api/terminals").catch(() => null)) as {
      terminals?: { id: string; agentId: string; title: string; cwd?: string }[];
    } | null;
    const list = r?.terminals ?? [];
    if (!list.length) return;
    setTermTabs((prev) =>
      prev.map((t) => {
        const hit = list.find((x) => x.id === t.key);
        return hit ? { ...t, title: hit.title, cwd: hit.cwd } : t;
      }),
    );
  };
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
      })) as { terminal?: { id: string; agentId: string; title: string; cwd?: string } };
      const t = r.terminal;
      if (!t) {
        flashHint("could not open a shell");
        return;
      }
      const at = indexAfterAppend(termTabs());
      setTermTabs((list) => [...list, { key: t.id, agentId: t.agentId, title: t.title, cwd: t.cwd }]);
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

  /**
   * How opaque the terminal paints itself.
   *
   * xterm draws its own background, so CSS alone cannot let the wallpaper through — the theme value has to carry
   * the alpha, and `allowTransparency` has to be on at construction for xterm to honour it.
   */
  const termAlpha = () => {
    /**
     * Keyed on the SIGNAL, not on `document.documentElement.dataset.bgImage`.
     *
     * The attribute is written by the paint effect, so at the moment a terminal is constructed it may not be set
     * yet — the pane was then built with an opaque theme and stayed black over the wallpaper. A signal is
     * available at construction time and the retint effect already tracks it.
     */
    if (!activeBgImage()) return 1;
    /**
     * 0, not the surface alpha: the drawer IS the surface now (`.termbody`/`.termpane` are transparent), so a
     * half-transparent xterm background on top of it would composite 0.7 over 0.7 into a denser pane than the
     * frame around it. The theme colour stays in the value, at zero alpha, so xterm's own contrast maths still
     * has it.
     */
    return 0;
  };
  createEffect(() => {
    void themeAuto();
    void fixedTheme();
    void sysPrefersLight();
    void sysLightTheme();
    void sysDarkTheme();
    // the wallpaper is what decides the alpha, so it has to be a dependency of this retint
    void activeBgImage();
    const alpha = termAlpha();
    for (const [, s] of liveTerms) retintTerminal(s.term, alpha);
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
    if (s) retintTerminal(s.term, termAlpha());
    if (!s) {
      const el = document.createElement("div");
      el.className = "termsession";
      host.appendChild(el);
      const t = new Terminal({
        cursorBlink: true,
        fontSize: 12.5,
        /**
         * Three lines per wheel notch.
         *
         * The default is ONE line per notch, which on a 40-row drawer is 40 notches for a screenful — reported as
         * "スクロールが1行ずつで遅い" (#172). (Shift+wheel already jumps a page through xterm's built-in
         * `fastScrollModifier` handling; the option itself is not in this version's option type, so only the
         * sensitivity is set here.)
         */
        scrollSensitivity: 3,
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        // xterm only honours a translucent theme background with this on
        allowTransparency: true,
        theme: themeColors(termAlpha()),
      });
      /**
       * Ctrl+Shift+C copies the selection (#198 "ターミナルで Ctrl+Shift+C でコピーできるように").
       *
       * Returning false keeps xterm from sending the chord to the shell, where it would be read as Ctrl+C and
       * interrupt whatever is running — the behaviour the report is actually about. On macOS the same gesture is
       * Cmd+C, which the browser already handles, so only the Ctrl+Shift form is claimed here.
       */
      t.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        if (ev.type !== "keydown") return true;
        if (!(ev.ctrlKey && ev.shiftKey) || ev.altKey) return true;
        if (ev.key !== "C" && ev.key !== "c") return true;
        const sel = t.getSelection();
        if (sel) void navigator.clipboard?.writeText(sel).catch(() => {});
        ev.preventDefault();
        return false;
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
    const onLightboxKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && lightboxSrc()) closeLightbox();
    };
    window.addEventListener("keydown", onLightboxKey);
    onCleanup(() => window.removeEventListener("keydown", onLightboxKey));
    loadCfg();
    refreshAgents().then(async () => {
      await refreshSessionIndex();
      const want = pathId();
      const initial = pickInitialAgent({
        agents: agents(),
        urlId: want,
        ownerOf: (s) => masterSessionIndex().get(s),
        lastId: localStorage.getItem("teapot.session"),
        hideGhosts: hideGhosts(),
      });
      if (initial) select(initial.id, false, want || null);
    });
    refreshMetrics();
    loadTasks();
    loadPersonas();
    connectWs();
    void api("/api/terminals")
      .then((r: { terminals?: { id: string; agentId: string; title: string; cwd?: string }[] }) => {
        const list = r.terminals ?? [];
        if (!list.length) return;
        setTermTabs(list.map((t) => ({ key: t.id, agentId: t.agentId, title: t.title, cwd: t.cwd })));
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
  /**
   * A content growth may move things further than an engine-initiated scroll tweak, and it is still safe to
   * correct: this path only runs on a DOM change, never on a gesture, so there is no reader intent to fight.
   */
  const RESYNC_MAX_CONTENT_DELTA_PX = 1_200;
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
  const sendText = async (text: string, targetId?: string) => {
    const id = targetId ?? selected();
    if (!id) return;
    const images = pendingImages();
    const echoKey = agents().find((a) => a.id === id)?.session || id;
    /**
     * The optimistic row exists BEFORE the request, and is only LABELLED by it.
     *
     * It used to be added after `await`, so the server's own broadcast (which happens inside `enqueuePrompt`, before
     * the response) rendered the real prompt row first and the echo appeared afterwards as a second "queued" row.
     * With two messages in flight that is a visible reorder, and alone it is the moment where a queued message
     * briefly is not queued: "queuedになるメッセージを送信したときに、一瞬queuedじゃない表示になる、2個以上queuedが
     * あったら何故か一瞬並び替わる" (#211).
     */
    // captured BEFORE any await: see the pin at the end of this function
    const wasFollowing = atBottom();
    /**
     * "Queued" means something is AHEAD of this prompt — not "the agent happened to look busy".
     *
     * `isSelLive()` was the previous test and it produced exactly the flicker the operator recorded: the client's view of
     * the agent can be one snapshot stale at send time, so the row appeared un-queued, then flipped to queued when the
     * snapshot caught up ("非queuedで、queuedより先に挿入 -> queuedになってオーダーが直る"). Counting what is already
     * waiting is a fact the client can answer locally and it does not change while the row exists:
     *
     *   - nothing waiting → this prompt STARTS the agent, so it is not queued (and never becomes queued);
     *   - something waiting → it queues behind that, from the first frame.
     */
    const queuedBehindTurn = queuedOnSend(sel()?.pendingPrompts, pendingFor(echoKey).length);
    const localId = `@p${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    writePending(echoKey, [
      ...pendingFor(echoKey),
      {
        id: localId,
        text,
        at: Date.now(),
        ...(queuedBehindTurn ? { queued: true } : {}),
        ...(images.length ? { images: images.map((i) => i.url) } : {}),
      },
    ]);
    try {
      const r = await api(`/api/agents/${id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, start: true, ...(images.length ? { images } : {}) }),
      });
      const pid = (r as { promptId?: string }).promptId;
      if (pid) {
        writePending(
          echoKey,
          pendingFor(echoKey).map((p) => (p.id === localId ? { ...p, promptId: pid } : p)),
        );
      }
      setPendingImages([]);
      if (shouldRestoreAfterSend(composerMaximized())) setComposerMaximized(false);
      autosizeComposer();
      /**
       * Restore the follow the reader HAD when they pressed send.
       *
       * The end of this function is many awaits later, and the follow may have been dropped in between by a transient
       * (a pointerdown in the feed, a sample the geometry classified as a read) — the operator then typed a message and
       * watched it not arrive: "プロンプトを送ったときにスクロール追従が働かないことがある". Reading the state AFTER the
       * send was the mistake; the decision belongs to the moment the operator hit send, and it must not move someone who
       * deliberately scrolled up to read history (#send-scroll).
       */
      if (wasFollowing) {
        setAtBottom(true);
        setMissed(0);
        readerUntil = 0;
        /**
         * Arm the tail watchdog instead of pinning twice by hand.
         *
         * MEASURED in real Firefox: the FIRST send after a page load left the viewport exactly one row short (48px, with
         * "jump to present" showing). The pin ran before the new echo row had its final height, and the 48px gap then
         * put `atBottom()` out of its tolerance, so every later pin — including `pinToTail`'s own settle frames — was
         * gated off. The watchdog pins every frame for the window and ignores `atBottom()`, which is the same fix that
         * made session switches reliable.
         */
        seekTail(700);
      }
    } catch (ex) {
      // the optimistic row must not survive a send that never happened
      writePending(echoKey, pendingFor(echoKey).filter((p) => p.id !== localId));
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
        // the harness wording is the SERVER's to write; the browser only names the skill
        await post("/skill", { name: arg });
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
      clearTimelineState();
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
  /**
   * The goal boxes' heights are owned by `bindStoredHeight` — NOT by a JSX `style` object.
   *
   * They used to be applied through `style={{ height: stored > 0 ? … }}`, and Solid's style binding REMOVES a
   * property that is absent from the object it is handed. Setting a goal calls `refreshAgents`, which replaces the
   * selected agent object and re-renders this panel: the style object was written again without `height`, the inline
   * height was dropped, and the box fell back to its content height — "goalの表示欄が、set goalをしたときに元の高さが
   * 尊重されずに…デフォルトの高さになる場合がある". That is why a repro was hard to pin down: the value was still in
   * `localStorage`, so a reload sometimes brought the height back.
   */
  const goalPreviewStyle = (): Record<string, string> => ({
    "max-height": "none",
    "overflow-y": "auto",
    resize: "vertical",
  });
  const trackGoalPreviewHeight = (el: HTMLElement) => {
    onCleanup(bindStoredHeight(el, "goalPreview"));
  };
  const trackGoalHeight = (el: HTMLTextAreaElement) => {
    onCleanup(bindStoredHeight(el, "goal"));
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
                ><span class="wscaret">{row.wsCollapsedGroup ? "▸" : "▾"}</span>
                {/* a flex item needs min-width: 0 for its text to be able to shrink, otherwise a long directory name
                    stretches the row and the whole left panel scrolls sideways — the chat name already has this */}
                <span class="wsname" title={row.wsHeader}>{basenameOf(row.wsHeader!)}</span>
                  {}
                  {/**
                    * The count is a COLLAPSED-state hint, like the sub-agent one below it.
                    *
                    * It used to show whenever the directory held more than one chat, so an expanded group carried a
                    * number nobody needed while its sub-agent rows dropped theirs — "ワーキングディレクトリは常にカウントが
                    * 出てる / ワークスペース側を展開で消して欲しい".
                    */}
                  <Show when={row.wsCollapsedGroup}>
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
                {/* The count always shows, collapsed or not — the same rule the workspace header above follows.
                    Reported: "サブエージェントは展開するとカウントが消えるのに、ワーキングディレクトリは常にカウントが
                    出てる". Two row kinds, one question ("how much is in here?"), so one behaviour. */}
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
              <Show when={metrics().arrayBuffersMb !== undefined}> · buf {metrics().arrayBuffersMb}MB</Show>
              <br />
              <Show when={metrics().messagesInMemory !== undefined}>
                msgs {metrics().messagesInMemory} in {metrics().loadedSessions} loaded session(s)
                <br />
              </Show>
              load1 {metrics().loadavg1} · up {Math.floor(metrics().uptimeSec / 60)}m
            </Show>
          </div>
        </div>
      </nav>

      {}
      <section class="channel" style={{ "--termh": `${termHeight()}px` } as any}>
        {}
        {/**
          * NOT `keyed`: switching agents must not re-create the channel.
          *
          * With `keyed`, every switch disposed the whole subtree — including the `.feed` element — so the new feed
          * mounted with `scrollTop: 0` while the rows were re-rendered inside it. MEASURED in real Firefox on two
          * 27k-event sessions: the same rows were on screen (`first=e25273 last=e27261` before AND after) but the
          * viewport sat at `top=0` for ~650ms, which is the "あらぬ場所にスクロールが飛ばされる" report and also why the
          * switch read as "old timeline + loading" — it was the TOP of the old timeline.
          *
          * Everything inside reads the same signals (`sel()`, `events()`), so it updates in place without being
          * rebuilt; the rows are diffed by `<For>` and the element keeps its scroll position.
          */}
        <Show when={sel()?.id} fallback={<div style="display:grid;place-items:center;height:100%" class="muted">select an agent</div>}>
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
            {/*
              * Count comes from the live agent snapshot, so it is right without a click (#197
              * "クリックしないと値更新されなかった"), and it only exists while something IS running: a
              * "1 done" badge was both unclear and a layout shift, because the text changed width as jobs
              * started and finished.
              */}
            <Show when={(sel()?.bgRunning ?? 0) > 0}>
              <button
                type="button"
                class="badge bgjobs"
                aria-expanded={showBg()}
                onclick={() => {
                  setShowBg(!showBg());
                  if (showBg()) void refreshBg();
                }}
                title={`${sel()!.bgRunning} background shell(s) running — click to inspect`}
              >
                ⚙️ {sel()!.bgRunning}
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
            /**
             * NO correction here any more — this is the gesture itself.
             *
             * `unskipAnchor` is at best ~100ms old, so correcting toward it during a scroll moves the viewport by
             * however far the content travelled in that window. MEASURED from the operator's trace by scrolling a
             * real session upward: backward jumps of +56 / +64 / +121 / +125 px with `内容高差 = 0`, i.e. no
             * layout change at all — just the correction fighting the gesture.
             *
             * Layout corrections now happen only AFTER the fact: `reanchorAfterContentChange` (a rAF after the DOM
             * actually changed) and `restoreAfterBoxChange` (the viewport changed). Both refuse to correct toward
             * an anchor that no longer describes the top row, which during a scroll is every frame.
             */
            void cause;
            ledger = null;
            lastScrollAt = performance.now();
            /**
             * The PREVIOUS top has to be read before `lastSample` is overwritten.
             *
             * `movedUp` compares against `lastSample.top`, and this handler used to assign `lastSample = now` a few
             * lines earlier — so the comparison was always `now.top < now.top`, i.e. FALSE, and no upward gesture was
             * ever recognised. Everything that keys off it went with it: the reader lock, `movedUp` winning over the
             * layout classifier, and `nextFollowing`'s previous-top argument (which was handed the CURRENT top).
             * The result is the trace the operator pasted from a real browser — every streaming delta re-pinned the
             * tail and dragged the reader back down (`124596 → 124592 → 124596` over and over) — and it is why
             * "上に行こうとすると押し戻される" survived several releases (#212).
             */
            const prevTop = lastSample?.top;
            const prevHeight = lastSample?.height;
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
            /**
             * The previous top is what lets a READER's upward gesture be told from a layout shift (#188).
             *
             * And an upward move wins over the classifier: whatever `cause` says, the content did not move under
             * the operator — they moved it. Reported as "アイドル状態でもタイムライン一番下から1つ上にスクロール
             * するときに、ブラウザの補助アニメーションなしでいきなりその高さまで遷移することがある": while
             * `following` stayed true, `pinned` re-asserted the tail and the notch was undone instantly.
             */
            /**
             * A CHANGE IN CONTENT HEIGHT is not a gesture, in EITHER direction.
             *
             * Growing moves `scrollTop` down (the browser re-anchors when content is inserted above the viewport);
             * SHRINKING clamps it down too, and that is the reported one: "スクロール追従が thinkingのライブ終了で折り
             * たたみ -> bash みたいなタイミングで外れる". When the live bubble collapses into a tool row the feed gets
             * shorter, the browser pulls `scrollTop` back, and the sample looked like the operator scrolling up.
             *
             * Gestures latch the follow themselves now (`wheel`/`touch`/`key`/`pointerdown`), so geometry only has to
             * answer the remaining case: the viewport moved up while the content did not change at all.
             */
            const heightChanged = prevHeight !== undefined && Math.abs(now.height - prevHeight) > 0.5;
            const movedUp = prevTop !== undefined && now.top < prevTop - 0.5 && !heightChanged;
            if (movedUp) readerUntil = performance.now() + READER_LOCK_MS;
            /**
             * A reader's upward move LOCKS the follow for a moment, not just for this event.
             *
             * `nextFollowing` already stops following on an upward move it classifies as `reader`, and the previous
             * change made an upward move win outright. That is still per-event: the next mutation or layout-classified
             * sample inside the 24px tolerance re-enabled the pin and shoved the operator back — reported as
             * "生成中に上に行こうとすると押し戻される / タッチUIで操作しづらい". Touch scrolling produces exactly that
             * pattern: many small samples, some of them classified as layout.
             */
            /**
             * Back at the tail → follow again, immediately.
             *
             * The reader lock must not outlive the reason for it: once the operator is at the bottom again they are
             * following the stream, and the lock used to hold the follow off for another 400ms after a deliberate
             * scroll back (measured as a follower left 20px short of the tail as the composer grew).
             */
            const follow = movedUp
              ? false
              : atTail(now)
                ? true
                : performance.now() < readerUntil
                  ? false
                  : nextFollowing(wasFollowing, cause, now, prevTop);
            intentFollowing = follow;
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
              /**
               * `switchingFeed()` belongs here, not only in the banner inside the list: when an uncached switch
               * empties the feed, this fallback IS the whole view, and without it the operator sees "no events yet —
               * say something" during a load.
               */
              loadingFeed() || switchingFeed()
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
                      /**
                       * Offered from the FIRST paint of a queued echo.
                       *
                       * It used to need `row.data.promptId`, which only exists once the POST returns — so the button
                       * appeared a frame or two after the row and re-flowed the header: "cancelボタンの描画が多分遅延してる /
                       * queueの先読みとか、cancelとかその辺のレイアウトが確定してからタイムラインに表示されるべき". The id
                       * is resolved when the operator actually clicks, which is always after the response.
                       */
                      row.data?.source === "user" &&
                      row.data?.pending && row.data?.sent !== true
                        ? () => {
                            const echo = pendingFor(pendingKey()).find((p) => p.id === row.id);
                            const pid = String(echo?.promptId ?? row.data?.promptId ?? "");
                            if (!pid) {
                              flashHint("still being sent — try again in a moment");
                              return;
                            }
                            const wasFollowing = atBottom();
                            api(`/api/agents/${selected()}/prompt/cancel`, {
                              method: "POST",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({ promptId: pid }),
                            })
                              .then((r: any) => {
                                const back = String(r.text ?? "");
                                saveDraft(draft() ? `${back}\n\n${draft()}` : back);
                                withdrawnPids.add(pid);
                                writePending(pendingKey(), pendingMsgs().filter((p) => p.promptId !== pid));
                                /**
                                 * Removing a row makes the feed shorter, and the browser clamps `scrollTop` with it —
                                 * "queuedなメッセージをcancelしたときにスクロールが必要以上に押し戻される". A follower
                                 * goes back to the tail; a reader keeps the row they were looking at.
                                 */
                                const f = feedEl();
                                if (wasFollowing) seekTail(400);
                                else if (f) {
                                  unskipAnchor = firstVisibleRow(f);
                                  unskipAnchorAt = performance.now();
                                }
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
              <Show when={switchingFeed()}>
                <div class="feedloading">
                  <span class="spinner" aria-hidden="true" /> loading timeline…
                </div>
              </Show>
              <Show when={loadingFeed() && !switchingFeed()}>
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

          {/*
            * One overlay for every image in the app (#204 "添付画像やread_fileの画像をクリックしたら拡大するように").
            * Clicking the backdrop, the image, or pressing Escape closes it — the same three ways out that every
            * lightbox has, because a modal you cannot dismiss by the obvious gesture is worse than no modal.
            */}
          <Show when={lightboxSrc()}>
            {(src) => (
              <div
                class="lightbox"
                role="dialog"
                aria-modal="true"
                aria-label="enlarged image"
                onclick={closeLightbox}
                title="click to close"
              >
                <img src={src()} alt="" onclick={(e) => e.stopPropagation()} />
              </div>
            )}
          </Show>
          <Show when={termOpen()}>
            <div class="termdrawer" style={{ height: `${termHeight()}px` } as any}>
              <div class="termgrip" onpointerdown={startGrip} ondblclick={() => { setTermHeight(Math.max(220, Math.round(window.innerHeight * 0.35))); localStorage.setItem("teapot.termH", String(termHeight())); }} title="drag to resize · double-click to reset" />
              <div class="termbar">
                <div class="termtabs">
                  <For each={termTabs()}>
                    {(t, i) => (
                      <span
                        class={"termtab" + (focusedPane() === 0 && paneL() === i() ? " active" : "") + (splitView() && focusedPane() === 1 && paneR() === i() ? " active" : "")}
                        onclick={() => {
                          focusTab(i());
                          // the shell's cwd moves with `cd`, so the label is refreshed when the operator looks at
                          // it rather than on a poll (#198 follow-up: "ワーキングディレクトリをタイトルにするでもいい")
                          void refreshTermTabs();
                        }}
                        title={`${t.cwd ? `${t.cwd}\n` : ""}${t.title} — click to show in focused pane`}
                      >
                        ⌨ {tabLabel(t)}
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
            {/**
              * Attachments live ABOVE the prompt box, in their own row.
              *
              * They used to be the first child of the `form`, which is a flex row ending in the buttons — so the
              * chips shoved the textarea aside and the counter became a `🖼 2` chip sitting next to `send`
              * ("添付ファイル欄の設計微妙すぎる (send左の 🖼 2 も含めて) / 多分入力欄上にやったほうがいい").
              * The counter is gone with them: the chips ARE the count.
              */}
            <Show when={pendingImages().length > 0}>
              <div class="attachrow">
                <For each={pendingImages()}>
                  {(im, i) => (
                    <span class="imgchip" title={im.name}>
                      <img src={im.url} alt={im.name} title="click to enlarge" onclick={() => openLightbox(im.url)} />
                      <button
                        type="button"
                        class="imgx"
                        title="remove"
                        onclick={() => setPendingImages((l) => l.filter((_, j) => j !== i()))}
                      >✕</button>
                    </span>
                  )}
                </For>
                <button
                  type="button"
                  class="attachclear"
                  title="remove every attachment"
                  onclick={() => setPendingImages([])}
                >clear</button>
              </div>
            </Show>
            <form onsubmit={send}>
              {}
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
                  seekTail(900);
                  requestAnimationFrame(() => autosizeComposer());
                }}
              >{composerMaximized() ? "⤡" : "⤢"}</button>
              <IconBtn
                icon="📎"
                title="attach images (or paste them straight into the box)"
                onClick={() => document.getElementById("composer-file")?.click()}
              />
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
                title="auto-continue acts on the GOAL above: it fires after a round ONLY when all hold — ① this toggle is on ② a goal is set and its status is 'active' ③ the round ended cleanly (no error / not stopped). It stops when the goal is marked done, or if you press ■ stop."
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
                    clearTimelineState();
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
                      // the jump waits for the row to exist on the timeline being shown; no guessed delay
                      jumpToEvent(n.eventId!);
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
        onCreated={(created) => {
          setShowNew(false);
          /**
           * Wait for the new agent AND its session to be indexed before selecting.
           *
           * `select(id)` alone resolves `tid` from `sessionsByAgent()`, which is empty for an agent created a
           * moment ago, so it fell back to the AGENT id. `navigate()` then asked `linkableSessionId()` about
           * it, and that guard only refuses agent ids it KNOWS — it read `agents()` before the refresh had
           * landed — so the URL became `/session/<agent-id>` and the header showed a bare internal id.
           * Reported as "新しくセッションを作ったときにセッション名が内部IDになって、URLがエージェント間
           * メッセージ用の短縮名になる" / "別のセッションに行って戻ると正しいIDに戻る".
           */
          /**
           * Take the server's snapshot as the truth, then select.
           *
           * `select()` resolves the timeline from session data — the index first, then the agent's own
           * `session` field — so all this needs is for the agent to be in the list. Merging the snapshot does
           * that synchronously; refreshing from the API first would leave a window in which `select()` runs
           * against a list that does not contain the agent yet, which is how the URL ended up as the agent id.
           */
          setAgents((prev) => mergeAgentSnapshots(prev, [created as never]));
          select(created.id);
        }}
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
function NewAgentModal(props: {
  providers: string[];
  onClose: () => void;
  /** the server's own view of the new agent — its `session` is authoritative and the local index is not */
  onCreated: (agent: { id: string; session?: string }) => void;
}) {
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
      props.onCreated(r.agent as { id: string; session?: string });
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
