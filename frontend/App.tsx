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
// descendant-aware counting, so the 🧩 badge matches the real subtree.
import { descendantsOf, shouldShowCollapseCaret, subAgentDisplayName } from "./lib/sidebar-tree";
// extracted so the tests drive the code that runs — they used to carry their
// own copy, and deleting the real execCommand fallback left them green.
import { copyText } from "./lib/clipboard";
import { groupedWith, type RowLike } from "./lib/row-grouping";
import { answeredQuestionIdsOf, type QuestionEvent } from "./lib/question-answered";
import { reconcilePending, type PendingEcho } from "./lib/pending-echo";
// pure + exported, so the session switcher is testable rather than re-implemented
import { linkableSessionId, resolveTimelineSession } from "./lib/session-index";
import { rememberTextareaHeight, storedTextareaHeight, trackTextareaHeight } from "./lib/textarea-size";
// the scope predicates are PRODUCTION, so the tests can assert the same code
// the handler runs — a test-local copy proves nothing
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

/* Rendered-markdown cache: old messages were re-parsing their whole body on
 * EVERY prepend/refresh pass (scrolling back through a long session parsed
 * the same text over and over — visibly heavy). Event content is immutable,
 * so a small LRU keyed by the source string makes repeat renders free. */
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

/** Reasoning-effort levels OpenRouter documents for `reasoning_effort` (#47). */
const REASONING_EFFORT_OPTIONS = ["minimal", "low", "medium", "high"] as const;

/** Width at which the right bar becomes a floating drawer over the content.
 *  MUST stay equal to the `@media (max-width: 1100px)` breakpoint in app.css —
 *  the JS drives the drawer state, the CSS positions it, and they only agree if
 *  both are 1100. */
const NARROW_PX = 1100;

/* ---------- types ---------- */
interface Agent {
  /**
   * The agent's display slug (`tyb2-9`). NOT an internal identifier.
   *
   * Two things are called "id" here and mixing them caused a real bug: the ⏳ badge counted THIS
   * agent's `pendingPrompts` while the feed rendered the VIEWED session's echoes, so a session
   * showed a queue it did not have. When a field could be either, name it (`agentId` /
   * `sessionId`) — `id` alone is ambiguous wherever `session` is also in scope.
   */
  id: string; status: string; statusReason: string; workspace: string;
  /** is work in flight that `stop` would stop? `status` alone cannot say — a
   *  parked tool and queued prompts are both live while status reads "idle" */
  live?: boolean;
  /** the INTERNAL session id (also its directory name) — never the display slug */
  session: string; branch: string; goal: { status: string; text: string; verify?: string; audit?: { verdict: "approved" | "changes-required"; feedback: string; at: string } };
  /** #155: a short label derived from the session's first user prompt. Absent
   *  when that prompt had no usable line — the sidebar falls back to the id. */
  sessionTitle?: string;
  workspaceMissing?: boolean;
  latestProgress: any; stats: any; model: string; provider?: string;
  /** reasoning effort in force, and whether this model accepts one (#47) */
  reasoningEffort?: string; effortSupported?: boolean; effortOptions?: string[];
  pendingPrompts?: number;
  /** #78: the ids of the still-queued prompts, so the UI can reconcile by IDENTITY */
  pendingPromptIds?: string[];
  /** #87: the queue WITH its text, so echoes survive a reload */
  pendingPromptQueue?: { id: string; text: string; source?: string; at?: number; images?: { url: string; name?: string }[] }[];
  todo?: string;
  parent?: string;
  autoContinue?: boolean;
  autoCompact?: boolean;
  ctx?: { usedTokens: number; compactAt: number; window: number; compactAtIsManual?: boolean; compacting?: string };
}



/* ---------- transient toast hint (module scope: also used by SwitchContent) ---------- */
const [flash, setFlash] = createSignal("");
let flashTimer: ReturnType<typeof setTimeout> | undefined;
const flashHint = (msg: string) => {
  setFlash(msg);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setFlash(""), 3200);
};

/* ---------- IME composition (Safari) ---------- */
// KeyboardEvent.isComposing is NOT reliable for this: Safari fires
// compositionend BEFORE the final keydown for Enter, so by the time the
// keydown handler asks, isComposing is already false and Enter gets SENT
// instead of confirming the conversion — the half-converted text went to the
// model and the user's kana/kanji input was swallowed. Track composition
// ourselves and clear it on the next frame, after that keydown has run.
// (ported from #12)
let imeInProgress = false;

/* ---------- themes ---------- */

/** author for an event — mirrored sub-agent rows act under their own id */

// state/error/fork/goal render as dividers or embeds inside the feed
const FEED_TYPES = new Set([
  "user", "message", "prompt", "tool_call", "tool_result", "progress",
  "state", "error", "fork", "goal", "todo", "question", "decision", "compaction",
  "audit_step",
  "system_note",
  // NOTE: "sub" is deliberately NOT here. A child's activity is no longer
  // mirrored into the parent's log — those rows flooded the parent's
  // timeline, and they were display-only anyway: `rebuildMessagesFrom` never
  // read them, so the model never saw them either. A chat's timeline is its own.
  // The expansion below still handles a `sub` row so an OLD log that already
  // contains one renders as an attributed child row rather than vanishing.
]);
// system_note rows never render, but prompt-delivered must refresh the feed so the logged prompt
// row replaces the pending echo immediately.
const NOTE_FEED_TYPES = new Set(["system_note"]);

/**
 * Types that actually DRAW a row: `FEED_TYPES` minus the ones that pass the filter but render
 * nothing. A type with no render branch still becomes its neighbours' grouping `prev`, and
 * `groupedWith()` keys on TYPE — so an invisible row splits a run of tool calls in half.
 *
 * Kept explicit so adding a feed type without a render branch is a visible omission.
 */
const RENDERED_TYPES = new Set([
  "user", "message", "prompt", "tool_call", "tool_result", "progress",
  "error", "fork", "goal", "todo", "question", "decision", "compaction", "audit_step",
]);

/** system_note shapes that DO draw a divider/embed; the rest are log-only. */
const RENDERED_NOTE_EVENTS = new Set([
  "runaway-detected",
  "error-retry",
  "background-exit",
  "context-compacted",
  "context-compaction-started",
]);


// TEAPOT_API_TOKEN flow: open the UI as http://host/#token=<secret> once —
// it is stored and stripped from the URL, then attached to every request.
const hashTok = location.hash.match(/[#&]token=([^&]+)/);
if (hashTok) {
  localStorage.setItem("teapot.token", decodeURIComponent(hashTok[1]));
  history.replaceState(null, "", location.pathname + location.search);
}
const wsTokenQuery = () => {
  const t = localStorage.getItem("teapot.token");
  return t ? `?token=${encodeURIComponent(t)}` : "";
};

/* ---------- app ---------- */


export default function App() {
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [selected, setSelected] = createSignal<string | null>(null);
  // internal session id backing the currently viewed timeline — the stable
  // handle behind /session/<id> URLs and every events fetch (?session=…)
  const [timelineId, setTimelineId] = createSignal<string>("");
  // internal session id → owning agent id, and agent id → its session ids
  // (newest first) — ONE /api/sessions call serves every agent, refetched
  // only when the agent SET changes (not on every poll: the fan-out of one
  // request per agent per switch hammered the server for identical data)
  const [masterSessionIndex, setMasterSessionIndex] = createSignal<Map<string, string>>(new Map());
  const [sessionsByAgent, setSessionsByAgent] = createSignal<Map<string, string[]>>(new Map());
  /**
   * session id → human title, from `/api/sessions`.
   *
   * The per-agent snapshot also carries a title, but only for a session whose agent
   * has been RESTORED. Boot leaves agents stopped, so the sidebar would show raw ids
   * for every session the operator has not opened — i.e. the ones they most need to
   * tell apart. This index is built from the logs themselves and covers all of them.
   */
  const [sessionTitles, setSessionTitles] = createSignal<Map<string, string>>(new Map());
  let indexFetched = false;
  /** the request in flight, so concurrent callers await the SAME one */
  let indexInFlight: Promise<void> | null = null;
  /**
   * Fetch the session index once, sharing the in-flight request between callers.
   *
   * The latch means "LANDED", not "started". Setting it before the `await` let a second caller
   * return immediately with the index still empty — MEASURED at boot: `refreshAgents()` fires an
   * un-awaited refresh, `onMount` awaits its own, gets nothing, finds no owner for the deep link,
   * and falls through to `localStorage`, opening ANOTHER agent's session under this URL
   * (want=tyb2-8-0161a4af owner=undefined idx=0).
   *
   * `force` refetches; a failed fetch leaves the latch clear so it can be retried.
   */
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
          list.push(s.id); // server returns newest first
          byAgent.set(s.agentId, list);
        }
        setMasterSessionIndex(byId);
        setSessionsByAgent(byAgent);
        setSessionTitles(titles);
        indexFetched = true;
      } catch {
        /* transient — the latch stays clear so the next caller retries */
      }
    })();
    indexInFlight = run;
    try {
      await run;
    } finally {
      // only clear OUR entry: a `force` refetch started while this one ran owns the slot now
      if (indexInFlight === run) indexInFlight = null;
    }
  }
  const [events, setEvents] = createSignal<Ev[]>([]);
  const [eventsTotal, setEventsTotal] = createSignal(0); // server-side count (window is capped)
  const [branches, setBranches] = createSignal<any[]>([]);
  const [metrics, setMetrics] = createSignal<any>(null);
  // per-session unsent prompt drafts — switching agents preserves what each
  // one was typing instead of showing the previous session's text
  const drafts = new Map<string, string>();
  const [draft, setDraft] = createSignal(drafts.get(selected() ?? "") ?? "");
  const saveDraft = (v: string) => {
    setDraft(v);
    const id = selected();
    if (id) {
      if (v) drafts.set(id, v);
      else drafts.delete(id); // cleared input → nothing to preserve
    }
  };
  const [cfg, setCfg] = createSignal<any>({ providers: {} });
  const [showNew, setShowNew] = createSignal(false);
  /** the ladder lives in `bg-srcset.ts`, shared with the appearance preview */

  /**
   * The active custom theme's background image, if any.
   *
   * Resolved with the SAME precedence as the painter (`themeAuto` → per-mode id, else the fixed
   * id), because a srcset pointing at one theme's image while another is painted is exactly the
   * kind of drift that makes a setting look broken.
   */
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
  /**
   * The theme id ACTUALLY PAINTED — the same resolution the painting effect uses.
   *
   * With "follow the system" the document is painted with the per-mode choice, not with
   * `fixedTheme()`. Anything that reads LIVE colours from the document (theme duplication does)
   * must also take its NAME from here, or the two describe different themes.
   */
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
  /**
   * FIRST RUN: open settings on `providers`, once, and let it be closed.
   *
   * The setup wizard is gone. It replaced the whole layout and blocked everything until a provider
   * was configured, which is a heavier gate than the situation needs — the operator may well want
   * to look at an existing session, or the config may be fine except for one missing key.
   *
   * `needsSetup` now means "no provider registered" (see `/api/config`), and this is a nudge rather
   * than a wall: the panel opens, closed by the ordinary ✕/esc, and nothing re-opens it. The
   * `nudged` flag is what makes it once-only — without it, every `loadCfg()` refresh would reopen
   * the dialog the operator just dismissed.
   *
   * Deferred a frame so it opens AFTER the first paint: opening during mount made the dialog appear
   * before the sidebar behind it, which read as the app failing to load.
   */
  let setupNudged = false;
  createEffect(() => {
    if (setupNudged || !cfg()?.needsSetup) return;
    setupNudged = true;
    requestAnimationFrame(() => {
      loadCfg();
      setShowCfg(true);
    });
  });
  // probed when the settings panel first opens, not at boot: it runs binaries server-side
  createEffect(() => {
    if (!showCfg() || features()) return;
    api("/api/features")
      .then((f) => setFeatures(f as never))
      .catch(() => setFeatures(null));
  });
  /**
   * MCP servers whose missing grant has already pulled the operator to that section.
   *
   * Deliberately module/mount-lifetime, NOT per-dialog: "this server needs authorization" is a
   * property of the server, so re-opening settings must not re-announce it and make every save
   * jump to MCP again.
   */
  const announcedOAuth = new Set<string>();
  /* Below NARROW_PX the right bar stops being a grid column and becomes a
   * fixed drawer over the content — which hides the ▤ toggle that opens it.
   * That is why the drawer needs its own close button, and why the breakpoint
   * lives in ONE place shared with the CSS media query. */
  const isNarrow = () => window.innerWidth <= NARROW_PX;
  /* ...but the JSX needs the REACTIVE form. A plain function reads fine inside
   * a keydown handler and is evaluated on every Escape, yet `<Show
   * when={isNarrow() && …}>` evaluates it ONCE at render and never again:
   * window.innerWidth is not a signal, so nothing re-ran the branch. The
   * reported flow is narrowing an already-loaded window, which is exactly when
   * that bites — the backdrop never appeared, and the drawer had no
   * click-outside at all. A signal updated on resize makes it track the same
   * breakpoint the CSS media query does. */
  const [narrow, setNarrow] = createSignal(isNarrow());
  onMount(() => {
    const onResize = () => setNarrow(isNarrow());
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
    onResize(); // a late load can land on the other side of the breakpoint
  });

  /* a resize must not move the operator's place in the timeline.
   *
   * `scrollTop` is a PIXEL offset into content whose height just changed. Narrow
   * -> wide re-wraps every line, so the same text needs fewer rows and
   * `scrollHeight` SHRINKS; the browser then clamps `scrollTop` to the new
   * maximum. Nothing was added or removed, yet the view lands somewhere else:
   *
   *     before: content 2000, scrollTop 1500, at the bottom
   *     after : content 1200, max scrollTop 700 -> clamped from 1500 to 700
   *             => 800px further from the bottom than before
   *
   * Two guarantees, in order of what the operator asked for:
   *
   *   1. if they were FOLLOWING (at the bottom), keep following. Widening the
   *      window while reading new output must not unpin it.
   *   2. otherwise keep the topmost VISIBLE row in place. That is the only
   *      stable thing across a re-wrap — a pixel offset is not, since the rows
   *      above it changed height.
   */
  /**
   * #103 / #scroll: when the feed's own BOX changes, keep the operator's place.
   *
   * This used to listen to `window.resize` only, which misses every change that matters:
   * the composer growing a line, the terminal drawer opening, the right panel toggling —
   * each resizes `.feed` WITHOUT touching the window. That omission is why "typing into a
   * 2-line composer nudges the feed" kept surviving: the viewport shrank, nothing
   * re-anchored, and the `scrollTop` the browser had clamped to the OLD maximum was left
   * pointing at a position that was now one line short of the tail.
   *
   * A ResizeObserver on the feed sees all of them, because they are all one event as far as
   * the scroll container is concerned: its box changed.
   *
   * Two cases, decided from the FOLLOW STATE rather than from geometry sampled here:
   *   1. following → re-pin. The tail is where the reader was and where they should be.
   *   2. not following → keep the topmost VISIBLE row where it is. A pixel offset is not
   *      stable across a re-wrap (the rows above it changed height), but the row is.
   */
  let lastContentHeight = 0;
  /**
   * The topmost visible row, kept current by the SCROLL path (throttled to 100ms).
   *
   * `restoreAfterBoxChange` needs it, and it must be a value captured while the reader was looking
   * at the content — measuring at the moment the box changes compares a row against itself
   * (`firstVisibleRow` returns the row AND its `top` in one frame, so the delta is always 0). That
   * is why narrowing the window kept `scrollTop` at 2701 while `scrollHeight` shrank 6753 → 5941 and
   * the reader's place moved two rows (message 15 → 18).
   *
   * Declared here, not beside `resyncAfterUnskip`, so the ResizeObserver path is outside its
   * temporal dead zone.
   */
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
    /**
     * Re-pin on EVERY box change while following — including the composer's own measuring.
     *
     * Three previous fixes all circled this one line, so the reasoning is worth keeping:
     *
     *   v0.34.7  `if (contentHeight <= offsetHeight) height = "auto"` — MEASURED always true, so
     *            the collapse stayed unconditional.
     *   v0.34.8  compared against a remembered content height read from a box that was still
     *            tall, so the guard never fired and deleting never shrank the box.
     *   v0.34.9  skipped this observer entirely while measuring. That removed the damage from
     *            the collapsed layout AND removed the only pin — when the composer grows,
     *            `scrollTop` does not change (only the floor moves down), so NO scroll event
     *            fires and this observer is the sole thing that restores the tail.
     *
     * The measurement round-trip is unavoidable: a textarea with an explicit height reports
     * `max(height, content)`, so the content height is unrecoverable while it is tall.
     *
     * But `pinToTail()` is `scrollTop = scrollHeight`, which the browser clamps to whatever the
     * floor is AT THAT MOMENT. Pinning during the collapsed layout lands on the collapsed floor
     * and is corrected by the next box change; pinning twice is idempotent, skipping it is not.
     * So there is nothing to suppress — the flag is gone.
     */

    /**
     * Record the geometry on EVERY box change, not only on scroll deliveries.
     *
     * `classifyScroll()` decides "layout vs reader" by comparing the delivered viewport height
     * against the previous sample. Those samples used to advance only inside the scroll handler
     * — so when the composer resized and the browser delivered a scroll event in the SAME frame,
     * the handler compared against the PRE-resize height, saw no change, and attributed the
     * movement to the reader. Follow was dropped.
     *
     * That ordering is browser-dependent, which is why this reproduced in Firefox only: Chrome
     * delivered the scroll after the resize had been observed, Firefox before. Taking the
     * sample here removes the dependency on which fires first.
     */
    lastSampleHeight = f.scrollHeight;
    lastSampleViewport = f.clientHeight;
    if (atBottom()) {
      // following: re-pin to the NEW maximum. Assigning scrollHeight lets the browser clamp,
      // so this is correct without knowing the new viewport height.
      pinToTail();
      return;
    }
    /**
     * Use the anchor the SCROLL path maintains (`unskipAnchor`), not one measured here.
     *
     * Measuring here compared a row's position against itself: `firstVisibleRow(f)` returns the row
     * AND its `top` in the same frame, so `delta` was always 0 and this branch did nothing. That is
     * why narrowing the window kept `scrollTop` at 2701 while `scrollHeight` shrank 6753 → 5941 and
     * the reader's place moved two rows (message 15 → 18).
     */
    const anchorRow = unskipAnchor;
    if (!anchorRow) return;
    const el = f.querySelector<HTMLElement>(anchorRow.sel);
    if (!el) return;
    const delta = el.getBoundingClientRect().top - anchorRow.top;
    if (delta) {
      f.scrollTop += delta;
      // this write is ours: record it so the scroll event it produces cannot be read as the
      // reader having moved (see `classifyScroll`)
      ledger = { top: f.scrollTop, height: f.scrollHeight };
    }
    // the box changed, so the gap did too — keep the pill honest
    publishGap(tailSample());
  };

  /**
   * Put the reader back where they were after a `content-visibility` unskip.
   *
   * Gecko lays a row out for real the moment it approaches the viewport, replacing its
   * `contain-intrinsic-size` placeholder. When that row is ABOVE the reader, everything below it
   * moves — and unlike Chromium, Gecko does not keep the scroll position stable across the
   * unskip (Bugzilla 1940025 and 1908582 are both still open; WPT
   * `content-visibility-anchor-positioning-00{2,3}.html` fails). MEASURED in this app: scrolling
   * up through a loaded session creeps a few pixels per unskipped row.
   *
   * The unskip does NOT fire a ResizeObserver — the feed's own box is unchanged — so it needs
   * its own trigger. It DOES change `scrollHeight`, which is exactly the signature the scroll
   * handler already sees as `layout`; this runs on that path and re-applies the row anchor.
   *
   * Bounded deliberately: at most a few corrections per animation frame, and never while
   * following (there the tail is the only position that matters and `pinToTail` already handles
   * it).
   */
  function resyncAfterUnskip(f: HTMLElement, anchor: { sel: string; top: number } | null): void {
    if (!anchor) return;
    const el = f.querySelector<HTMLElement>(anchor.sel);
    if (!el) return;
    const delta = el.getBoundingClientRect().top - anchor.top;
    // a sub-pixel diff is rounding, not an unskip: correcting it would ADD jitter
    if (Math.abs(delta) < 1) return;
    /**
     * A LARGE delta is not an unskip — it is a stale anchor, and correcting it is the jump.
     *
     * The anchor is refreshed on scroll deliveries, throttled to 100ms, so during a burst of
     * appends (a streaming reply, or a page of history arriving) it can name a row whose position
     * has since been invalidated. One unskip moves a row by a few pixels — its intrinsic-size guess
     * against its real height — so a delta in the HUNDREDS of pixels cannot be that: it means the
     * anchor no longer describes the content, and scrolling by it would move the reader to an
     * unrelated place. Reported as "原因不明でスクロール追従が外れて500pxくらい戻る".
     *
     * Dropping the anchor is the honest response: the next reader gesture records a fresh one, and
     * a stale correction is strictly worse than none.
     */
    if (Math.abs(delta) > RESYNC_MAX_DELTA_PX) return;
    f.scrollTop += delta;
    ledger = { top: f.scrollTop, height: f.scrollHeight };
  }
  const scheduleRestore = () => {
    if (feedRoRaf) return;
    feedRoRaf = requestAnimationFrame(restoreAfterBoxChange);
  };
  /**
   * Attach the box observer to the feed element that is ACTUALLY in the DOM.
   *
   * This is a function rather than a one-shot `onMount` because the timeline is rendered
   * inside `<Show when={sel()?.id} keyed>` — switching session REBUILDS `.channel` and with
   * it `.feed`. A ResizeObserver attached once at mount then keeps watching a DETACHED
   * node and reports nothing, which is why an `onMount` version of this fix looked correct
   * and did nothing in the real app (the smoke harness renders once, so it could not catch
   * that). The `ref` on the feed calls this on every rebuild.
   */
  const attachFeedObserver = (f: HTMLElement | null) => {
    if (!f) return;
    if (f === feedRoEl) return; // same element, already observed
    feedRo ??= new ResizeObserver((entries) => {
      // coalesce: a drag-resize fires continuously, and each measurement forces layout
      const box = entries[0]?.contentRect;
      const key = box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "";
      if (key === feedRoLastBox) return; // sub-pixel churn
      feedRoLastBox = key;
      scheduleRestore();
    });
    if (feedRoEl) feedRo.unobserve(feedRoEl);
    feedRoEl = f;
    feedRoLastBox = "";
    feedRo.observe(f);
  };
  onMount(() => {
    // a window resize changes the feed's box, so the observer covers it; it is listed too
    // because a resize that leaves the feed's box identical (an outer padding change) still
    // re-wraps the text inside it
    window.addEventListener("resize", scheduleRestore);
    onCleanup(() => {
      window.removeEventListener("resize", scheduleRestore);
      feedRo?.disconnect();
      feedRo = undefined;
      feedRoEl = undefined;
      if (feedRoRaf) cancelAnimationFrame(feedRoRaf);
    });
  });

  /** A selector that identifies the topmost visible timeline row, plus its
   *  viewport-relative top. Used as the anchor a resize must preserve. */
  function firstVisibleRow(
    f: HTMLElement,
  ): { sel: string; top: number } | null {
    // rows already carry `data-eid` (their log event id), which is stable across
    // a re-wrap — unlike a pixel offset or a row INDEX
    const rows = f.querySelectorAll<HTMLElement>("[data-eid]");
    if (!rows.length) return null;
    const feedTop = f.getBoundingClientRect().top;
    const at = (i: number) => rows[i]!.getBoundingClientRect();
    /**
     * BINARY SEARCH, not a linear scan.
     *
     * visible — and with `content-visibility: auto` on `.feed > .msg`, reading a row's box
     * FORCES IT TO BE LAID OUT. So the scan did not merely read ~1,100 boxes, it laid out
     * every skipped row it passed, which is the "`content-visibility` との相性" the operator
     * suspected. It runs on every window resize and every content change.
     *
     * Rows are in DOCUMENT ORDER, so "is this row above the viewport" is monotone: a binary
     * search finds the first visible row in ~10 probes instead of ~1,100, and only the rows
     * on that path are ever unskipped.
     */
    let lo = 0;
    let hi = rows.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (at(mid).bottom > feedTop) {
        found = mid;
        hi = mid - 1; // a visible row — look for an EARLIER one
      } else {
        lo = mid + 1; // entirely above the viewport
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
    // Escape and the drawer's ✕ must not persist "panel open" — a drawer
    // remembered as open slides back over the content on the next load, which
    // is exactly the state we are trying to make escapable.
    if (showRight()) setRight(false);
  };
  /**
   * The LEFT panel is a drawer on a phone, and only there.
   *
   * Asked for as "スマホで見たときに左パネルも邪魔になるので、これはいい感じにしたい / 右パネルと
   * 同じく閉じるだけでいいのか、モバイル版DiscordみたいなUXにするのかはお任せ".
   *
   * Same shape as the right panel, deliberately: a slide-over with a backdrop and a ✕, opened
   * from a hamburger in the header. On desktop nothing changes — the drawer is off, the sidebar is
   * a grid column, and the hamburger is not rendered. Regression safety on PC is the constraint the
   * operator named, so the narrow-only behaviour lives behind `isNarrow()` and the base grid is
   * untouched.
   *
   * NOT persisted, unlike the right panel: a phone that remembered "sidebar open" would greet the
   * operator with a drawer over the conversation every launch.
   */
  const [showLeft, setShowLeft] = createSignal(false);
  const closeLeft = () => setShowLeft(false);

  /* ---------- theme picker (per-browser, localStorage-backed) ---------- */
  // fixed theme…
  const [fixedTheme, setFixedTheme] = createSignal(localStorage.getItem("teapot.theme") ?? "dark");
  // …or follow the OS, with an explicit choice per system appearance
  const [themeAuto, setThemeAuto] = createSignal(localStorage.getItem("teapot.theme.auto") === "1");
  const [sysLightTheme, setSysLightTheme] = createSignal(
    localStorage.getItem("teapot.theme.light") ?? "light",
  );
  /**
   * A theme id to PAINT regardless of which slot the OS selects — the settings PREVIEW.
   *
   * Following the system, `want` comes from the slot matching the OS appearance, so clicking a
   * LIGHT card while the OS is dark could not show anything: the painter asked for the dark slot.
   * Reported as "最後に押したテーマがプレビューされるべきなのに変わってない".
   *
   * `null` means "no preview": the normal slot resolution applies, which is the state the app
   * returns to when the dialog closes.
   */
  const [previewTheme, setPreviewTheme] = createSignal<string | null>(null);
  /**
   * Operator-authored themes, persisted separately from the preset choice.
   *
   * A preset is a `[data-theme]` block in app.css; a custom theme cannot be one (nothing in the
   * browser can write a stylesheet), so it is applied as INLINE custom properties on `<html>`.
   * That is why the two are separate signals: `fixedTheme` names a preset OR a custom id, and
   * `customThemes` is the palette behind that id.
   */
  const [customThemes, setCustomThemes] = createSignal<CustomTheme[]>(loadCustomThemes());
  /**
   * UNION the server's themes with this browser's — never replace one set with the other.
   *
   * The first paint uses `loadCustomThemes()` (localStorage) so the palette is right before any
   * network call, then this reconciles once the app is up.
   *
   * It used to be "a server with themes wins" and that is wrong in the direction that loses data:
   * a server holding ONE unrelated theme silently deleted every theme this browser had. MEASURED
   * in a sandbox whose config carried a single stale light theme — the seven local themes became
   * one, and the reported symptom was "follow the system がオフなのにライトテーマ(システムのテーマ)の
   * 選択肢しかでない", because the survivor happened to be light.
   *
   * Neither side is authoritative: a theme can be made on a phone and not yet synced, and the file
   * can hold themes from before this browser existed. So the resolved list is the union by id —
   * the server's copy wins for an id both know (it is the durable one), local-only themes are
   * kept, and the union is pushed back so both sides converge.
   *
   * `remote === null` means unreachable: keep what this browser has and push nothing, so a dead
   * server cannot wipe the local list either.
   */
  onMount(() => {
    void loadCustomThemesFromServer().then((remote) => {
      if (remote === null) return;
      const merged = mergeThemes(customThemes(), remote);
      setCustomThemes(merged);
      /**
       * Push the union up unconditionally: it converges both sides for every case at once —
       * first run against an empty server, a theme that exists only locally, and a theme that
       * exists only on the server (already in `merged`, so re-sending it is a no-op).
       */
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
  // single writer: resolves the active theme and slaps it on <html>
  createEffect(() => {
    /**
     * A preview WINS over slot resolution.
     *
     * Following the system, `want` comes from the slot matching the OS appearance, so clicking a
     * LIGHT card while the OS is dark asked the painter for the dark slot and nothing changed.
     * "最後に押したテーマがプレビューされるべき" is what this override is for.
     */
    const previewId = previewTheme();
    const want = previewId ?? (themeAuto()
      ? sysPrefersLight()
        ? sysLightTheme()
        : sysDarkTheme()
      : fixedTheme());
    /**
     * A stored id can name a theme that no longer exists: deleted in another tab, dropped by
     * `saveCustomThemes` when storage was full, or written by an older build. The attribute was
     * set to that dead id, and since it matches neither `:root` nor a `[data-theme]` block the
     * page then had NO palette at all — every surface transparent, unreadable, with no obvious
     * way back except editing localStorage.
     *
     * Falling back to the dark preset keeps the app usable, and the write-back means the next
     * reload agrees with what is on screen instead of retrying the dead id forever.
     */
    const resolved = resolveActiveTheme({
      want,
      customIds: customThemes().map((t) => t.id),
      presetIds: THEMES.map((t) => t.key),
      fallback: "dark",
    });
    const active = resolved.active;
    const custom = customThemes().find((t) => t.id === active) ?? null;
    if (resolved.repaired) {
      // rewrite the STORED value, not just the attribute: otherwise every effect run re-reads
      // the dead id and the fallback is permanent rather than a one-time repair
      if (themeAuto()) localStorage.setItem(sysPrefersLight() ? "teapot.theme.light" : "teapot.theme.dark", active);
      else localStorage.setItem("teapot.theme", active);
    }
    document.documentElement.dataset.theme = active;
    // A CUSTOM theme is applied as inline custom properties, which outrank the stylesheet's
    // `:root`/`[data-theme]` values. `null` clears them, so switching back to a preset cannot
    // leave half a palette behind (a leftover `--bg-dark` would keep overriding the preset).
    applyCustomTheme(document.documentElement, custom);
    // light/dark appearance for components that ship their own palettes
    // (e.g. shiki dual-theme code blocks)
    document.documentElement.dataset.appearance =
      custom?.mode ?? THEMES.find((t) => t.key === active)?.mode ?? "dark";
  });
  /**
   * #143 REVERSED: no `content-visibility` on timeline rows.
   *
   * The containment that used to be toggled here is gone. It bought less memory than expected
   * ("思ったより軽量化効果が少なかった") and it CAUSED the scroll drift: a skipped row is replaced by
   * a `contain-intrinsic-size` guess, and laying it out for real moves everything below it.
   *
   * Removed rather than tuned, because the drift cannot be corrected from script — a correction
   * runs after paint, so it is itself a visible jump. See the note in app.css.
   */
  // NOTE: there used to be a second effect here that walked every row and wrote an
  // inline `contain-intrinsic-size` from a measured box, with an IntersectionObserver and a
  // ResizeObserver per row, to stop a `content-visibility` unskip from shifting the scroll.
  //
  // It is GONE. MEASURED by the operator: with `teapot.feedCv=0` the UI is light, with it
  // on the tab is unusable — so the cost was the reservation machinery itself, not the
  // containment. An inline style on ~1,100 rows plus 2 observers each meant every scroll
  // and every append invalidated style and layout for the whole feed.
  //
  // The mechanism is also self-defeating: writing `<w>px <h>px` REPLACES the stylesheet's
  // `auto` keyword, so the browser can no longer remember a row's real size itself — which
  // is exactly what `auto` is for. `contain-intrinsic-size: auto 140px` in app.css does
  // this job natively, in the engine, with no script.
  //
  // happy-dom does no layout, so none of this could ever reproduce in the test harness —
  // which is why the previous tests were green while the browser burned a core.
  // model switcher state
  const [modelProvider, setModelProvider] = createSignal("");
  const [modelDraft, setModelDraft] = createSignal("");
  // reasoning effort draft ("" = provider default). Seeded from the
  // agent snapshot and re-seeded whenever the selected agent changes, mirroring
  // modelDraft's pattern.
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
  /** "ctx 1m · $3/M in · $15/M out" for the draft (or current) model */
  /** 📄🖼️→📄 style badge for a model's input/output modalities */
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
    if (badge && badge !== "📄 → 📄") parts.push(badge); // text-only is the default — no noise
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
  // Keep the switcher aligned with the selected session. Keyed on STRINGS,
  // not on sel() identity: this used to re-run (and re-fetch /api/models!)
  // on every poll in which the agent's snapshot object changed — visibly
  // rebuilding the whole 🧦 model section = the "right panel flashes" bug.
  // FIX: the draft/provider signals are NOT dependencies — reading them
  // reactively cleared the draft on every keystroke and reverted the
  // provider dropdown on manual change (the "right panel model switching
  // doesn't work" bug). Clear draft / sync provider only when the selected
  // agent actually changes.
  let _prevModelAgent: string | null = null;
  // set when the operator works the provider dropdown themselves. The
  // re-sync in the branch below exists for an EXTERNAL change (another tab, a
  // restart) and must not undo a deliberate pick: choosing a provider that has
  // no configured default model leaves the draft empty, and without this the
  // next poll reads "empty draft" as "not mid-edit" and pulls the dropdown back
  // before `apply` can be pressed.
  let providerTouched = false;
  createEffect(() => {
    const id = selected();
    if (!id) return;
    const a = agents().find((x) => x.id === id);
    const prov = a?.provider || cfg().defaultProvider || providerList()[0] || "";
    if (!a) return;
    if (id !== _prevModelAgent) {
      _prevModelAgent = id;
      providerTouched = false; // a new session's own provider is the right default
      // sync provider to the newly selected agent's provider
      if (untrack(() => modelProvider()) !== prov) {
        setModelProvider(prov);
        loadModels(prov);
      }
      // clear stale draft only on session switch, not on every poll
      if (untrack(() => modelDraft())) setModelDraft("");
    } else {
      // same agent — keep user's draft/provider edits intact; only
      // re-sync if the server's provider changed externally and the user
      // isn't actively editing (draft empty means not mid-type) or has not
      // touched the dropdown
      const curProv = untrack(() => modelProvider());
      const curDraft = untrack(() => modelDraft());
      if (!curDraft && curProv !== prov && mayResyncProvider(providerTouched)) {
        setModelProvider(prov);
        loadModels(prov);
      }
    }
  });
  // autoscroll: follow the tail only while the reader is already at the bottom
  const MAX_COMPOSER_H = 360; // ~15 lines expanded (was ~8 lines / 160px)
  const [composerMaximized, setComposerMaximized] = createSignal(false);
  const [atBottom, setAtBottom] = createSignal(true);
  const [missed, setMissed] = createSignal(0);
  /**
   * The last measured gap to the tail, as a SIGNAL.
   *
   * The jump pill's visibility must not be recomputed by reading the DOM inside a `<Show>`
   * condition — that runs on every render of the composer and forces layout each time, on
   * the very feed the #179 fixes went into. The scroll handler and the resize observer
   * already have the numbers, so they publish the gap and the pill reads a plain signal.
   *
   * `-1` means "not measured yet", which shows no pill.
   */
  const [gapToTailPx, setGapToTailPx] = createSignal(-1);
  /** publish the gap from any place that already measured it */
  const publishGap = (s: TailSample | null) => setGapToTailPx(s ? gapToTail(s) : -1);
  // live compaction progress for the selected session ("summarizing 2138…")
  const [compacting, setCompacting] = createSignal<{ phase: string; summarized?: number } | null>(null);
  // the live bubble is carrying a compaction summarizer stream (prefixed by
  // the harness) rather than a normal assistant reply — render it differently
  const liveIsCompact = () => liveText().startsWith("[compact] ");
  /**
   * The summarizer's stream is shown as a PREVIEW, not as a growing document.
   *
   * It is a full compaction summary being written — many hundreds of lines — and rendering all of
   * it in a live bubble made the timeline jump to a wall of text at the exact moment the log was
   * also gaining the `🗜 context compacted` row. The operator described it as "compact完了直後に
   * 一瞬タイムラインにcompact結果が展開された状態で出る" and "compact直後のタイムラインの挙動が
   * ちょっと変".
   *
   * The tail is what shows progress (the head is the part already written); the finished summary is
   * one click away in the compaction card, which is where reading it belongs.
   */
  const liveBody = () => {
    const body = liveIsCompact() ? liveText().slice("[compact] ".length) : liveText();
    const CAP = 1200;
    return body.length > CAP ? "…" + body.slice(-CAP) : body;
  };
  // a summarizer's streamed output is shown in the live bubble; clear it when
  // the pass ends so a stale "[compact] …" bubble can't outlive it
  createEffect(() => {
    if (!compacting()) setLive((l) => (l?.text.startsWith("[compact] ") ? null : l));
  });
  /**
   * Re-pin after ANY in-feed content change while the reader is following.
   *
   * The feed is `flex: 1` inside a fixed-height column, so its BOX does not change when content
   * grows — the `ResizeObserver` above only sees viewport and composer changes. Everything that
   * appears inside the feed therefore had to re-pin itself, and only two things did: a `<details>`
   * opened by the operator, and the compaction banner. Reported as "goal関連のカードがタイムラインに
   * 流れたときにスクロール追従が動かない" — a goal card renders inside the feed and nothing re-pinned.
   *
   * Keying on the event list plus `scrollHeight` covers every such case without each row having to
   * know about scrolling. Pinning is idempotent, so a spurious firing costs one assignment.
   */
  createEffect(() => {
    void events().length;
    void eventsTotal();
    void compacting();
    /**
     * `chatEvents().length`, not just `events().length`.
     *
     * The feed renders `chatEvents()`, which is `events()` PLUS the pending echoes and minus the
     * rows the pipeline hides. Keying the re-pin on the raw log length therefore missed every change
     * that is not a new LOG row: a message the operator just sent gets an ECHO at the bottom, a
     * delivered prompt loses its echo, and neither touches `events().length`. The row appears (or
     * disappears) under a reader who is following and nothing pins.
     */
    void chatEvents().length;
    /**
     * …and the two rows that live OUTSIDE `<For>`.
     *
     * Every child of the feed that can appear on its own has to be named here, because this effect
     * is the only thing that re-pins for content INSIDE the feed (its box does not change — `flex: 1`
     * in a fixed-height column). Two were missing: the "beginning of log" divider and the tail
     * loading row. Auditing the JSX against this list is the check; a new feed child needs a line
     * here or a reader who is following will not be carried to it.
     */
    void olderDone();
    void loadingFeed();
    // a PREPEND is handled by the scroll anchor, but this row is centred content that appears on its
    // own — and when the log is shorter than one page it never prepends at all
    void loadingOlder();
    const f = feedEl();
    if (!f) return;
    const height = f.scrollHeight;
    // a reader who scrolled up is not followed at all — `scrollBottom` re-checks this
    if (height === lastContentHeight) return;
    lastContentHeight = height;
    // two frames: one for the new row to enter the flow, one to paint
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (atBottom()) pinToTail();
      }),
    );
  });
  // ONE live buffer PER AGENT. The old single slot was clobbered by every
  // session switch (setLive(null) on select) and by the feed refresh's
  // stillStreaming heuristic — a streaming reply visibly blinked out and
  // came back, or vanished entirely after visiting another session.
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
  /**
   * Apply the shared reconcile rule to the CURRENT buffer, keeping whichever halves survive.
   *
   * ONE place calls this, and it is the same rule the feed refresh uses — a second copy of "which
   * halves are settled" is how the two paths drifted before.
   */
  const settleLiveBuffer = () => {
    const buf = live();
    if (!buf) return;
    const next = reconcileLiveBuffer(buf, events(), sel()?.status);
    if (!next) setLive(null);
    else if (next.text !== buf.text || next.reasoning !== buf.reasoning) setLive(next);
  };
  // markdown-rendered live body, throttled so per-chunk deltas don't re-parse
  // the whole (growing) text on every single WS message
  const [liveText, setLiveText] = createSignal("");
  // when the CURRENT thinking stretch started (reasoning arriving while text
  // is still empty) — powers the 💭 thinking elapsed-time readout
  const [thinkStartedAt, setThinkStartedAt] = createSignal(0);
  const liveStartedAt = () => thinkStartedAt();
  // reasoning renders from the SAME throttle tick — binding it raw re-painted
  // the (often huge) thinking block on every single chunk
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
    if (liveRenderTimer) return; // a render is already scheduled
    liveRenderTimer = setTimeout(() => {
      liveRenderTimer = undefined;
      setLiveText(live()?.text ?? "");
      setLiveReasoning(live()?.reasoning ?? "");
      // adaptive throttle: the WHOLE text re-parses each tick, so stretch the
      // interval as it grows — long streams were re-rendering every 60ms and
      // bogging Firefox down
    }, (live()?.text.length ?? 0) > 20_000 ? 250 : (live()?.text.length ?? 0) > 6_000 ? 120 : 60);
  });
  onCleanup(() => clearTimeout(liveRenderTimer));

  // A finish() turn often streams REASONING-ONLY (empty text) — the live
  // buffer then shows a 💭 thinking bubble that outlives the run: nothing
  // else arrives to overwrite it, and the refresh-path cleanup only runs on
  // unrelated events. The agent's status is the ground truth: the moment it
  // leaves running/waiting, any leftover live buffer is dead and must go.
  // (Reload "fixes" it today only because the buffer is memory-only.)
  createEffect(() => {
    // sweep EVERY agent's buffer against its OWN status, not the selected
    // one — nothing replays missed events on reconnect, so a background agent's
    // buffer could depend on a turn-boundary event that never arrived and leave
    // stale text under a writing cursor until a reload.
    //
    // `agents()` must be read HERE, outside the updater. Read inside it, the
    // effect subscribed to no signal at all: `liveByAgent` is an empty Map on the
    // first run, so `pruneDeadLiveBuffers` looped over nothing and never called
    // `statusOf`. That is how this sweep shipped as dead code — measured as
    // "effect runs: 1, statusOf calls: 0" — with the (correct, fully unit-tested)
    // helper underneath it.
    const list = agents();
    setLiveByAgent((prev) =>
      pruneDeadLiveBuffers(prev, (id) => list.find((x) => x.id === id)?.status),
    );
    // #131 (again): do NOT zero the clock here. This effect runs on EVERY `agents()`
    // change — a status snapshot arrives constantly — and a status transition is
    // exactly what happens when thinking ENDS. Zeroing here set `startedAt = 0` while
    // the 💭 block was still on screen, and `now() - 0` is elapsed-since-the-EPOCH:
    //
    //     reported: "thinking 497531h 23m", appearing the moment reasoning finished
    //
    // The clock belongs to the reasoning stream: the delta handler below arms it and
    // clears it when real text arrives. Resetting it from a status sweep makes an
    // unrelated snapshot reach into stream bookkeeping — the same mixing of concerns
    // that produced the original #131.
    setThinkStartedAt((cur) => clearThinkClockIfDone(cur, list, selected(), live()));
  });

  // AUTO-SCROLL while live output streams, decided by the POLICY rather than the sticky
  // flag.
  //
  // The old version used `atBottom()` twice (once to gate, once inside the rAF). That flag
  // is only updated by `onscroll`, and streaming grows the bubble with NO scroll event, so
  // between the two reads it was stale — which is the shape of every report about follow
  // mode stopping by itself. Sampling the geometry at BOTH ends and comparing them is what
  // distinguishes "content grew" (follow) from "the reader moved up" (stop).
  createEffect(() => {
    // reasoning-only streams (💭 thinking, no text yet) must follow too —
    // keying the effect on liveText() alone left the feed parked while the
    // reasoning details block kept growing
    const txt = liveText();
    const rsn = live()?.reasoning ?? "";
    if (!txt && !rsn) return;
    // wait for the DOM to paint the new text, then pin — no comparison needed. Whether this
    // tick GREW the content is not a question the follow state cares about: if the reader is
    // following, the tail is where they should be, and if they are not, `atBottom()` keeps
    // us out of their way.
    requestAnimationFrame(() => {
      if (atBottom()) pinToTail();
    });
  });
  // Browsers pause requestAnimationFrame while a tab is hidden, so scroll
  // follow-ups for updates arriving in a background tab are silently dropped
  // — coming back showed a stale bottom line even though "follow" mode was
  // on. Re-sync once on return: jump to the tail iff the reader was still
  // following when they left. Re-armed on every session switch.

  // Pending echoes must clear at EXACTLY the moment the ⏳ queue badge clears:
  // both mean "the model has consumed the message". The badge counts
  // snapshot().pendingPrompts, which drops the instant drainPendingPrompts()
  // moves the queue into this.messages — so reconcile against that count
  // instead of waiting for every prompt-delivered note to arrive over WS (the
  // badge and the echo visibly disagreed during that gap).
  //
  // Reconcile by IDENTITY, not by count. This used to be slice(0, queued)
  // — "the newest entries were consumed" — which only holds when the model
  // drains the queue front-to-back. Cancelling a message in the MIDDLE also
  // lowers the count, and that heuristic then dropped a still-queued echo
  // while keeping the withdrawn one: with [A, B] queued, cancelling A leaves
  // the badge at 1 and slice(0,1) keeps A, discards B. Match on promptId and
  // keep the echoes the live queue can still account for.
  createEffect(() => {
    const queued = sel()?.pendingPrompts ?? 0;
    const liveIds = sel()?.pendingPromptIds;
    const key = pendingKey();
    // Reconcile THIS SESSION's echoes, read from the map rather than the signal.
    // Reading the signal here was wrong once the list became per-session: the
    // effect also re-runs on a session switch, and at that moment the signal
    // still holds the OUTGOING session's echoes while `key` is already the
    // incoming one — so it reconciled the old list against the new queue and
    // wrote the result under the new key, dropping the echo. The smoke
    // test caught it: "undelivered log row leaked through as settled".
    const mine = pendingFor(key);
    const next = reconcilePending(mine, queued, liveIds);
    if (next !== mine) writePending(key, next);
  });

  /**
   * Rebuild echoes the UI does not have for a queue it does.
   *
   * Echo rows are memory-only, so after a reload — or opening a session in a
   * new tab — the server still has a queued prompt while the UI has nothing to
   * render for it. `reconcilePending` cannot help: ids identify a prompt, they do
   * not carry its text, so there is no echo to reconcile and the queued message
   * shows up as its log row alone, i.e. already sent.
   *
   * So the queue now arrives with its text and any prompt we do not already have
   * an echo for is materialised here. Ids the UI already holds are SKIPPED, so
   * this never rewrites a live echo's text, images or position.
   */
  createEffect(() => {
    const queue = sel()?.pendingPromptQueue;
    if (!queue?.length) return;
    /**
     * Filed under the SELECTED AGENT's session, not the one on screen.
     *
     * `sel()` is an AGENT and `pendingKey()` is a TIMELINE — an agent's session and the session
     * being viewed are the same handle for a live agent and different for an older one, which is
     * exactly when this ran wrong: viewing session A while agent B had a queued prompt materialised
     * B's message into A's feed and raised A's ⏳ badge for a queue A did not have. Filing by the
     * queue's owner keeps the two views independent.
     */
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
        // the snapshot already carries `source`; dropping it made every
        // harness prompt render as a user one
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
          // returning to the tab and finding the tail is the same act of
          // reading as scrolling to it — it must settle the badge too
          markReadIfFollowing();
        }
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisible));
  });
  const sel = createMemo(() => agents().find((a) => a.id === selected()));
  /**
   * How many of the operator's messages are waiting to be consumed, for the feed being SHOWN.
   *
   * Counted from the LOG, through the same rule that decides whether a queued ROW is drawn
   * (`pendingEchoCount` → `remainingEchoes`). It used to count `pendingMsgs()` — client memory —
   * so the badge could outlive the row it was counting: the feed showed nothing queued and the
   * badge still said "⏳ 1 message queued", until a session switch rebuilt the list from the log.
   * Two implementations of "still pending" is exactly how those two drift apart.
   *
   * The server count is still needed for the case the client cannot see: a queue entry it has no
   * echo for at all (opened in another tab, or sent before a reload). It describes THIS feed only
   * when the selected agent's session is the one on screen — `sel()` is an agent and
   * `pendingKey()` is a timeline, and those differ for anyone else's session.
   */
  const queuedCount = () => {
    const mine = sel()?.session === pendingKey() || !sel()?.session;
    const fromServer = mine
      ? sel()?.pendingPromptQueue?.length ?? sel()?.pendingPromptIds?.length ?? sel()?.pendingPrompts ?? 0
      : 0;
    return Math.max(fromServer, pendingCount());
  };
  /**
   * Is the selected agent doing work that `stop` would stop?
   *
   * The server is the authority (`Agent.live`), because the client genuinely
   * cannot derive it: a parked tool and queued prompts both leave `status` at
   * "idle" while the loop is alive. Falls back to the status check for an older
   * server, where it is at worst the behaviour we had before.
   */
  const isSelLive = (): boolean => {
    const a = sel();
    if (!a) return false;
    return a.live ?? (a.status === "running" || a.status === "waiting" || a.status === "needs_operator");
  };
  /**
   * Is the TIMELINE BEING DISPLAYED the one that is live?
   *
   * `isSelLive()` answers "is this AGENT working", but the timeline is
   * per SESSION. With the agent working on session S2 while the user reads S1,
   * `isSelLive()` is true, so every S1 tool row that has lost its `tool_result`
   * reads "running…" — because `ToolRow` closes a stranded call via
   * `!agentActive && !res`.
   *
   * So activity must be attributed to the DISPLAYED session. The agent's snapshot
   * carries the session it is currently on; when that equals the timeline we are
   * showing, the agent-wide live flag is the right answer.
   *
   * Falls back to the agent's own live flag when the agent has no recorded
   * session (a brand-new agent), because then there is no second session to
   * confuse it with.
   */
const isTimelineLive = (): boolean => {
    // the FALLBACK view (timelineId === the agent id) is handled by the shared
    // rule — it used to be spelled out here, in the event gate and in the delta
    // gate separately, and the three drifted.
    return timelineIsLive(sel() as { id: string; session?: string } | undefined, timelineId(), isSelLive());
  };
  // prompt being edited → edit-prompt fork dialog. SETTLED user prompts only:
  // a pending (queued, not yet delivered) message offers ✕ cancel instead —
  // editing implies the model may have seen it, which is false while queued.
  const [editing, setEditing] = createSignal<{ eventId: string; text: string } | null>(null);
  // ask_user calls that already have their tool_result in the log — used to
  // disable the option buttons (answering twice sent duplicate prompts)
  const _answeredIds = createMemo(() => {
    const set = new Set<string>();
    for (const e of events()) {
      if (e.type === "tool_result" && e.data?.name === "ask_user") set.add(String(e.data.callId));
    }
    return set;
  });
  // optimistic echoes of prompts we just sent but haven't seen in the log yet
  /**
   * Optimistic echoes, PER SESSION.
   *
   * This was one global list cleared on every switch, while the other per-session
   * stores here (liveByAgent, timelineCache, drafts) all survive one. So leaving
   * a session with a queued message and coming back dropped its echoes: the top
   * bar still counted it (that comes from the server's pendingPromptIds) while
   * the timeline showed the log row as SETTLED — the two disagreed, and the
   * timeline read as "already sent".
   *
   * Keyed by the same handle the timeline uses, so a switch saves and restores
   * rather than discards.
   */
  const pendingBySession = new Map<string, PendingEcho[]>();
  const [pendingMsgs, setPendingMsgs] = createSignal<PendingEcho[]>([]);
  const pendingKey = (): string => timelineId() || selected() || "?";
  const pendingFor = (key: string): PendingEcho[] => pendingBySession.get(key) ?? [];
  const writePending = (key: string, next: PendingEcho[]): void => {
    // at most ONE echo per promptId, enforced at the single point every
    // writer passes through. Two writers race for the same message (the #87
    // rebuild from the server's queue, and the send path when the POST resolves),
    // and `reconcilePending` cannot catch a duplicate because it trims to the
    // server's COUNT — which is 1, so it never inspects two echoes agreeing on one
    // id. Last occurrence wins, so the fresher text survives.
    const seen = new Set<string>();
    const deduped: PendingEcho[] = [];
    for (let i = next.length - 1; i >= 0; i--) {
      const p = next[i]!;
      const id = p.promptId;
      if (!id) {
        deduped.push(p); // no id: cannot be matched, keep it
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

  /* ---------- notification center (in-app only; push later) ---------- */
  type Notif = {
    id: string;
    agentId: string;
    kind: "progress" | "finish" | "question" | "error";
    title: string;
    body: string;
    at: number;
    read: boolean;
    /** source event id — clicking the notification scrolls to this row */
    eventId?: string;
  };
  const [notifs, setNotifs] = createSignal<Notif[]>([]);
  // hide 👻 ghost sessions (workspace directory missing on disk) — a toggle,
  // because they still hold history the operator may need
  const [hideGhosts, setHideGhosts] = createSignal(
    localStorage.getItem("teapot.hideGhosts") === "1",
  );
  const [showNotifs, setShowNotifs] = createSignal(false);
  const unreadCount = () => notifs().filter((n) => !n.read).length;
  /** mark all notifications from ONE session read — fired when the operator
   *  is following the timeline tail (they are, by definition, looking at the
   *  newest content those notifications point to) */
  const markSessionRead = (agentId: string) => {
    setNotifs((list) => {
      let changed = false;
      const next = list.map((n) => {
        if (n.read || n.agentId !== agentId) return n;
        changed = true;
        return { ...n, read: true };
      });
      return changed ? next : list; // avoid identity churn on no-op runs
    });
  };
  /**
   * Mark the DISPLAYED session read when the reader is at its tail.
   *
   * "タイムラインを下までスクロールしても通知が既読にならない" — because the only
   * caller of `markSessionRead` was the feed-refresh path, and that path runs it
   * inside `if (events().at(-1)?.id !== beforeId)`. So a session whose unread
   * notifications were ALREADY in `events()` marked nothing when the operator
   * scrolled to the bottom: no new event arrived, so the branch never ran, and the
   * badge stayed lit until some unrelated event happened to refresh the feed.
   *
   * Reading the tail is the thing that means "seen" — whether the operator got
   * there by scrolling, by pressing the jump pill, or by returning to the tab. So
   * the rule lives in one place and every route to the tail calls it.
   *
   * The guard is not an optimisation detail: the feed's scroll handler fires on
   * every frame of a scroll, and `markSessionRead` allocates a mapped list even to
   * discover nothing changed. Checking for an actually-unread notification first
   * keeps a scroll cheap.
   */
  const markReadIfFollowing = () => {
    const id = selected();
    if (!id) return;
    if (!notifs().some((n) => !n.read && n.agentId === id)) return;
    markSessionRead(id);
  };
  /** unread for one agent INCLUDING its whole sub-tree (subs, sub-subs…) */
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
  /** events worth telling the operator about, even on another session/tab */
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
  /** jump the timeline to a specific event row (used by notification clicks) */
  const jumpToEvent = (eventId: string) => {
    const el = document.querySelector<HTMLElement>(`[data-eid="${eventId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("flash-target");
      setTimeout(() => el.classList.remove("flash-target"), 1600);
    }
  };

  // pair tool_call events with their (possibly still missing) results:
  // consumed results are hidden from the feed, calls render as one merged row
  // that shows "running…" until its result lands
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
          // the call scrolled out of the events window while the command
          // was still running. Without this the result rendered as a bare,
          // anonymous row — and when the window ALSO trimmed the call, the bash
          // row simply vanished, reading as "it never finished". Synthesise the
          // missing call so the tool still shows, WITH its output and timing.
          orphanCalls.set(e.id, e);
        }
      }
    }
    return { resFor, consumed, orphanCalls };
  });  // A question is ANSWERED only when a real operator reply arrived AFTER it —
  // a user prompt logged later than the question event. The tool_result that
  // pairs with the question is written immediately when the question is SHOWN
  // (it parks the loop), so its mere existence never means "answered".
  /**
   * Questions answered in THIS tab whose prompt event has not reached the log
   * yet.
   *
   * The derived set alone is only correct once the reply is LOGGED. Clicking an
   * option POSTs and shows a toast, so between the click and the bus event
   * landing the buttons stayed enabled — and a second click sent a DUPLICATE
   * prompt. Switching sessions and back "fixed" it because that re-read the log.
   *
   * Keyed by callId and looked up per row, so an entry whose question is no
   * longer loaded is inert rather than able to disable an unrelated question.
   * The log stays authoritative: anything answered elsewhere (another tab, a
   * reload, before this session was opened) is derived as before.
   */
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
  /** a session switch must not carry one session's answers into another */
  const clearLocallyAnswered = () => setLocallyAnswered(new Set<string>());
  const answeredQuestionIds = createMemo(() =>
    answeredQuestionIdsOf(events() as unknown as QuestionEvent[], locallyAnswered()),
  );
  /**
   * The pipeline's result: the rows, and how many queued echoes are actually among them.
   *
   * One memo, because the ⏳ badge and the feed must not disagree — see `buildTimelineWithCount`.
   */
  const timeline = createMemo(() =>
    // The pipeline lives in ./timeline so its stages cannot be reordered by accident
    // and so it can be driven with a plain array (#timeline-refactor). It used to be a
    // ~240-line memo that MUTATED its own input rows, so a re-run saw the previous
    // run's writes — the structural reason timeline bugs were intermittent.
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
  /** queued echoes the feed is DRAWING — the log's answer, not client memory's */
  const pendingCount = () => timeline().pendingCount;
  /**
   * Each row paired with its neighbours, REUSING the wrapper objects.
   *
   * ## Why the pair is computed up front
   *
   * Passing `prev={chatEvents()[i() - 1]}` into the template does not work: inside `<For>`, `i` is a
   * SIGNAL (`mapArray` does `indexes[j] = createSignal(i)`), so every rendered row became a
   * SUBSCRIBER of the whole `chatEvents()` memo through that read. Any timeline change then re-ran
   * the lookup in every row, walking the memo's dependency graph — on a large session the UI was
   * unusable on load. Pairing up front is O(n) once per rebuild and gives each row a plain value,
   * so `prev` is a prop comparison rather than a reactive dependency on the entire array.
   *
   * ## Why the wrapper must be reference-stable (#scroll)
   *
   * `<For>` keys on the item's IDENTITY (Solid compares `items[0]`, `items[1]` … against the
   * previous array to decide what to keep). Returning `rows.map(… => ({row, prev, next}))`
   * allocated a FRESH object for every row on every rebuild, so every item looked new and
   * Solid disposed and re-created every row — a full remount of the timeline on each
   * incoming event. That is the reported "新しいメッセージが来るたびにタイムラインがフラッシュ
   * する": not a rendering fault, but the keying contract being violated.
   *
   * The cache below keeps one wrapper per row object for as long as that row object is
   * unchanged, and only replaces a wrapper when its `prev`/`next` actually moved. Rows
   * themselves are already reference-stable (`stabilize()`), so in steady state the array
   * contains the SAME objects and `<For>` patches only what really changed.
   */
  /**
   * The row `delta` positions away from `row`, as an ACCESSOR.
   *
   * Neighbours are needed for grouping (`groupedWith`) and for the spacing classes, but they
   * must not become part of the `<For>` item: keying on a `{row, prev, next}` wrapper meant a
   * row whose neighbour changed was DISPOSED and re-created, dropping its DOM state — an
   * expanded `<details>` slammed shut whenever the next event arrived (measured: 1 of 18 rows
   * per append, and 4 before the pipeline's own identity bugs were fixed).
   *
   * Because `<For>` now iterates `chatEvents()` directly, the item identity is the row, which
   * is reference-stable (`stabilize()`). The neighbour is derived on read, so `grouped` still
   * re-evaluates when it changes, without touching the row's identity.
   */
  // index by ROW IDENTITY once per rebuild (a WeakMap keeps it O(1) per lookup and cannot
  // leak). `chatEvents().indexOf(row)` inside every row would be O(n) per row — which is the
  // #178 quadratic pattern this file already had to remove once.
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
  // Reference-stable echo rows: chatEvents re-runs on EVERY event burst, and
  // rebuilding the echo objects each time handed Solid's <For> a brand-new
  // reference — remounting the pending row (and, with the tail-anchor race,
  // letting it flash to the top of the viewport). Cache by id; only the
  // pending→sent flip builds a new object.
  const echoCache = new Map<string, Ev>();
  function echoEv(p: PendingEcho): Ev {
    const key = `${p.id}:${p.sent ? "s" : "p"}`;
    const hit = echoCache.get(key);
    if (hit) return hit;
    if (echoCache.size > 64) echoCache.clear();
    const ev: Ev = {
      id: p.id,
      // seq is assigned per-render in chatEvents (below every settled row,
      // in send order) — the sentinel here is just a stable placeholder
      seq: Number.MAX_SAFE_INTEGER,
      ts: new Date(p.at).toISOString(),
      session: sel()?.session ?? "",
      branch: sel()?.branch ?? "br0",
      parent: null,
      type: "prompt",
      data: {
        // was hardcoded "user", so a harness prompt looked like an operator
        // one — no queued marker of its own, and a ✕/✎ that cannot work on it
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
  // password auth: any 401 from /api/* flips this on → login overlay
  const [authLocked, setAuthLocked] = createSignal(false);
  onMount(() => {
    const onUnauthorized = () => setAuthLocked(true);
    window.addEventListener("teapot:unauthorized", onUnauthorized);
    onCleanup(() => window.removeEventListener("teapot:unauthorized", onUnauthorized));
  });

  // operator task list draft — seeded per selected agent; while the user
  // hasn't touched it, it follows server updates (the agent edits it too)
  const [todoDraft, setTodoDraft] = createSignal("");
  // false = raw markdown editor, true = rendered checklist (the default).
  // Reading a task list is the common case; the editor is one click away, and
  // a textarea as the landing view made the panel look like a form to fill in.
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
      setTodoDraft(serverTodo); // stay current with agent-side set_todo edits
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
      // saving now shows the RESULT. The button previously left the editor
      // open with no visible confirmation, so "save" looked like it had done
      // nothing — and the obvious next click was to keep typing. Flipping to the
      // rendered checklist shows what was actually stored, which is also the
      // only way to see the agent's formatting of it.
      setTodoViewMode(true);
      flashHint(`tasks saved${notify && todoDraft().trim() ? " & notification queued" : ""}`);
      refreshAgents();
    } catch (ex) {
      flashHint(`save failed: ${(ex as Error).message}`);
    }
  };

  /** count markdown checkboxes ("- [ ]" / "- [x]") in the draft for the progress pill */
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

/**
 * Merge a fresh snapshot list, keeping object identity for unchanged agents.
 *
 * the server re-serialises every agent on every poll and WS frame, and a new
 * object identity re-ran EVERY expression bound to `sel()*.x` — the "right panel
 * flashes" effect. Three call sites needed this and each had its own copy, so the
 * rule lives here once.
 */
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
        // the session index is ONE request for ALL agents — only needed when
        // the agent set actually changes, not on every poll
        if (agentSetChanged) void refreshSessionIndex();
      })
      .catch(() => {});
  const refreshMetrics = () => api("/api/metrics").then(setMetrics).catch(() => {});
  // scheduled (cron) tasks — shown in the right panel so "what runs when" is legible
  const [tasks, setTasks] = createSignal<any[]>([]);
  const loadTasks = () => api("/api/tasks").then((d) => setTasks(d.tasks)).catch(() => {});
  const agentTasks = (id: string | null) => tasks().filter((t) => t.agent === id);

  /**
   * Sidebar: sub-agent groups are CLOSED by default.
   *
   * They used to default to OPEN, so loading the app expanded every sub-agent tree at once —
   * on a session with nested agents that buried the top-level chats the operator actually
   * scans. Collapsed-by-default keeps the sidebar to one row per top-level agent, and a group
   * opens only when asked.
   *
   * The stored set keeps its old meaning (`keys = collapsed ids`) so existing profiles and
   * `treeRowsOf()` are unchanged; `expandedSubs` below is the small override set that records
   * a deliberate expansion.
   */
  const [expandedSubs, setExpandedSubs] = createSignal<Set<string>>((() => {
    try {
      const keys: string[] = JSON.parse(localStorage.getItem("teapot.expandedSubs") ?? "[]");
      return new Set(keys.filter((k) => typeof k === "string"));
    } catch { return new Set(); }
  })());
  const [collapsedSubs, setCollapsedSubs] = createSignal<Set<string>>((() => {
    try {
      const keys: string[] = JSON.parse(localStorage.getItem("teapot.collapsed") ?? "[]");
      // a TOP-LEVEL chat id in this set is a leftover, not a choice.
      //
      // A chat's caret writes `chat:<id>` into `teapot.wsCollapsed`; nothing in
      // the current UI writes a bare top-level id here. An entry like that can
      // only predate it — and `treeRowsOf` honours this set (`collapsedSubs`),
      // so it silently hid the whole subtree while the caret pointed open and the
      // 🧩 badge kept counting. That is the reported DOM.
      //
      // Sub-agent ids are untouched: a sub-agent's caret DOES write here, and
      // those entries are the operator's own collapse state.
      return new Set(keys.filter((k) => typeof k === "string" && !k.startsWith("chat:")));
    } catch { return new Set(); }
  })());
  /**
   * Is this sub-agent group collapsed RIGHT NOW?
   *
   * DEFAULT IS COLLAPSED. The persisted legacy `teapot.collapsed` set is still honoured (so
   * an existing profile keeps whatever it had), but "not mentioned" now means CLOSED — that is
   * `!expandedSubs().has(id)`.
   */
  const subsCollapsed = (id: string): boolean =>
    collapsedSubs().has(id) || !expandedSubs().has(id);
  const toggleCollapse = (id: string) => {
    // only an explicit EXPANSION is recorded; collapsing just drops the override
    const next = new Set(expandedSubs());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedSubs(next);
    localStorage.setItem("teapot.expandedSubs", JSON.stringify([...next]));
    // and clear any legacy collapse entry, or the group stays shut with the caret open
    if (next.has(id) && collapsedSubs().has(id)) {
      const cleared = new Set(collapsedSubs());
      cleared.delete(id);
      setCollapsedSubs(cleared);
      localStorage.setItem("teapot.collapsed", JSON.stringify([...cleared]));
    }
  };
  // The tree and grouping rules live in ./sidebar-tree so they can be unit
  // tested without a DOM (happy-dom does no layout). These wrappers only feed
  // the pure functions the live signal values.

  /**
   * Sidebar rows, annotated with where the WORKSPACE changes.
   *
   * The tree groups by parent/child agent only, so chats belonging to entirely
   * unrelated projects end up interleaved in one undifferentiated list — the
   * "which chat was that?" problem. Every agent already carries its workspace,
   * so grouping needs no new concept at all; a header row marks each project.
   * Sub-agents inherit their parent's workspace so a subtree stays together.
   */
  const _workspaceOf = (id: string): string => workspaceOfPure(agents(), id);
  /** the `chat:<id>` group this agent collapses under — its top-level ancestor,
   *  so a sub-agent shares its parent's group rather than becoming its own */
  const chatGroupKey = (a: Agent): string => chatGroupKeyOf(agents(), a);

  /** collapsed workspace groups in the sidebar — persisted, like the
   *  sub-agent collapse state above, so a reload keeps the operator's grouping */
  const [wsCollapsed, setWsCollapsed] = createSignal<Set<string>>((() => {
    try {
      const raw = JSON.parse(localStorage.getItem("teapot.wsCollapsed") ?? "[]");
      const keys = Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];

      // migrate keys left by the deleted #18 chat-header row, which wrote
      // `chat:<id>` here when clicked. That row is gone, so the keys are
      // UNREACHABLE — nothing can clear them, and each one collapses a chat the
      // operator never collapsed, hiding sub-agents the sidebar still badges.
      //
      // Narrow and one-shot: only `chat:<id>` entries are dropped, so `ws:` keys
      // and anything the current UI wrote survive; `teapot.wsCollapsed.v`
      // records that the pass ran.
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

  // A top-level chat is a collapse GROUP too: its row is the group, and its
  // sub-agents hang beneath it. Collapsing one hides it and its whole subtree
  // without touching its siblings in the same directory — the ability #18
  // wanted, without the extra header row it used to require.
  const chatCollapsed = createMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const k of wsCollapsed()) if (k.startsWith("chat:")) out.add(k);
    return out;
  });

  const treeRows = createMemo(() =>
    // 👻 toggle: drop ghost sessions (workspace missing on disk) from the
    // sidebar tree entirely — they are noise once you know about them
    treeRowsOf(
      agents(),
      // every sub-agent group the operator has NOT explicitly expanded (default: closed)
      new Set(
        agents()
          .filter((a) => subsCollapsed(a.id))
          .map((a) => a.id),
      ),
      hideGhosts(),
      chatCollapsed(),
    ),
  );
  /**
   * Toggle a group header.
   *
   * `isCollapsed` is the state the header is DISPLAYING, not a re-derivation of
   * the stored set — those can disagree after #58, and when they do, keying the
   * decision off the stored set means clicking a header that plainly reads
   * "collapsed" takes the expand branch that looks for a key it does not have,
   * and instead COLLAPSES again. `alsoClear` is the key actually holding the
   * group hidden (a legacy `chat:<id>`), which no other control can remove.
   */
  const toggleWsGroup = (
    groupKey: string,
    label: string,
    isCollapsed: boolean,
    alsoClear?: string,
  ) => {
    const next = new Set(wsCollapsed());
    if (isCollapsed) {
      // expanding: drop every key that could be hiding this group
      next.delete(groupKey);
      if (alsoClear) next.delete(alsoClear);
    } else {
      next.add(groupKey);
      if (alsoClear) next.delete(alsoClear);
      // Collapsing hides the chat(s) in the group — including the one the
      // operator is currently reading. That reads as "my session vanished", so
      // say what happened and how to get back. The open conversation stays
      // loaded and keeps running either way; only its sidebar row goes away.
      const open = selected();
      if (open && (groupKey === `chat:${open}` || chatGroupKey(agents().find((x) => x.id === open)!) === groupKey))
        flashHint(`hid ${label} — click the header to show it`);
    }
    setWsCollapsed(next);
    try {
      localStorage.setItem("teapot.wsCollapsed", JSON.stringify([...next]));
    } catch {
      /* private mode / quota — the toggle still works for this session */
    }
  };
  /** last path segment, for a compact workspace header */
  const basenameOf = (p: string): string => p.replace(/\/+$/, "").split(/[/\\]/).pop() || p;
  /** "1 chat" / "3 chats" — a header saying "1 chats hidden" looks broken */
  const wsCountLabel = (ws: string): string => {
    const n = wsChatCounts().get(ws) ?? 0;
    return `${n} chat${n === 1 ? "" : "s"}`;
  };
  /**
   * How many TOP-LEVEL chats share each workspace.
   *
   * Several separate top-level chats commonly point at ONE working directory,
   * and grouping by path alone merged them into one anonymous bucket — the
   * exact "which chat was that?" question the grouping was meant to answer,
   * answered worst where it mattered most. The header now carries the count so
   * a shared directory reads as "N chats" instead of looking like one.
   */
  const wsChatCounts = createMemo(() => wsChatCountsOf(agents()));
  /**
   * Sidebar rows with TWO header levels.
   *
   * Level 1 — WORKSPACE: a header wherever the working directory changes, the
   * grouping #18 introduced so unrelated projects stop interleaving.
   *
   * Level 2 — CHAT: each TOP-LEVEL chat is its own group. Grouping by
   * workspace path alone gave every chat in a directory ONE identity — one
   * header, one collapse toggle, one row to hide — but "some top-level chat
   * dirs exist in the same working directory and are separate" means they must
   * be independently addressable. A count badge said "there are 2" without
   * giving them separate identities; nesting them under the directory fixes
   * the identity while keeping the project grouping meaningful.
   *
   * Sub-agents inherit their parent's chat group, so a subtree collapses as one.
   */
  // The row/grouping rules — including the #58 "no chat header for a solo
  // chat" decision — live in ./sidebar-tree, where they are unit-tested.
  const sidebarRows = createMemo(() =>
    sidebarRowsOf(agents(), treeRows(), wsCollapsed()),
  );

  /**
   * Events requested per page.
   *
   * the timeline pairs a tool_call with its tool_result by walking the
   * events it holds, so a window that can contain a result WITHOUT its call
   * strands the bash row at "running…" forever. The server default was raised
   * to 2000 for exactly this, but the UI passed an explicit `limit=300` and
   * therefore never benefited — 300 is small enough that a command streaming
   * one event per delta evicts its own call.
   *
   * A page is cheap (a tail read) and the clamp is server-side, so ask for the
   * size the pairing actually needs rather than a round number that undoes the
   * fix.
   *
   * MEASURED across every session log: the largest observed gap is **1284** events (wait_children;
   * bash tops out at ~302). Headroom at the worst case is ~716 events and **zero** gaps reach 2000,
   * so eviction is not currently reachable.
   *
   * Recorded because this looks like a tuning knob worth "fixing" and is not: raising it costs a
   * bigger fetch on every refresh. If a future session does produce a gap near 2000, that is the
   * signal to raise it — not this comment.
   */
  const FEED_PAGE = 2000;

  // null = show everything; otherwise only the chosen branch's events
  const [branchFilter, setBranchFilter] = createSignal<string | null>(null);
  // Reference-stabilize events across fetches: logged events are immutable,
  // so reuse the previous object when the id already exists. Without this,
  // every refresh produced all-new references and Solid's <For> tore down
  // and rebuilt EVERY timeline row (markdown re-parse included) — heavy on
  // long sessions and it collapsed open <details>.
  const evCache = new Map<string, Ev>();
  // evCache keys are scoped per session: raw ids (e1, e2…) are only unique
  // WITHIN one log, so a cross-session key collision made stabilize() return
  // another session's row — the "teapot-b3c520e0 shows teapot-3's timeline" bug.
  function cacheKey(ev: { id: string }): string {
    // scoped by the internal session id (the log), NOT the agent id — agent
    // ids are recycled across incarnations, so two incarnations of one agent
    // must not share cache entries either
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

  // upward pagination: prepend the page before the oldest loaded id
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  /**
   * The FIRST page for the current session is in flight.
   *
   * Without it the feed showed its "no events yet — say something or press ▶ start" fallback while
   * the fetch was still running, which reads as a session that lost its history rather than one
   * that is loading — reported as "タイムラインロード中にアイテムが無いって表示されてるの微妙".
   */
  const [loadingFeed, setLoadingFeed] = createSignal(false);
  const [olderDone, setOlderDone] = createSignal(false);
  // Generation token guarding every async timeline fetch. Switching sessions
  // bumps it; responses that come back after a switch belong to a dead view
  // and must NOT touch events/scroll (they used to overwrite the freshly
  // loaded timeline with the PREVIOUS session's rows).
  let feedGeneration = 0;
  // /branches is fork-only data: skip refetching within one generation
  let lastBranchesGen = -1;

  /** merge fetched page into state by id, seq-ascending, refs stabilized */
  function mergeEvents(incoming: Ev[]): void {
    const stable = stabilize(incoming);
    setEvents((prev) => {
      // FAST PATH: the overwhelmingly common case is an APPEND — a new event arrived at the
      // end. Rebuilding a Map and re-sorting the whole array for that hands `<For>` a new
      // array of 1,100 entries every frame, which makes it diff every row: that is the
      // "スクロール中に変にブレたり、一瞬ブランクになったり" report. Appending keeps every
      // existing reference equal, so Solid patches only the tail.
      if (stable.length > 0 && prev.length > 0) {
        const newest = prev[prev.length - 1]!;
        const allNewer = stable.every((e) => e.seq > newest.seq);
        const known = new Set(prev.map((e) => e.id));
        if (allNewer && stable.every((e) => !known.has(e.id))) {
          return [...prev, ...stable];
        }
      }
      // general path: dedupe by id, then sort. Used for backfill (prepend) and for a
      // reconnect that fills a gap.
      const map = new Map<string, Ev>();
      for (const e of prev) map.set(e.id, e);
      let added = false;
      for (const e of stable)
        if (!map.has(e.id)) {
          map.set(e.id, e);
          added = true;
        }
      // nothing new → return the SAME array, so no re-render happens at all
      if (!added) return prev;
      return [...map.values()].sort((a, b) => a.seq - b.seq);
    });
  }

  // After the initial page lands, the feed may not even fill the viewport
  // (a fresh session shows only the last ~dozen rows). scrollTop can never
  // reach the "at top" trigger then, so older pages were unreachable. Keep
  // pulling until the feed overflows or history is exhausted.
  async function backfillUntilScrollable(): Promise<void> {
    const id = selected();
    if (!id || olderDone() || loadingOlder()) return;
    /**
     * A session following the tail has nothing to backfill FOR.
     *
     * Backfilling exists so the reader can scroll up when the first page does not fill the
     * screen. While pinned to the tail of a session that is still producing rows, the feed grows
     * at the bottom, so "not scrollable yet" stays true for a moment and this loop pulls up to 20
     * OLDER pages — reported as "稼働中のエージェントのセッションに移動するときに、とても重くて…
     * その後スクロールが数十分前レベルのアイテムまで遡ることがある".
     *
     * Both symptoms come from that: 20 sequential round trips on every switch to a running
     * session (the "とても重い"), and the extra prepended history leaving the viewport parked far
     * above where the reader expected to be (the "遡る").
     *
     * Reading upward is what creates the need for more history, and `loadOlder()` already runs on
     * scroll. So the eager fill is skipped while following.
     */
    if (atBottom()) return;
    // EVERYTHING is already loaded → no older history exists at all. Exit
    // before touching the server (a fresh session with a short log lands
    // here immediately — no probing, no loop).
    if (events().length >= eventsTotal()) {
      setOlderDone(true);
      return;
    }
    // Only trust measurements from a LAID-OUT feed. Hidden/unmounted feeds
    // report scrollHeight 0 and would look "never full", causing pointless
    // page pulls; if we cannot measure, we do not guess.
    const measurable = () => {
      const f = feedEl();
      return f && f.clientHeight > 0 ? f : null;
    };
    let guard = 0;
    while (guard++ < 20 && !olderDone() && selected() === id) {
      const f = measurable();
      if (f && f.scrollHeight > f.clientHeight + 40) return; // scrollable now
      if (events().length >= eventsTotal()) {
        setOlderDone(true);
        return;
      }
      const before = events().length;
      await loadOlder();
      // empty page (or fully deduped) means history is exhausted — loadOlder
      // has set olderDone itself in the empty-page case
      if (events().length === before) return;
      // prepending grows the content ABOVE the viewport; keep the reader
      // pinned to the tail while we backfill, or follow mode silently died
      // here and "new messages appear at the top of my view" was the result.
      // Sampled, not the sticky flag: prepending is itself a height change.
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
      /**
       * Ask for the SESSION whenever we know one — even when it equals the agent id.
       *
       * This used to be `tid !== id`, i.e. "only send ?session= when it is not the agent id". But
       * `tid` can be an agent id while the URL names a different session (the index had not loaded
       * when the first select ran), and omitting the query then made the server answer with the
       * agent's BOUND session. Reported as "パスは `/session/teapot-10-16854917` なのに
       * `tyb2-8-0161a4af` のセッションのタイムラインになってた" — the address bar and the feed
       * disagreeing about which conversation is on screen.
       *
       * The server already validates ownership: `?session=` is ignored unless the agent owns the id
       * (see `/api/agents/:id/events`). So sending it is safe, and it is the only way the feed can
       * agree with the URL.
       */
      const res = await api(eventsUrl(id, { before: oldest.id }, tid, bf));
      const page: Ev[] = res.events ?? [];
      if (page.length === 0) { setOlderDone(true); return; }
      // still the same session AND still anchored on the same oldest row?
      // (a plain selected() check can't be fooled by same-session tail
      // refreshes, which never touch the head of the list)
      if (selected() !== id || events()[0]?.id !== oldest.id) return;
      mergeEvents(page);
      // keep the viewport anchored to the same content after prepending
      requestAnimationFrame(() => {
        if (selected() === id) {
          const el = feedEl();
          if (el) el.scrollTop = prevTop + (el.scrollHeight - prevH);
        }
      });
    } catch { /* transient — user can scroll up again */ }
    finally { setLoadingOlder(false); }
  }

  /**
   * `&session=<internalId>` for the events endpoints — the ONE place that decides it.
   *
   * The frontend has four events call sites (older page, first page, catch-up, and the
   * loadOlder prepend). Three of them used to build this expression independently as
   * `tid !== id`, i.e. "send ?session= only when the handle is not the agent id" — and each time
   * one was fixed the others silently kept the bug, which is why the symptom returned in the
   * OPPOSITE direction: the feed showed the previous session's timeline under the new URL.
   *
   * `tid !== id` cannot express the question. `tid` falls back to the agent id while the session
   * index loads, and in that state omitting the query makes the server answer with the agent's
   * BOUND session. So: send it whenever the index KNOWS the id. The server re-validates ownership
   * (`?session=` is ignored for a session the agent does not own), so this is safe.
   */
  function sessionQuery(agentId: string, tid: string): string {
    if (!tid) return "";
    /**
     * `tid === agentId` does NOT mean "the bound session, nothing to say".
     *
     * The timeline handle falls back to the agent id while the index is loading, and in that state
     * the URL may already name a DIFFERENT session. Omitting the query then lets the server answer
     * with the agent's BOUND session, so the feed shows one conversation under another's address —
     * the reported symptom, in both directions.
     *
     * If the index knows the id, it is a real session and must be asked for. If it does not, there
     * is nothing to ask for: the bound log is the only answer available.
     */
    return masterSessionIndex().has(tid) ? `&session=${encodeURIComponent(tid)}` : "";
  }

  /**
   * The events URL for one page of a session's timeline.
   *
   * Both fragments that every call site needs were built inline at three places each:
   * `&session=` (the bug that kept coming back, because fixing one copy left the others) and
   * `&branch=…&lineage=true`. Duplicated URL assembly is how a field gets dropped from ONE path and
   * not the others, so it lives here.
   *
   * `lineage=true` is not optional: the tail fetch asks for it, so a filtered fork's first page
   * shows the INHERITED history. Omitting it on the older-pages fetch switched to strict filtering
   * and the parent's pre-fork rows vanished from the top, reading as data loss.
   */
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
    // DON'T bump the generation here. Bumping made two racing loads for the
    // SAME session invalidate each other: select() → loadEvents (gen N) and a
    // WS-triggered refresh (gen N+1) could resolve in either order, and the
    // loser was dropped — if the WS one landed first, the select's own fetch
    // was discarded AFTER the session had been cleared, leaving an EMPTY
    // timeline until some later event happened to trigger another refresh.
    // The generation only needs to move on actual session SWITCHES.
    const genAtStart = feedGeneration;
    const tid = sessionId ?? timelineId() ?? "";
    try {
      const bf = branchFilter();
      // /branches only changes on fork — fetch it on session switch, not on
      // every tail refresh (each call re-reads the log server-side otherwise)
      const needsBranches = genAtStart !== lastBranchesGen || !branches().length;
      // only when there is nothing to show yet: a tail refresh must not flash a spinner over a
      // perfectly good timeline
      if (!events().length) setLoadingFeed(true);
      /**
       * SKILLS are fetched SEPARATELY, not awaited with the timeline.
       *
       * They were the third leg of this `Promise.all`, which made every session switch wait for
       * a filesystem walk over three skill roots before a single row could paint. Skills are only
       * read by the `/` palette and the settings list, so nothing on screen needs them — part of
       * "稼働中のエージェントのセッションに移動するときに、とても重い".
       *
       * Failure is ignored on purpose: an agent whose skill roots are unreadable should still
       * show its timeline.
       */
      void api(`/api/agents/${id}/skills`)
        .then((sk) => {
          if (genAtStart === feedGeneration && selected() === id) setAgentSkills(sk.skills ?? []);
        })
        .catch(() => {});
      const [ev, br] = await Promise.all([
        // `lineage=true` so a filtered fork shows the history it inherited,
        // matching the context the agent actually reasons over. Filtering by
        // strict branch id showed less than the model sees, which read as data
        // loss even though nothing was missing from the log.
        api(eventsUrl(id, {}, tid, bf)),
        needsBranches
          ? api(`/api/agents/${id}/branches`)
          : Promise.resolve({ branches: branches() }),
      ]);
      if (needsBranches) lastBranchesGen = genAtStart;
      // stale iff a DIFFERENT session is now selected or a switch happened
      // while we were in flight — same-session refreshes must not drop us
      if (genAtStart !== feedGeneration || selected() !== id) return; // stale view
      setEvents((prev) => {
        // tail refresh: union-merge so prepended older pages survive, and
        // stabilize() keeps unchanged rows reference-identical (no re-mounts)
        const map = new Map<string, Ev>();
        for (const e of prev) map.set(e.id, e);
        for (const e of stabilize(ev.events)) map.set(e.id, e);
        return [...map.values()].sort((a, b) => a.seq - b.seq);
      });
      setEventsTotal(ev.total ?? ev.events.length);
      setBranches(br.branches);
    } catch { /* agent may be gone */ }
    finally { setLoadingFeed(false); }
  }

  function feedEl() { return document.querySelector<HTMLElement>(".feed"); }
  /**
   * The feed's geometry, as the follow rule wants it.
   *
   * Sampling at the moment of the decision is the whole point: the old code kept a sticky
   * `atBottom` flag updated by `onscroll`, and content can grow with NO scroll event, so
   * the flag was stale exactly when it mattered.
   */
  function tailSample(): TailSample | null {
    const f = feedEl();
    if (!f) return null;
    return { top: f.scrollTop, height: f.scrollHeight, viewport: f.clientHeight };
  }
  /** is the reader at the tail RIGHT NOW */
  function nearBottom() {
    // `atTail` uses the one constant slack. The old `bottomSlack()` derived the threshold
    // from the composer's overflow, so "at the bottom" meant a different pixel distance
    // whenever the composer grew a line — which is what made follow mode tug at the
    // reader. Content growth is handled by the rule, not by widening the threshold.
    const s = tailSample();
    return atTail(s);
  }
  /**
   * PIN the feed to the tail — the ONLY way the view ever moves while following.
   *
   * `scrollTop = scrollHeight` is clamped by the browser to the real maximum, so it is
   * correct without knowing the viewport. That matters: the previous design compared a
   * `viewport` read before and after the change, and every case where it settled outside
   * that window (the composer growing above all) produced a different bug.
   *
   * Repeating it is harmless, which is why every layout-changing path can call it without
   * having to reason about order.
   */
  function pinToTail() {
    const f = feedEl();
    if (!f) return;
    f.scrollTop = f.scrollHeight;
    // record where the write landed, so the scroll event it produces is attributable to US
    // rather than to the reader (see `classifyScroll`)
    ledger = { top: f.scrollTop, height: f.scrollHeight };
    setMissed(0);
  }
  function scrollBottom(force = false) {
    if (force || atBottom()) pinToTail();
  }

  // Per-session timeline snapshots: switching back to a recently viewed
  // session restores its last-known rows INSTANTLY, then loadEvents refreshes
  // in the background. Without this, every switch cleared the feed and
  // re-fetched (a visible blank flash + full round trip).
  /**
   * Per-session timeline snapshots, capped by BYTES as well as by count.
   *
   * Returning to a recently viewed session restores its rows instantly instead of blanking the feed
   * and re-fetching. But a snapshot holds every event object of that session, and real logs on this
   * machine run to 72,923 events / 52.8MB of JSON in ONE session — six of those is hundreds of
   * megabytes of live JS objects, which is the frontend growth reported as "ずっと開いてると900MBとか
   * いく". A count-only cap cannot see that: six small sessions are cheap and six huge ones are not,
   * and the count says 6 either way.
   *
   * MEASURED sizes on this machine: the eight largest logs total 183MB of JSON, so a byte budget is
   * the number that actually bounds retention.
   */
  const timelineCache = new Map<string, { events: Ev[]; total: number; at: number; bytes: number }>();
  /**
   * Where the reader was in each session, as a ROW and an offset — never a pixel `scrollTop`.
   *
   * A pixel offset is not portable between sessions: `scrollTop` is an offset into content whose
   * height differs, and the browser CLAMPS it to the maximum for the new content. So a stale value
   * from a long session landed hundreds of messages back in a short one, and coming back to the
   * long session could not restore anything at all because `select()` unconditionally scrolled to
   * the tail. Reported as "セッションを移ってから戻ると数百個前のメッセージまでスクロールが移動する".
   *
   * `data-eid` is the row's log event id: stable across re-wrap, and it names the ROW rather than a
   * distance, which is the only thing that means the same in a different conversation.
   */
  const scrollMemory = new Map<string, { eid: string; delta: number; atTail: boolean }>();
  const SCROLL_MEMORY_MAX = 24;
  const TIMELINE_CACHE_MAX = 6;
  /** ~24MB of retained event data: several small sessions, or one large one. */
  const TIMELINE_CACHE_MAX_BYTES = 24 * 1024 * 1024;
  /** a cheap upper bound on what one event retains — content plus every field a row renders */
  const approxEventBytes = (e: Ev): number => {
    const d = e.data as Record<string, unknown> | undefined;
    let n = 64; // the envelope (id, seq, ts, type, branch, session…)
    if (d) for (const v of Object.values(d)) if (typeof v === "string") n += v.length * 2;
    return n;
  };

  /**
   * The session an agent should open: the one the server says it is BOUND to, falling back to the
   * newest on disk. Preferring mtime alone would resurrect an old session whose directory is stale
   * but whose log is newer, putting the view and the agent's actual timeline out of step.
   */
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
    // bump FIRST so any in-flight fetch for the previous session lands on a
    // dead generation and is dropped instead of overwriting this one's rows
    feedGeneration++;
    // resolve the agent's CURRENT internal session id — the timeline handle.
    // Falls back to the agent id for brand-new agents whose first session dir
    // isn't listed yet (the events fetch still works: same log).
    if (!sessionsByAgent().size) void refreshSessionIndex(); // first select before index landed
    /**
     * NEVER let the agent id become the timeline handle once we know better.
     *
     * `?? id` was a fallback for a brand-new agent whose first session directory is not listed
     * yet — but it also fired for any agent when the session INDEX had not landed, and that value
     * is what `navigate()` writes into the URL. The result was `/session/<agentId>`, which is not a
     * session id at all: TWO tabs deep-linking to different sessions then both resolved through
     * `latestSessionOf(agentId)` and opened the SAME one ("それぞれリロードするとどっちも
     * /session/tyb2-8 になってしまった").
     *
     * An explicit request is honoured as-is while the index is unknown: the server answers
     * `?session=<id>` regardless, and the index will confirm it a moment later. Falling back to the
     * agent id only happens when there is neither a request nor any owned session.
     */
    /**
     * `resolved` first — and when the index has nothing to say, NEVER the agent id.
     *
     * The two-tabs bug: `latestSessionOf(...) ?? id` put the AGENT id into the URL whenever the
     * index had not landed, and an agent id resolves to that agent's latest session — so two tabs
     * deep-linked to different sessions both opened the same one.
     *
     * `forceSession` only fills the gap when the index is genuinely EMPTY (nothing to resolve
     * against). Once ownership data exists, resolution has an opinion and it wins: honouring a
     * request the agent does not own would let a crafted URL cross into another timeline.
     */
    /**
     * `resolved` decides when the index has an opinion; otherwise the request may name a session
     * the index has not scanned yet.
     *
     * `forceSession` must be a REAL session id, though. Passing an arbitrary path segment through
     * (the boot URL is often a placeholder like `/session/test`) would make it the timeline handle
     * and the events fetch would ask for a session that does not exist.
     */
    const resolved = latestSessionOf(id, forceSession);
    const requested = forceSession && masterSessionIndex().has(forceSession) ? forceSession : null;
    let tid = resolved ?? requested ?? id;
    if (prevId !== id || tid !== prevTid) {
      /**
       * Remember where the reader was in the OUTGOING session, as a ROW rather than a pixel.
       *
       * This MUST be the first thing in the switch, before any signal is written. Solid propagates
       * a write synchronously, so `setSelected(id)` has already re-run the feed's `<For>` by the
       * time the next line executes — capturing after it measured an EMPTY feed (`anchor: null`,
       * `scrollTop: 0`) and remembered nothing. A pixel `scrollTop` is also not portable between
       * sessions: it is an offset into content of a different height and the browser clamps it, so
       * a stale value from a long session landed hundreds of messages back in a short one.
       * `data-eid` names the ROW, which is the only thing that means the same in another conversation.
       */
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
      // remember what the outgoing session looked like so returning is instant
      if (prevTid && prevEvents.length) {
        const bytes = prevEvents.reduce((n, e) => n + approxEventBytes(e), 0);
        // a single snapshot bigger than the whole budget is not worth keeping: restoring it costs a
        // memory spike for one switch, which is exactly what the re-fetch path already handles
        if (bytes <= TIMELINE_CACHE_MAX_BYTES) {
          timelineCache.set(prevTid, { events: prevEvents, total: prevTotal, at: Date.now(), bytes });
        }
        /**
         * Evict oldest-first until BOTH budgets hold. The byte budget is the one that matters: six
         * snapshots of a 72k-event session is hundreds of MB, while six snapshots of a small
         * conversation is a few MB — a count alone cannot tell them apart.
         */
        const totalBytes = () => [...timelineCache.values()].reduce((n, v) => n + v.bytes, 0);
        while (timelineCache.size > TIMELINE_CACHE_MAX || totalBytes() > TIMELINE_CACHE_MAX_BYTES) {
          const oldest = [...timelineCache.entries()].sort((x, y) => x[1].at - y[1].at)[0];
          if (!oldest) break;
          timelineCache.delete(oldest[0]);
        }
      }
      // drop the previous session's timeline immediately — otherwise it stays
      // visible (or bleeds into the merge) until this session's fetch lands,
      // which read as "the old conversation showing up in the new session"
      setEvents([]);
      evCache.clear(); // event ids are per-log (e1, e2…) — never share across sessions
      // the optimistic answer set is per-SESSION. Carrying it across would
      // disable a question that merely reuses a callId, or one the operator
      // has not actually answered in this session.
      clearLocallyAnswered();
      // NOTE: live buffers are per-agent — leaving a session must NOT drop its
      // streaming bubble; the map keeps every session's stream independently.
      setCompacting(null);
      setMissed(0);
      /**
       * Follow mode must not leak across sessions the WRONG way.
       *
       * This was `setAtBottom(true)` unconditionally, which made every switch look like "the
       * reader is following" — so leaving a session while scrolled UP came back pinned to the tail
       * (MEASURED: left at row e33 / 9094px from the tail, returned at e237 / 0px). Reported as
       * "移動前にスクロール追従になってたら、移動後も一番下で追従されててほしい" — the inverse case,
       * and the reason it never worked is that the flag was reset before the restore could read it.
       *
       * The remembered position decides. The `true` default only covers a session we have never
       * seen, where there is no reader position to preserve and the tail is the only sensible
       * arrival point.
       */
      setAtBottom(scrollMemory.get(tid)?.atTail ?? true);
      // a session switch changes the geometry completely, so the previous sample would
      // read as an enormous scroll in whichever direction
      lastSample = undefined;
    }
    setSelected(id);
    setTimelineId(tid);
    saveDraft(drafts.get(id) ?? ""); // restore THIS session's unsent draft
    setBranchFilter(null);
    setOlderDone(false);
    setLoadingOlder(false);
    writePending(prevTid || prevId || "?", pendingMsgs());
    setPendingMsgs(pendingFor(tid || id));
    localStorage.setItem("teapot.session", id);
    navigate(tid, push); // URL carries the internal session id, not the agent id
    // HYDRATE from cache first: rows paint immediately (no blank flash), and
    // loadEvents below merges in whatever happened since. Cached events are
    // re-stabilized into evCache so reference identity survives the switch.
    const cached = timelineCache.get(tid);
    if (cached?.events.length) {
      /**
       * ONE `stabilize()` call.
       *
       * It ran twice — once for effect and once for the value — and the first call was pure waste:
       * `stabilize` WRITES to `evCache` on the way through, so the second pass found every key
       * already present and returned the same objects. MEASURED on a 2,000-event session: switching
       * back to a previously-loaded session cost 1,942ms with a 553ms frozen frame, and that is the
       * "1回でもロードしたことがあるセッションに再度移動すると絶望的にラグい" report.
       */
      setEvents(stabilize(cached.events));
      setEventsTotal(cached.total);
      /**
       * A cached session still has to REFRESH, and that is not instant.
       *
       * The spinner was gated on `!events().length`, which is true for a first load and false here —
       * so a switch that had to re-fetch showed a perfectly good (but stale) timeline with no sign
       * anything was happening, which reads as "the UI is frozen". The rows stay on screen; the
       * spinner says a refresh is in flight.
       */
      setLoadingFeed(true);
      // the rows paint from cache in the same frame; restoring here and again after the fetch would
      // fight over `scrollTop`, so only the post-fetch restore moves it
      if (!scrollMemory.has(tid)) {
        requestAnimationFrame(() => {
          if (selected() === id) scrollBottom(true);
        });
      }
    }
    // lazy sessions sit in "stopped" until touched — clicking loads them
    api(`/api/agents/${id}/load`, { method: "POST" }).then(refreshAgents).catch(() => {});
    await loadEvents(id, tid);
    if (selected() !== id) return; // another switch won while we were loading
    // RECONCILE this agent's live buffer against the timeline just loaded.
    //
    // The pruning effect depends on `agents()` alone, so it cannot fire for a
    // session switch — and if the agent was already idle at the switch, the
    // snapshot did not change either, so nothing pruned. Returning to the session
    // then re-displayed stale stream text WITH the writing cursor.
    //
    // Runs after the fetch so `events()` is the real timeline, and it keeps a
    // genuine in-flight stream (the log does not have it yet).
    setLiveByAgent((prev) => {
      const cur = prev.get(id) ?? null;
      const next = reconcileLiveBuffer(cur, events(), sel()?.status);
      if (next === cur) return prev;
      const m = new Map(prev);
      if (next) m.set(id, next);
      else m.delete(id);
      return m;
    });
    // the freshly fetched snapshot is authoritative: a compaction may be
    // mid-flight on this session (missed bus events while another tab/agent
    // was selected) — seed the banner from ctx.compacting
    setCompacting(
      sel()?.ctx?.compacting ? { phase: String(sel()!.ctx!.compacting) } : null,
    );
    /**
     * Restore where the reader was, if we know; otherwise go to the tail.
     *
     * This used to be `scrollBottom(true)` unconditionally, so every switch — including coming back
     * to what you were reading — threw the position away. The remembered position is a row id, so
     * it survives rows being re-wrapped or the page being re-fetched; a row that is no longer in the
     * first page simply does not match and we fall back to the tail rather than guessing a pixel.
     */
    const restore = scrollMemory.get(tid);
    /**
     * Restore the FOLLOW state before anything async runs, not inside the rAF below.
     *
     * `backfillUntilScrollable()` is called after this and exits early on `atBottom()` — "a session
     * following the tail has nothing to backfill FOR". That guard is what prevents the reported
     * "移動後に数十分前のアイテムまで遡る": the eager fill would pull up to 20 OLDER pages, and the
     * prepended history leaves the viewport parked far above the tail.
     *
     * It could not do its job here. `atBottom()` was only set inside the rAF, so between the switch
     * and that frame it still held the value it had for the OUTGOING session (or a stale default),
     * and backfill made its decision on that. Setting it synchronously means the guard reads the
     * reader's real intent for THIS session — following stays following, and a reader who was
     * scrolled up still gets their history backfilled.
     */
    setAtBottom(restore ? restore.atTail : true);
    requestAnimationFrame(() => {
      if (selected() !== id) return;
      if (restore) {
        const f = feedEl();
        const row = f?.querySelector<HTMLElement>(`[data-eid="${CSS.escape(restore.eid)}"]`);
        if (f && row) {
          f.scrollTop += row.getBoundingClientRect().top - f.getBoundingClientRect().top + restore.delta;
          ledger = { top: f.scrollTop, height: f.scrollHeight };
          // a following reader must be EXACTLY at the tail, not merely near it
          if (restore.atTail) scrollBottom(true);
          return;
        }
        /**
         * The remembered row is not in the first page.
         *
         * Going to the tail would be wrong for a reader who was scrolled UP: it is the opposite of
         * where they were, and `loadOlder()` will pull the page that contains their row when they
         * scroll. Only a following reader lands at the bottom; anyone else keeps the first page and
         * lets the history fill in on demand.
         */
        if (restore.atTail) scrollBottom(true);
        return;
      }
      scrollBottom(true);
    });
    // the first page may not fill the viewport — pull older pages until it
    // does (or history runs out), so infinite scroll is always reachable
    void backfillUntilScrollable();
  }

  /* ---------- realtime over WebSocket (auto-reconnect) ---------- */
  const [connected, setConnected] = createSignal(false);
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => ws?.close());
  let pendingRefresh = false;
  /** set when a socket frame reveals a GAP; cleared by the one REST read that closes it */
  let feedNeedsRead = false;
  // the visibilitychange listener is registered ONCE below (outside
  // connectWs) — a reconnect used to add another copy each time, leaking
  // closures and timers with every reconnect cycle
  let onTabVisible: (() => void) | null = null;
  document.addEventListener("visibilitychange", () => onTabVisible?.());
  onCleanup(() => { onTabVisible = null; });
  // the FIRST onopen must not double-load; every later one is a reconnect
  let firstConnect = true;
  /**
   * After a socket reconnect, fetch only the events we missed.
   *
   * Asks `/events?after=<last id we hold>` and merges the result. Three outcomes,
   * and the distinction matters:
   *
   *  - events returned      → merge them; the gap is closed
   *  - `gap: true`          → our cursor is not a prefix of the log (rotated,
   *                           compacted, or a session switch happened while the
   *                           socket was down). The server already fell back to a
   *                           full tail, so replace rather than merge.
   *  - nothing returned     → we were already current; do NOT re-read
   *
   * `refreshAgents` still runs because the AGENT's status can have changed with no
   * event of its own (a stop, a status transition the log does not carry).
   */
  // `runFeedRefresh` is a `const` declared further down. It is initialised before
  // any socket can open, so a lazy reference is safe; this keeps the type checker
  // happy without reordering the file.
  let runFeedRefreshRef: (() => Promise<void>) | null = null;

  async function catchUpAfterReconnect(): Promise<void> {
    const id = selected();
    const cursor = events().at(-1)?.id;
    const tid = timelineId();
    const hidden = document.visibilityState === "hidden";
    if (!id || !cursor) {
      // nothing to anchor on — a full load is the only option
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
        // our cursor is not in the log: a full tail came back, so REPLACE
        setEvents(stabilize(got));
        setEventsTotal(got.length);
      } else if (got.length) {
        mergeEvents(got);
        setEventsTotal((n) => n + got.length);
      }
      await refreshAgents();
      if (got.length && !hidden) void refreshMetrics();
    } catch {
      // a failed catch-up must not wedge the reconnect loop; the next socket
      // open retries, and the periodic refresh still runs meanwhile
      pendingRefresh = true;
    }
  }

  function connectWs() {
    // `firstConnect` belongs to a SOCKET, not to the page. Reset it per
    // connection, or a reconnect that itself dropped would be mistaken for the
    // first connect and the resync skipped again — reintroducing the original
    // bug after a single bounce.
    firstConnect = true;
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    const sock = new WebSocket(`${proto}${location.host}/api/ws${wsTokenQuery()}`);
    ws = sock;
    // a reconnect RESYNCS. The server delivers events only to live
    // sockets and replays nothing, so anything logged while the socket was down
    // — a bash tool_result above all — simply never arrived. The feed refresh
    // is otherwise 100% dependent on an unbroken stream, which is why the
    // ordinary HTTP path appeared to work and the socket path did not.
    //
    // The first connect is skipped: select() already loads events, and doing it
    // twice would double every fetch on startup.
    //
    // this flag was NEVER SET TO FALSE, so `!firstConnect` was always false
    // and the early return never ran — the code refreshed on the FIRST open,
    // which is precisely what the comment above says it must not do. The test
    // that "covered" it asserted the source text, so it passed on broken code
    // (#75's exact failure mode).
    sock.onopen = () => {
      setConnected(true);
      if (firstConnect) {
        // first open of THIS socket: select() already loaded the feed
        firstConnect = false;
        return;
      }
      // a RECONNECT asks only for what it missed.
      //
      // It used to set `pendingRefresh` and re-read the whole tail — 2,000 events
      // by default — to learn about the handful that arrived while the socket was
      // down. That is the cost of REST being the source of truth.
      //
      // Now the cursor makes recovery proportional: ask for everything after the
      // last event we already hold. A reconnect that missed two events transfers
      // two events.
      void catchUpAfterReconnect();
    };
    sock.onclose = () => {
      setConnected(false);
      setTimeout(connectWs, 1500); // reconnect with a fixed short backoff
    };
    sock.onerror = () => sock.close();
    // event types that don't change the feed — refreshing on every one of
    // these would hammer /events several times per turn for nothing
    const FEED_IRRELEVANT = new Set(["state", "usage", "session_start"]);
    // (live buffers are keyed per agent in liveByAgent — see the App body)
    sock.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      // the server's ping doubles as a liveness probe — a client that has
      // stopped answering is reaped, because its send buffer grows without
      // bound while it is not reading. So the reply is now MANDATORY, not
      // optional politeness: silently dropping the ping would get every real
      // client disconnected after two intervals.
      if (msg.kind === "ping") {
        try {
          sock.send(JSON.stringify({ kind: "pong" }));
        } catch {
          /* socket already closing */
        }
        return;
      }
      if (msg.kind === "pong") return;
      // the server sends an AUTHORITATIVE snapshot the moment the socket
      // opens (`kind:"hello"` in the WS route), and the frontend discarded it — so a reconnect
      // agent state only from the REST poll that followed, and the WS and REST
      // paths could disagree in the meantime. That is the dual-state problem the
      // whole event architecture is meant to avoid.
      //
      // Apply it through the same merge, so identity handling is identical to the
      // other two snapshot paths.
      if (msg.kind === "hello" && Array.isArray(msg.agents)) {
        setAgents((prev) => mergeAgentSnapshots(prev, msg.agents as Agent[]));
        // a fresh authoritative snapshot can settle agents the buffers outlived,
        // so run the same prune the REST path would have triggered
        const list = agents();
        setLiveByAgent((prev) =>
          pruneDeadLiveBuffers(prev, (id) => list.find((x) => x.id === id)?.status),
        );
        return;
      }
      if (msg.kind === "event" && isTurnBoundary(msg.event)) {
        // TURN BOUNDARY. The agent's `status` does not change between
        // tool calls inside one round, so a completed reply's live buffer was
        // never cleared: the feed refresh below only drops it once a persisted
        // assistant message matches its text, and its `status !== "running"`
        // short-circuit kept it alive meanwhile. The previous turn's text then
        // kept rendering under the streaming…/writing… chrome — reported as
        // "agent2 shows agent1's message, with a writing prompt attached".
        //
        // The server logs one "llm turn start" state event per turn (with an
        // incrementing `turn`), which is the only reliable boundary signal. The
        // empty llm-delta the server sends before each call is NOT usable: it
        // fires on every RETRY attempt too, so clearing on it would flash the
        // bubble away mid-reply.
        setLiveByAgent((prev) => clearLive(prev, msg.agentId));
        return; // the feed refresh below handles the actual row
      }
      if (msg.kind === "llm-delta") {
        // the bubble lives INSIDE a session-scoped timeline, so the delta must
        // belong to the DISPLAYED session, not merely to the same agent — one
        // agent has many sessions and the reader may be on a past one.
        //
        // A missing id is a rejection too, not a pass: it cannot be attributed,
        // and `sessionId` is REQUIRED by the bus type (src/bus.ts).
        if (!deltaBelongsToTimeline(msg, selected(), timelineId())) return;
        // update THIS agent's buffer only — other sessions keep streaming in
        // the background and their bubble must survive session switches
        setLiveByAgent((prev) => applyDelta(prev, msg.agentId, msg));
        // thinking-timer bookkeeping (selected session only): start the clock
        // when reasoning arrives with no text yet; reset once real text flows
        if (msg.agentId === selected()) {
          const r = String(msg.reasoning ?? "");
          const t = String(msg.text ?? "");
          if (r && !t) {
            // arm on the first reasoning chunk. Guarded so a mid-stream
            // delta that arrives with NEITHER text nor reasoning cannot re-arm it,
            // which would restart the elapsed time mid-thought.
            if (!thinkStartedAt()) setThinkStartedAt(Date.now());
          } else if (t) {
            // reset only when real TEXT arrives. The old second clause was
            // `t || (!r && thinkStartedAt())`, and a delta carrying neither text
            // nor reasoning — which the provider sends between chunks — zeroed the
            // clock, so the readout flickered back to nothing mid-thought.
            setThinkStartedAt(0);
          }
        }
        return;
      }
      if (msg.kind === "compaction-progress") {
        if (msg.agentId !== selected()) return;
        if (msg.phase === "done") setCompacting(null);
        else setCompacting({ phase: msg.phase, summarized: msg.summarized });
        // the phase banner rides on top of the feed — no refresh needed until
        // the compaction event itself lands
        return;
      }
      // agent-update now carries the fresh snapshot: apply it directly —
      // no GET /api/agents round-trip per event
      if (msg.kind === "agent-update" && msg.snapshot) {
        setAgents((prev) => {
          const i = prev.findIndex((a) => a.id === msg.snapshot.id);
          const next = msg.snapshot;
          if (i === -1) return [...prev, next];
          // content-equal → keep the OLD object: a new identity for unchanged
          // data re-ran every expression bound to that agent and was the last
          // source of the rare right-panel flash
          return mergeAgentSnapshots(
            prev,
            prev.map((a, j) => (j === i ? msg.snapshot : a)),
          );
        });
        return; // snapshot IS the update; no feed refresh needed for it alone
      }
      /**
       * Server-wide state, PUSHED.
       *
       * These replace the 30s `/api/metrics` + `/api/tasks` poll. The payload IS the answer, so there
       * is nothing to fetch — assigning it is the whole handler.
       */
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
        // a prompt-delivered note means the text ENTERED an LLM call payload —
        // flip the matching pending echo to "sent"; a prompt-cancelled note
        // drops the echo. BOTH fall through so the feed refresh below picks up
        // the logged prompt row in the same pass (the old early-returns made
        // the "sent ✓" echo linger until some unrelated event refreshed).
        /**
         * A delivery/cancel note clears its echo for ANY session, not just the visible one.
         *
         * The two cases were gated on `msg.agentId === selected()`. Echoes are stored PER SESSION
         * (`pendingBySession`), so a prompt delivered while the operator was reading a different
         * session kept its echo forever — "you" stayed `queued` with no way to clear it, reported as
         * "youのはずっとqueuedが外れない". The note names the session, which is all that is needed to
         * find the right map; the VISIBLE one was never the right filter.
         */
        if (et === "system_note" && (ed.event === "prompt-delivered" || ed.event === "prompt-cancelled")) {
          const pid = String(ed.promptId ?? "");
          if (pid) {
            /**
             * Which session's echoes to touch: the note carries the session it belongs to, and the
             * visible one is a safe fallback for an older event that predates the field.
             */
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
        // notify the operator about notable moments from ANY session — that's
        // the point of the notification center (progress / finish / question /
        // error), even when the timeline isn't being watched
        maybeNotify(msg.agentId, msg.event);
        // only the affected session's feed needs updating — other sessions'
        // timelines are fetched on switch, not eagerly
        if (msg.event?.agent !== selected()) return;
        // #146/#54: and the SESSION must match too — via the SHARED rule, so this
        // gate cannot disagree with `isTimelineLive()` and `deltaBelongsToTimeline`
        // about the fallback view. See frontend/session-scope.ts: while no session
        // is resolved, `timelineId()` is the AGENT ID, and comparing it against an
        // event's real session dropped EVERY frame — the socket went silent and
        // only REST moved the feed, which is the #54 report verbatim.
        if (!eventBelongsOnTimeline(msg.event as { agent?: string; session?: string }, selected(), timelineId()))
          return;

        // the socket payload IS the data — it is the same object the log
        // wrote, and `mergeEvents` dedupes by id and sorts by seq, so a REST page
        // and a socket event can arrive in either order.
        //
        // It must not be the ONLY path, though: `pairInfo` walks events() in
        // order and can only pair a result with a call it has already seen, and
        // `agentActive` comes from refreshAgents. So merge for immediacy AND
        // refresh for coherence — see the #145 note that follows.
        /**
         * Does the feed need a REST read for coherence?
         *
         * Only when the socket could have missed something: `seq` is monotonic per session, so a
         * delivered seq more than one past the newest held row means a gap (a reconnect, or the
         * 300-event window). Otherwise the socket payload IS the data and the read is redundant —
         * it used to run on every burst, several times a second on a busy session.
         */
        {
          const heldSeq = events().at(-1)?.seq ?? 0;
          const arriving = Number((msg.event as { seq?: number })?.seq ?? 0);
          if (!heldSeq || (arriving > 0 && arriving > heldSeq + 1)) feedNeedsRead = true;
        }
        mergeEvents([msg.event as Ev]);
        // a LOGGED assistant reply covers the live bubble the INSTANT it is
        // merged — `mergeEvents` is synchronous and `isCoveredByLog` compares the
        // whole text. But the buffer used to be revalidated only inside the
        // debounced `runFeedRefresh` below (60 ms, plus the fetch), so for that
        // window the same reply rendered TWICE: once as the settled log row and
        // once as the live bubble with its writing cursor. Reported as "tool call
        // を発行するタイミングで一瞬2重になる" — it is most visible there because the
        // tool rows land immediately after, so the duplicate is sandwiched between
        // rows that belong and reads as a glitch rather than a stream.
        //
        // A PARTIAL stream is untouched: `isCoveredByLog` needs the full text, so
        // the bubble survives until the reply it is showing is actually persisted.
        /**
         * ANY logged event settles the live halves it has caught up with — not only an assistant
         * message.
         *
         * MEASURED in tyb2-8-0161a4af: the log holds `e53519` (assistant, with reasoning) and the
         * NEXT event is `tool_call bash`. The timeline drew `e53519` correctly and the 💭 block was
         * ALSO still on screen as the live bubble, carrying the same text — because this hook only
         * ran for an assistant-message frame, and a `tool_call`/`tool_result`/`state` frame is what
         * actually proves the thinking stretch ended.
         *
         * `reconcileLiveBuffer` decides per half: text waits until the log carries it, reasoning is
         * stale once a tool call starts after its last delta.
         *
         * Scoped to `event` frames: those are LOGGED rows, which is the only evidence either half
         * can be settled by. An `agent-update`/snapshot frame carries no log content, and running
         * this there retires a bubble that the very next delta would have kept alive.
         */
        if (msg.event) settleLiveBuffer();
        pendingRefresh = true;
        if (document.visibilityState !== "visible") return;
        if (timer) return;
        timer = setTimeout(runFeedRefresh, 60);
      }
      // hidden tab: defer feed work until the tab is visible again — layout
      // is paused anyway, so fetching + re-rendering now is pure waste. The
      // single shared timer collapses the backlog into ONE refresh on return.
      if (document.visibilityState === "hidden") {
        pendingRefresh = true;
        return;
      }
      if (timer) return;
      // tool results land here one by one; a 400ms debounce made each bash
      // completion feel lost ("switch away and back shows it") — the fetch
      // itself is mtime-cached and cheap, so tighten the cadence instead
      timer = setTimeout(runFeedRefresh, 120);
    };
    pendingRefresh = false;
    const runFeedRefresh = async () => {
        timer = null;
        /**
         * NO agent/metrics refetch here.
         *
         * `refreshAgents()` and `refreshMetrics()` ran on every event burst, so a busy session issued
         * both over HTTP several times a second while the socket was ALREADY delivering the same
         * facts: every `agent-update` frame carries a full `snapshot`, and metrics now arrive as
         * `kind: "metrics"`. Two sources for one value is how they disagree, and the HTTP copy is the
         * one that can be stale.
         *
         * The fetches stay where they are the only source — the initial load, a reconnect catch-up,
         * and a waking tab (all of which may have missed pushes).
         */
        if (selected()) {
          // compare last event ID, not array length: the /events window is
          // capped at 300, so long sessions have a CONSTANT length and a
          // length check never noticed new events (leaving the live bubble
          // blinking forever after the agent went idle)
          const beforeId = events().at(-1)?.id;
          const beforeLen = events().length;
          // SAMPLE THE GEOMETRY BEFORE THE FETCH. The old code read the sticky
          // `atBottom` flag AFTER new rows had been painted — state events, tool rows and
          // a grown live bubble all add height with no scroll — so by then the flag had
          // already been corrected by a scroll handler, or was about to be, and the view
          // jumped away right when a round kicked off.
          const _fetchStartedAt = Date.now();
          /**
           * Re-read the feed only when the socket could have MISSED something.
           *
           * The socket already merged the event (`mergeEvents([msg.event])`), so this read is for
           * coherence — pairing a result with its call, and the rows a burst may have skipped. Doing
           * it on EVERY burst meant a busy session issued `/events` several times a second for data
           * the socket had already delivered.
           *
           * A gap is detectable without asking: `seq` is monotonic per session, so a delivered event
           * whose seq is more than one past the newest held row means something was dropped (a
           * reconnect, or the 300-event window). Only then is a full read the answer.
           */
          if (feedNeedsRead) {
            feedNeedsRead = false;
            await loadEvents(selected()!);
          }
          // reconcile the bubble on EVERY pass, NOT inside the
          // "did the newest id change" test below — the socket MERGES the event
          // before scheduling this refresh, so that test reads false here and the
          // cleanup would never run. A persisted reply then stayed on screen a
          // second time as a live bubble with a cursor.
          const buf = live();
          if (buf && !reconcileLiveBuffer(buf, events(), sel()?.status)) setLive(null);
          if (events().at(-1)?.id !== beforeId) {
            // FOLLOW IS A STATE, so this asks the state and then acts. There is no
            // before/after geometry comparison any more: the question "did the reader leave
            // the tail while this fetch was in flight" cannot be answered reliably from
            // samples (the fetch itself may resize the feed), and it does not need to be —
            // `atBottom()` is only ever cleared by a real scroll up.
            if (atBottom()) {
              pinToTail();
              // following the tail means the operator has seen this session's
              // newest content — its notifications count as read
              markSessionRead(selected()!);
            } else {
              // Count from the EVENTS, not from `eventsTotal()`.
              //
              // `eventsTotal` is the server's count of every logged event — including ones
              // that draw no row at all (state changes, deltas, notes) and ones outside the
              // loaded window. Adding that delta reported "12 new messages" when one message
              // had arrived, and it never went down as the operator scrolled, so the pill
              // read as an ever-growing number at the wrong place.
              setMissed((n) => n + Math.max(0, events().length - beforeLen));
              // the content below grew, so the pill's gap changed. Published from the
              // geometry we are about to read anyway, not from a fresh per-render DOM read.
              publishGap(tailSample());
            }
          }
          // NOTE: don't drop pending echoes when the log's prompt event
          // appears — logging happens at ENQUEUE time, long before the text
          // reaches an LLM payload. The echo must survive until the matching
          // prompt-delivered note flips it to "sent ✓" (and it is then
          // removed only after the turn actually consumed it).
        }
    };
    runFeedRefreshRef = runFeedRefresh;
    onTabVisible = () => {
      if (document.visibilityState !== "visible") return;
      // returning to a VISIBLE tab must verify, not assume.
      //
      // This only refetched when `pendingRefresh` was already set, and that flag
      // is set by the hidden-tab branch of the WS handler. A machine waking from
      // SLEEP is a different case: the tab was never hidden, so no event arrived
      // to set the flag, and the handler did nothing at all.
      //
      // Whether the socket recovers is luck: if the server's 30s liveness reaper
      // closed it, `onclose` reconnects and `catchUpAfterReconnect` fetches the
      // gap. But a sleep often leaves the TCP connection apparently alive, so no
      // close fires, no reconnect happens, and the timeline stays frozen at
      // whatever it held when the lid shut. Reloading fixed it because that
      // reloads the log from scratch.
      //
      // So: on every return to visible, ask for what we are missing. The cursor
      // makes it proportional — a tab that slept for a minute and missed nothing
      // costs one cheap request that returns empty.
      /**
       * The server-wide numbers are HTTP on WAKE, socket the rest of the time.
       *
       * `metrics` and `tasks` used to be polled every 30s, which covered the sleeping-tab case by
       * accident. With the poll gone, the recovery path has to include them — a tab that slept
       * missed no metric PUSH it could apply, because a push it did not receive never happened.
       */
      void refreshMetrics();
      void loadTasks();
      const id = selected();
      if (!id) return;
      if (pendingRefresh) {
        pendingRefresh = false;
        // refresh IMMEDIATELY on return — the old 150ms delay made every
        // homecoming show a stale tail until the next beat
        void runFeedRefresh();
        return;
      }
      const cursor = events().at(-1)?.id;
      if (!cursor) {
        // nothing to anchor on (a session switch while away) — a full load is the
        // only correct answer
        pendingRefresh = true;
        void runFeedRefresh();
        return;
      }
      // Same call whether or not the socket is alive, and that is deliberate: a
      // socket that LOOKS connected after a sleep is the failure case, so it does
      // not get to decide that nothing is needed.
      void catchUpAfterReconnect();
    };
  }

  /* ---------- /session/<internalId> routing ---------- */
  // The URL carries the INTERNAL session id (the chat.jsonl's directory
  // name), not the agent id: agent ids are recycled across incarnations,
  // internal session ids never are — deep links stay valid forever.
  const pathId = () => decodeURIComponent(location.pathname.split("/")[2] ?? "");
  function navigate(sessionId: string, push = true) {
    /**
     * The URL carries a SESSION id, so refuse to write anything the index does not know.
     *
     * This is the structural half of the two-tabs bug: an agent id reaching here produced
     * `/session/<agentId>`, which every tab then resolves to that agent's LATEST session — so two
     * tabs pointed at different sessions collapsed onto one after a reload.
     *
     * A session that is genuinely new (its directory not scanned yet) is the one case where the
     * index cannot confirm; there the caller passes a real id and this passes it through. What is
     * refused is a handle the index positively maps to a DIFFERENT agent, and the bare agent id.
     */
    const linkable = linkableSessionId(
      sessionId,
      masterSessionIndex(),
      agents().map((a) => a.id),
    );
    if (!linkable) return; // see linkableSessionId — an agent id here merges every tab
    const url = `/session/${encodeURIComponent(linkable)}`;
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }
  window.addEventListener("popstate", () => {
    const sid = pathId();
    // resolve the internal id to its owning agent and open THAT agent's tab;
    // the timeline itself is fetched by ?session=<internalId> in loadEvents
    const owner = masterSessionIndex().get(sid);
    // this used to require `owner !== selected()`, which made Back and
    // Forward between two sessions of the SAME agent a no-op — the very case
    // the history entry exists for. Compare the SESSION, not the agent, and let
    // select() ignore a repeat of what is already showing.
    if (owner && (owner !== selected() || sid !== timelineId())) select(owner, false, sid || null);
  });

  /* ---------- small UX niceties ---------- */
  createEffect(() => {
    const a = sel();
    const base = a
      ? `${isSelLive() ? "▶ " : a.status === "error" ? "⚠ " : ""}${agentLabel(a)} · teapot`
      : "teapot";
    // unread notification count in the tab title — "(2) linux · teapot"
    document.title = unreadCount() > 0 ? `(${unreadCount()}) ${base}` : base;
  });
  /**
   * Is any overlay open? Single source of truth for the keydown handler.
   *
   * The Escape branch and the shortcut guard used to name overlays separately,
   * and they drifted: Escape handled four plus the narrow drawer, while the
   * shortcut guard knew only two — so `t` and `/` fired with the themes panel
   * open, mutating the app behind a visible overlay.
   */
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
      // Escape closes overlays; the shortcut guard below reuses the same
      // predicate so the two cannot disagree about what counts as an overlay.
      if (showNew()) { setShowNew(false); return; }
      if (showCfg()) { setShowCfg(false); return; }
      if (editing()) { setEditing(null); return; }
      // BEFORE the running-agent interrupt: narrow, the drawer is a modal
      // sheet over the content and Escape must close THAT first. It used to
      // fall through to the /stop branch, so with an agent working, Escape
      // stopped the agent and left the panel stuck open.
      if (isNarrow() && showRight()) { closeRight(); return; }
      const s = sel();
      // `live`, not `status` — an agent parked in wait_children reads
      // "idle", and Escape then did nothing at all on a working agent.
      if (s && isSelLive()) {
        // Claude-Code-style: Esc interrupts the running agent
        api(`/api/agents/${s.id}/stop`, { method: "POST" }).then(refreshAgents);
        return;
      }
      return;
    }
    // a single-key shortcut must not fire while ANY overlay is up.
    //
    // This guard named only `showNew() || showCfg()`, but the Escape branch just
    // above handles four overlays plus the narrow drawer — so the two lists could
    // drift, and they had: with the themes panel open, `t` opened the terminal and
    // `/` stole focus into the composer behind it. The app mutated state under a
    // visible overlay.
    //
    // So both read from ONE list. Adding a modal now means adding it once, and
    // forgetting cannot silently reintroduce the bug.
    if (anyOverlayOpen()) return;
    if (e.key === "/") {
      e.preventDefault();
      document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
    } else if (e.key === "d") {
      toggleRight();
    } else if (e.key === "t") {
      toggleTerm();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // follow the visible sidebar tree order (parents, then expanded subs)
      const list = treeRows().map((r) => r.a);
      if (list.length === 0) return;
      e.preventDefault();
      const idx = list.findIndex((a) => a.id === selected());
      const next = e.key === "ArrowDown" ? Math.min(idx + 1, list.length - 1) : Math.max(idx - 1, 0);
      if (next !== idx) select(list[next].id);
    }
  });

  /* ---------- human terminal (bottom drawer: resizable, tabs, split) ---------- */
  const [termOpen, setTermOpen] = createSignal(localStorage.getItem("teapot.term") === "1");
  const toggleTerm = () => {
    const next = !termOpen();
    setTermOpen(next);
    localStorage.setItem("teapot.term", next ? "1" : "0");
  };

  /**
   * A terminal tab. `key` IS the server's terminal id (#term-shared).
   *
   * It used to be a client-local `agent#N` counter because the tab was the only thing that knew
   * a shell existed. The server owns them now, so the id comes from `/api/terminals` and a
   * reload re-attaches to the same shells instead of losing them.
   */
  type TermTab = { key: string; agentId: string; title: string };
  type TermSession = {
    el: HTMLDivElement;
    term: any;
    fit: any;
    ws: WebSocket;
    ro: ResizeObserver | null;
  };
  const [termTabs, setTermTabs] = createSignal<TermTab[]>([]);
  // each pane holds an index into termTabs (-1 = empty slot)
  const [paneL, setPaneL] = createSignal(0);
  const [paneR, setPaneR] = createSignal(-1);
  const [splitView, setSplitView] = createSignal(false);
  const [focusedPane, setFocusedPane] = createSignal(0);
  const [termHeight, setTermHeight] = createSignal(
    Number(localStorage.getItem("teapot.termH")) ||
      Math.max(220, Math.round(window.innerHeight * 0.35)),
  );
  const liveTerms = new Map<string, TermSession>();
  // monotonic tab-id source — see addTab() for why keys must never be reused
  let termSeq = 0;
  const paneHosts: (HTMLDivElement | null)[] = [null, null];

  /** the tab currently shown in the focused pane */
  const activeTab = () =>
    termTabs()[focusedPane() === 0 ? paneL() : paneR()] ?? null;

  function focusTab(i: number) {
    const tab = termTabs()[i];
    if (!tab) return;
    const focused = focusedPane();
    // snapshot BEFORE any setter runs — the setters below are plain signals,
    // so reading through the accessor after a partial update gave the swap
    // logic stale values and the click landed on the wrong pane (v0.19.6
    // "tab switching doesn't work" regression)
    const mineIdx = focused === 0 ? paneL() : paneR();
    const otherIdx = focused === 0 ? paneR() : paneL();
    const setMine = (v: number) => (focused === 0 ? setPaneL(v) : setPaneR(v));
    const setOther = (v: number) => (focused === 0 ? setPaneR(v) : setPaneL(v));
    if (otherIdx === i) {
      // it's in the other pane — swap so both stay visible
      setOther(mineIdx);
      setMine(i);
      return;
    }
    if (mineIdx !== i) setMine(i);
  }

  const addFromSelected = () => addTab();

  /**
   * Create a terminal ON THE SERVER, then show it.
   *
   * The shell is created by a POST, not by opening the WebSocket, because the tab list has to
   * be server state: a reload asks for the list and re-attaches, and a second window sees the
   * same shells. Opening a socket would give the reload a NEW shell every time, which is the
   * bug this replaces ("タブをリロードしたらターミナル消失").
   */
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
      // the index comes from the list BEFORE the append: a Solid setter applies synchronously,
      // so `termTabs().length` read afterwards is one past the end
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
    // closing is explicit and must END the shell, not just detach it: the whole point of
    // detaching on disconnect is that a reload keeps it, so ✕ is the only thing that stops it
    void api(`/api/terminals/${encodeURIComponent(tab.key)}`, { method: "DELETE" }).catch(() => {});
    const s = liveTerms.get(tab.key);
    if (s) {
      s.ro?.disconnect();
      try { s.ws.close(); } catch { /* gone */ }
      s.term.dispose();
      liveTerms.delete(tab.key);
    }
    const rest = termTabs().filter((_, j) => j !== i);
    setTermTabs(rest);
    // closing the tab a pane SHOWS must land on a real neighbour; the old
    // `Math.min(shift(p), rest.length - 1)` produced -1 for the shown tab (its own
    // shifted index), leaving the pane on "no shell here" until a tab was clicked
    setPaneL((p) => paneIndexAfterClose(p, i, rest.length));
    // the same rule for the split pane — the old expression left it invalid (and
    // referenced a `shift` that no longer existed) whenever it showed the closed tab
    setPaneR((p) => (p === -1 ? -1 : paneIndexAfterClose(p, i, rest.length)));
  }

  // (retintTerminal lives in ./terminal-theme — #137: it now compares the
  // cursor fields too, so a light-theme caret cannot stay dark-theme-stale)

  // re-theme terminals ALREADY OPEN when the theme changes. The reuse path
  // only helps once a terminal is remounted, and an open one never is — so without
  // this the user changes theme and sees nothing happen at all.
  createEffect(() => {
    // read the signals that resolve the active theme; the sibling effect writes
    // `data-theme` on <html>, which repaints every CSS-driven surface
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
      try { s.ws.close(); } catch { /* gone */ }
      s.term.dispose();
    }
    liveTerms.clear();
  }

  /** create (and mount) a session lazily; moving panes just re-appends its el */
  function ensureSession(tab: TermTab, host: HTMLElement): TermSession {
    let s = liveTerms.get(tab.key);
    // a terminal created under a DARK theme kept its palette after the
    // operator switched to a light one, so `--term-fg` became near-black while the
    // shell prompt stayed the dark theme's light grey — invisible on white.
    //
    // xterm CACHES the palette passed to its constructor, so the CSS variables
    // updating is not enough. Re-apply it on every reuse: this is the path taken
    // when the panel is closed and reopened, and on any re-render landing here.
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
      // ATTACH to the server-side terminal this tab represents, by its id. Without
      // `?terminal=`, the server would create a fresh shell and this tab would be looking at a
      // different process than the one the list says it is (#term-shared).
      const w = new WebSocket(
        `${proto}${location.host}/api/agents/${encodeURIComponent(tab.agentId)}/term?terminal=${encodeURIComponent(tab.key)}${wsTokenQuery()}`,
      );
      w.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.kind === "data") t.write(msg.data);
        else if (msg.kind === "exit") {
          t.write(`\r\n\x1b[2m[terminal exited ${msg.code ?? ""}]\x1b[0m\r\n`);
          // the shell is gone on the server too, so drop the tab rather than leaving a dead
          // one that re-attaches forever
          setTermTabs((list) => list.filter((x) => x.key !== tab.key));
          liveTerms.get(tab.key)?.term.dispose();
          liveTerms.delete(tab.key);
        } else if (msg.kind === "attach" && msg.error) {
          t.write(`\r\n\x1b[2m[${msg.error}]\x1b[0m\r\n`);
        }
      };
      t.onData((d: string) => {
        if (w.readyState === WebSocket.OPEN) w.send(JSON.stringify({ kind: "input", data: d }));
      });
      let last = { cols: 0, rows: 0 };
      let pendingRetry: ReturnType<typeof setInterval> | undefined;
      const resizeTimer: ReturnType<typeof setTimeout>[] = [];
      const pushResize = () => {
        try { f.fit(); } catch { /* hidden */ }
        if (w.readyState !== WebSocket.OPEN) {
          /**
           * Do NOT record `last` here, and do NOT give up.
           *
           * The initial `setTimeout(pushResize, 60)` routinely fires while the socket is still
           * CONNECTING. The old code simply returned — so the FIRST size was never sent, the pty
           * stayed at `script`'s 0x0 default, and a shell reported "0 0" until the operator
           * happened to drag the window. That is the reported "リサイズしても中身に伝わらない".
           *
           * Leaving `last` alone means the next call still sees a difference and retries; `open`
           * below also calls it, so the size lands as soon as the socket can carry it.
           */
          scheduleRetry();
          return;
        }
        if (t.cols !== last.cols || t.rows !== last.rows) {
          last = { cols: t.cols, rows: t.rows };
          w.send(JSON.stringify({ kind: "resize", cols: t.cols, rows: t.rows }));
        }
      };
      /**
       * A resize that could not be sent must be retried, not forgotten.
       *
       * socket is not OPEN) made `pushResize` return early — correct, since `w.send` would throw
       * — but the only things that call it again are the ResizeObserver and `open`. If the box
       * does not change again, the size the operator dragged to is simply lost, and the pty keeps
       * whatever geometry reached it last. That is the "half worked" shape: one resize landed,
       * the next did not.
       *
       * A short interval retries while a send is outstanding, and stops as soon as it lands.
       */
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
      // the socket may not have been open for the initial pushResize — send the size now
      w.addEventListener("open", () => pushResize());
      /**
       * Observe the element `fit()` MEASURES, not the one we created.
       *
       * `FitAddon.proposeDimensions()` reads `window.getComputedStyle(this._terminal.element
       * .parentElement)` — so the height and width that decide cols/rows come from the PARENT,
       * which here is `.termhost`. This used to observe `el` (`.termsession`), a child. While
       * those two resize together that is harmless, but they can diverge: `el` is
       * `position: absolute; inset: 0`, so it tracks its own containing block, and a full-screen
       * program (nano) repainting through xterm can leave `el` unchanged while the box that
       * `fit()` measures changed. The observer then never fires, no `resize` is sent, and the
       * pty keeps the old geometry — reported as "nano のリサイズが効かない" with an occasional
       * "中途半端に効く" when some other change happened to trigger a fit.
       */
      const measureEl = el.parentElement ?? el;
      const ro = new ResizeObserver(() => {
        if (resizeTimer[0]) clearTimeout(resizeTimer[0]);
        resizeTimer[0] = setTimeout(pushResize, 250);
      });
      ro.observe(measureEl);
      if (measureEl !== el) ro.observe(el); // both, since either can move first
      setTimeout(pushResize, 60);
      s = { el, term: t, fit: f, ws: w, ro };
      liveTerms.set(tab.key, s);
    } else if (s.el.parentElement !== host) {
      host.appendChild(s.el); // moved between panes — xterm DOM survives the move
      setTimeout(() => { try { s!.fit(); } catch { /* */ } }, 30);
    }
    return s;
  }

  function mountPane(idx: number) {
    const host = paneHosts[idx];
    if (!host) return;
    const tab = termTabs()[idx === 0 ? paneL() : paneR()];
    if (!tab) {
      // only clear when this pane actually owns a session — replaceChildren()
      // on every mount pass used to detach a session element the OTHER pass
      // had just re-attached, which is how tabs went blank
      const owned = [...liveTerms.values()].some((t) => t.el.parentElement === host);
      if (owned) host.replaceChildren();
      return;
    }
    const s = ensureSession(tab, host);
    // Each session element must live in EXACTLY one pane. Session elements
    // are absolutely positioned, so a previous tab's terminal stayed stacked
    // underneath and showed through a freshly opened (empty) shell — the
    // "switching tabs kept showing the old tab's content" bug.
    for (const [key, other] of liveTerms) {
      if (key !== tab.key && other.el.parentElement === host) other.el.remove();
    }
    // make sure the terminal element really lives in THIS pane right now —
    // switching tabs moved DOM nodes behind Solid's back, so verify instead
    // of assuming; then refit so xterm re-measures into the (new) box
    requestAnimationFrame(() => {
      if (s.el.parentElement !== host) host.appendChild(s.el);
      try { s.fit(); } catch { /* hidden */ }
      if (focusedPane() === (idx === 0 ? 0 : 1)) {
        try { s.term.focus(); } catch { /* hidden */ }
      }
    });
  }

  // (re)mount both panes whenever any layout input changes — tabs, pane
  // assignment, split mode, drawer height. This effect was accidentally lost
  // in an earlier refactor, so after reopening the drawer (or switching
  // tabs) nothing re-attached live sessions and the pane stayed "no shell".
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

  // opening the drawer ensures a shell for the selected agent.
  //
  // This tracks the SELECTED AGENT only. It used to read termTabs() as well,
  // so every tab change re-ran the body and focusTab() yanked the pane off
  // whatever the operator was looking at — opening a shell for agent A while
  // watching agent B swapped B's terminal away.
  let _termFollowAgent: string | null = null;
  createEffect(() => {
    if (!termOpen()) return;
    const id = selected();
    if (!id) return;
    if (id === _termFollowAgent) return;
    _termFollowAgent = id;
    /**
     * Do NOT spawn a shell on an agent switch.
     *
     * This used to call `addTab(id)` whenever the newly selected agent had no tab, which meant
     * every click through the sidebar started a shell on the server: "勝手に新しいタブを作る".
     * With the terminals now server-owned the tab list is shared and survives a reload, so
     * merely looking at another agent was accumulating shells nobody asked for — and each one
     * held a pty.
     *
     * A shell is created when the operator asks for one (＋, or a keybinding), never as a side
     * effect of selecting an agent. If the selected agent HAS a tab, focus it — that part is
     * what makes the panel feel attached to the selection.
     */
    const mine = termTabs()
      .map((t, i) => ({ t, i }))
      .filter((x) => x.t.agentId === id);
    if (mine.length) {
      // its tab exists — focus the LAST one for it, so returning to an agent lands on the shell
      // you most recently opened rather than its first
      focusTab(mine[mine.length - 1]!.i);
    }
  });

  /**
   * Keep both pane indices pointing at a real tab.
   *
   * The panes render "no shell here" when their index is out of range, so ANY change that
   * shortens the list behind their back leaves a visible tab with an empty pane beneath it —
   *
   *   - another client closes a terminal (the list is server-owned now, so a remote ✕ removes a
   *     row here with no local `closeTab`)
   *   - the reload restore replaces the whole list with the server's
   *   - the server drops a terminal whose shell exited (`kind: "exit"` filters the list)
   *
   * This runs as an effect rather than at each site, because every one of those paths lands in
   * the same signal — and the next such path will too.
   */
  createEffect(() => {
    const n = termTabs().length;
    // one rule, shared with the close path: `clampPaneIndex` in term-tabs.ts
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
      // seed the second pane with a DIFFERENT tab than the left pane shows —
      // the old findIndex picked index 0 whenever paneL() wasn't 0 (or -1
      // when it was), so split often opened with BOTH panes on one shell or
      // an empty right side despite other tabs existing
      if (paneR() < 0 || paneR() === paneL() || paneR() >= termTabs().length) {
        setPaneR(rightPaneSeed(paneL(), termTabs().length));
      }
    }
    requestAnimationFrame(() => { mountPane(0); if (splitView()) mountPane(1); });
  };

  onCleanup(disposeAllTerms);

  // legacy single-host refs kept for pane mounting
  const setPaneHost = (idx: number) => (el: HTMLDivElement) => {
    paneHosts[idx] = el;
    // The drawer is conditionally mounted (<Show when={termOpen()}>). On
    // reopen the refs arrive fresh, but nothing re-ran mountPane — so live
    // sessions stayed detached and the pane showed "no shell here". Mount
    // right here; also refit after the drawer finishes animating in.
    if (el) requestAnimationFrame(() => {
      mountPane(idx);
      if (splitView()) mountPane(1);
      setTimeout(() => mountPane(idx), 200);
    });
  };

  onMount(() => {
    loadCfg();
    refreshAgents().then(async () => {
      // deep link: /session/<internalId> routes to its owning agent —
      // fall back to a raw agent id (old bookmarks) → last session → first
      await refreshSessionIndex();
      const want = pathId();
      const owner = want ? masterSessionIndex().get(want) : undefined;
      const initial =
        (owner ? agents().find((a) => a.id === owner) : undefined) ??
        agents().find((a) => a.id === want && !masterSessionIndex().has(want)) ??
        agents().find((a) => a.id === localStorage.getItem("teapot.session")) ??
        agents()[0];
      // pass the deep-linked session through. `select(initial.id)` alone
      // discarded it, so /session/<old-id> opened the bound session and then
      // rewrote the URL to match — the bookmark quietly pointed somewhere else.
      if (initial) select(initial.id, false, want || null);
    });
    refreshMetrics();
    loadTasks();
    loadPersonas();
    connectWs();
    /**
     * Restore the terminal tabs from the SERVER.
     *
     * A reload used to lose them, because the list only existed in this tab. The shells kept
     * running on the server (a detach, not a kill), so this re-attaches to exactly the ones
     * that are still alive — including ones another window opened, which is the point of
     * sharing the list.
     */
    void api("/api/terminals")
      .then((r: { terminals?: { id: string; agentId: string; title: string }[] }) => {
        const list = r.terminals ?? [];
        if (!list.length) return;
        setTermTabs(list.map((t) => ({ key: t.id, agentId: t.agentId, title: t.title })));
        // show the first one rather than an empty pane with tabs above it
        if (termOpen()) {
          setPaneL(0);
          setPaneR(-1);
        }
      })
      .catch(() => {
        /* an older server without /api/terminals: keep working with local tabs */
      });
    /**
     * No polling timer here any more.
     *
     * `metrics` and `tasks` arrive on the socket (`kind: "metrics"` / `kind: "tasks"`), because the
     * server already ticks every 15s and a GET whose answer the server holds is exactly what a push
     * socket replaces. A 30s interval per tab meant every open window asked the same two questions
     * forever, and it could not tell that the answer had not changed.
     *
     * HTTP stays as the RECOVERY path — a tab waking after a long sleep re-reads on visibilitychange
     * (see the refresh below), which is when a REST read is genuinely needed.
     */
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

  // @mentions: personas spawn sub-agents, agent ids target existing ones
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
  // popup shows while typing the first token of a command
  // oxlint-disable-next-line no-unused-vars
  const filteredCmds = () => {
    const d = draft();
    if (!d.startsWith("/") || d.includes(" ") || d.includes("\n")) return [];
    return SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(d.slice(1).toLowerCase()));
  };

  // unified suggestions: slash commands, then /skill argument completion
  // (skill names come from the selected agent's roots via /api/agents/:id/skills)
  type Suggest = { insert: string; title: string };
  const NO_ARG_COMMANDS = new Set(["start", "stop", "fork", "compact"]);
  const [agentSkills, setAgentSkills] = createSignal<{ name: string; description: string }[]>([]);
  /**
   * Optional native tools this host has (image resize, pty).
   *
   * Fetched on demand rather than at boot: it is only read in the settings panel, and it runs
   * binaries on the server to answer.
   */
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
    // NOTE: the arg is capture group TWO — group numbering was misread as [3]
    // before, so argPart was ALWAYS empty. Every "/goal <text>" then looked
    // like a bare command: the completion popup stayed open and Enter (with
    // cmdIdx set) replaced the draft with "/goal ", silently eating the text.
    const argPart = (m[2] ?? "").trim();
    if (!argPart && cmdName !== "skill") {
      const rows = SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(cmdName));
      // an exact, argument-less command must EXECUTE on Enter — don't keep a
      // popup open that would swallow the keystroke as another selection
      const exact = rows.find((c) => c.cmd.slice(1) === cmdName);
      if (exact && NO_ARG_COMMANDS.has(cmdName)) return [];
      return rows.map((c) => ({ insert: c.cmd + " ", title: c.desc }));
    }
    if (cmdName === "skill") {
      let rows = agentSkills().filter((s) => s.name.toLowerCase().startsWith(argPart.toLowerCase()));
      // a single exact match means the name is complete — stop suggesting so
      // the following Enter dispatches /skill instead of re-selecting
      if (rows.length === 1 && rows[0]!.name.toLowerCase() === argPart.toLowerCase()) return [];
      return rows.map((s) => ({ insert: `/skill ${s.name} `, title: s.description || "(bundled skill)" }));
    }
    return [];
  };
  // oxlint-disable-next-line no-unassigned-vars
  let composerEl: HTMLTextAreaElement | undefined;
  /** the off-layout mirror `measureComposerContent` reuses, and its inert host */
  let composerMirror: HTMLDivElement | undefined;
  let composerMirrorHost: HTMLDivElement | undefined;
  /** the one `<style>` that makes the mirror render its attribute text */
  let composerMirrorStyleAdded = false;
  /**
   * The height this textarea's CONTENT needs, without touching the textarea.
   *
   * A fixed-height textarea reports `max(height, content)`, so its content height cannot be read in
   * place; the usual workaround (set `height: auto`, read, restore) lays the box out at ONE LINE for
   * an instant. The composer is a flex sibling of the feed, so that instant changes the feed's
   * viewport and the follow policy re-pins against the one-line floor — the reported scroll-back,
   * which fired on every keystroke whose height did not change.
   *
   * A mirror div is laid out with the same font, padding and width, so its `scrollHeight` is what
   * the content would take while the real box keeps its height. MEASURED against the textarea's own
   * `scrollHeight` at 1/2/3 lines and with a long single line: 37/54/70/54 — identical.
   *
   * It lives in its OWN `aria-hidden` container on `<body>`: a detached element reports 0, but
   * putting it beside the composer made the typed text visible to queries over the chat tree.
   */
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
    /**
     * The text goes in an ATTRIBUTE, rendered by `::after { content: attr(…) }`.
     *
     * Two constraints meet here. The mirror must be in the document (MEASURED: detached reports
     * `scrollHeight: 0`), and it must carry the typed text so the wrap height is right — but a text
     * NODE anywhere in `<body>` is part of `body.textContent`, so a harness (and any "how many times
     * does this string appear" check) saw the operator's draft twice. MEASURED: putting the text in
     * `textContent` dropped the smoke suite from 55 passing checks to 10 with "PENDING ECHO
     * DUPLICATED".
     *
     * `attr()` rendering keeps the glyphs in the layout while leaving them out of `textContent` —
     * verified: same 70px height for a 3-line value, with `textContent` not containing it.
     */
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
  /**
   * Size the composer to its content, and keep the reader pinned to the tail when THAT
   * resize is what moved the bottom of the feed.
   *
   * ## Why this is not allowed to touch layout on every keystroke
   *
   * Reported: the tab used a full CPU core and 2 GB. `tailSample()` reads
   * `feed.scrollHeight`, and with ~1,100 rows (many carrying `content-visibility: auto`)
   * that is a FORCED LAYOUT of the entire feed. This function runs from the draft effect —
   * i.e. on EVERY keystroke — and v0.29.38 made it sample TWICE (before and after) and
   * added `void composerEl.clientHeight` to force the reflow in between. So one character
   * cost three synchronous layouts of a 1,100-row document, indefinitely.
   *
   * The reflow is only needed when the composer's height actually CHANGES, which happens
   * on far fewer keystrokes than there are characters (only when a line wraps or unwraps).
   * So: measure the textarea, and bail out early — with no `tailSample()` at all — when the
   * height is unchanged. That keeps the scroll-follow behaviour exactly as it was, because
   * an unchanged composer height cannot have moved the feed's viewport.
   */
  /**
   * The content height this function last applied.
   *
   * `scrollHeight` cannot tell us whether the box needs re-measuring: once the box is sized to
   * its content they are equal, so any comparison of the two is always "fits" (MEASURED: the
   * first attempt at this guard used `contentHeight <= current + 1`, which is true at 1, 2 and
   * 3 lines alike, so the collapse stayed unconditional and the 3-line bug came back at 2
   * lines). What actually matters is whether the CONTENT SHRANK since the last measurement —
   * only then can the box be taller than its content.
   */
  let lastAppliedContentH = 0;
  const autosizeComposer = () => {
    if (!composerEl) return;
    const maximized = composerMaximized();
    /**
     * An EMPTY box is always exactly one line — never `scrollHeight`.
     *
     * Reported: shrink the window (the placeholder now wraps), type something, delete it, and
     * the placeholder is left WRAPPED because the box grew to fit it. `scrollHeight` of an empty
     * textarea includes the wrapped placeholder in Chromium, so the measurement the box height
     * comes from would depend on how the PLACEHOLDER happens to wrap — which changes with the
     * window width and has nothing to do with the message being written.
     *
     * A textarea's own `height: auto` is `rows` × line-height, independent of both content and
     * placeholder, so clearing the height is the exact, stable answer for an empty box. This is
     * also the state the composer starts in, so before-typing and after-deleting now match.
     */
    if (!composerEl.value && !maximized) {
      composerEl.style.height = "";
      lastAppliedContentH = 0;
      return;
    }
    /**
     * Measure through the MIRROR, so the real box is never collapsed.
     *
     * The old code wrote `height: auto` here to learn the content height, which laid the composer
     * out at ONE LINE for an instant. The composer is a flex sibling of the feed, so the feed's
     * viewport changed with it and the follow policy re-pinned against the one-line floor: the
     * reported "入力欄が1行のときの上端まで戻る". It fired on every keystroke whose height did not
     * change, which is why a newline — a case where the final height really does change, so the pin
     * lands correctly — was the one that looked fine.
     */
    const contentH = measureComposerContent(composerEl);
    const wanted = maximized ? -1 : composerHeight(contentH, MAX_COMPOSER_H);
    // apply it unconditionally: an early return must NOT leave the box at a stale height.
    composerEl.style.height = wanted === -1 ? "" : `${wanted}px`;
    lastAppliedContentH = contentH;
    // NOTE (#scroll): this function does NOT touch the feed's scroll position.
    //
    // The feed is a flex sibling, so growing this box shrinks the feed's viewport. That is a
    // change to `.feed`'s own BORDER BOX, and the ResizeObserver on the feed sees it — before
    // paint, with the final layout, and for every other cause too (the terminal drawer, the
    // right panel, a window resize). Pinning from HERE was the bug: this runs in the same task
    // as the `height` write, so `pinToTail()` resolved `scrollHeight` against a layout that did
    // not yet include the new composer height, and the reader was pinned to the tail as it was
    // when the box still had its OLD height.
  };
  /** the previous scroll sample, for telling a deliberate scroll from a reflow/clamp */
  let lastSample: TailSample | undefined;
  /**
   * The observed-top LEDGER: where our last programmatic write put `scrollTop`, and the content
   * height at that moment. `classifyScroll()` uses it to recognise its own writes and browser
   * clamps, which is the difference between "the reader scrolled up" and "the layout moved".
   * Cleared after one delivery — a programmatic write yields exactly one scroll event.
   */
  let ledger: { top: number; height: number } | null = null;
  /** content height at the previous delivery, so a height change can be attributed to layout */
  let lastSampleHeight: number | undefined;
  /**
   * The row the reader is looking at, refreshed whenever they settle.
   *
   * Gecko unskips a `content-visibility` row as it approaches the viewport and does not hold
   * the scroll position across it, so the anchor must be captured BEFORE the unskip and
   * re-applied after. Captured on every scroll delivery while not following: cheap (one row,
   * found by the same binary search a resize already uses) and always current.
   */
  /**
   * How many unskip corrections may run before the next reader gesture.
   *
   * A correction writes `scrollTop`, and a large unskip can produce a burst of deliveries —
   * each of which looks like another `layout` cause. Without a budget the two can chase each
   * other and the feed never settles. It refills on any delivery the READER caused, which is the
   * only signal that they are driving again.
   */
  /**
   * Starts NON-ZERO: a pinned tail has no reader gesture to refill it.
   *
   * It used to start at 0 and refill only on a `reader` delivery. That is the right loop for a
   * parked reader, but while FOLLOWING there is no gesture by definition — so the content-
   * visibility correction could never run there, which is exactly the "スクロールのブレが直って
   * ない" that survived v0.35.10. The budget is a loop-breaker, not a permission slip: it only
   * has to stop runaway chased corrections, and 4 is enough for a burst either way.
   */
  const RESYNC_BUDGET_PER_GESTURE = 4;
  /**
   * The largest shift a `content-visibility` unskip can plausibly need correcting for, in pixels.
   *
   * An unskip swaps one row's intrinsic-size GUESS for its real height, so the correction is on the
   * scale of a single row — a few hundred pixels at the very worst for a large tool result. A larger
   * delta means the anchor no longer describes the content (it was captured before a burst of
   * appends, and the throttle let it go stale), and applying it would fling the reader somewhere
   * unrelated: "原因不明でスクロール追従が外れて500pxくらい戻る".
   *
   * 240 is deliberately generous — it is above any single row in a normal session, so a real
   * unskip is never skipped, while the reported 500px class of error is refused.
   */
  const RESYNC_MAX_DELTA_PX = 240;
  let resyncBudget = RESYNC_BUDGET_PER_GESTURE;
  /** the viewport height at the previous delivery, so a composer resize is attributable */
  let lastSampleViewport: number | undefined;
  createEffect(() => {
    const v = draft(); // re-run on typing AND after send() clears the draft
    // #the RESIZE must happen AFTER the DOM text is synced, not before. This
    // effect used to run first and call autosizeComposer() straight away, which
    // box at its full multi-line height with nothing in it. `send()` clears the
    // signal, so the order is: write the value, then measure.
    if (!composerEl) return;
    if (!shouldWriteComposerValue(imeInProgress)) return;
    if (composerValueChanged(composerEl.value, v)) composerEl.value = v;
    autosizeComposer();
  });
  /**
   * A WINDOW resize re-wraps the text, so the composer must re-measure.
   *
   * The effect above only re-runs when the DRAFT changes, so widening the window left the box at
   * the height the NARROW layout needed: the text re-wrapped to fewer lines but nothing measured
   * again, and the extra rows stayed as empty space. Reported as "ウィンドウをせまくしてから元に戻した
   * 時に、横幅がせまくなったことで行数が増えたプロンプト欄が戻らない".
   *
   * The draft is untouched here, so this is the only thing that can notice. Coalesced into one
   * frame because a drag fires `resize` continuously and each pass reads `getComputedStyle` plus
   * forces a layout on the mirror.
   */
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

  /** post a raw prompt (used by composer AND question-option taps) */
  // image attachments staged for the next prompt (data URLs; capped count)
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
  /**
   * `source` says WHO is speaking.
   *
   * A slash command that injects harness text (`/skill` sends `[harness] Force-load and follow …`)
   * arrived on the timeline as a message "from you", because the route hardcoded "user". The client
   * is the only side that knows an instruction came from the harness rather than the operator.
   */
  const sendText = async (text: string, targetId?: string, source?: "harness") => {
    const id = targetId ?? selected();
    if (!id) return;
    const images = pendingImages();
    // the echo is filed under the SESSION OF THE AGENT BEING PROMPTED, which is the same handle
    // `pendingKey()` uses (an internal session id, not an agent id). Sending does not require
    // looking at that session — a harness prompt targets an agent that is not selected — and
    // keying by the visible timeline put the echo under whatever was on screen, so an unrelated
    // session showed "⏳ 1 message queued" and drew someone else's message in its feed.
    const echoKey = agents().find((a) => a.id === id)?.session || id;
    try {
      const r = await api(`/api/agents/${id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, start: true, ...(source ? { source } : {}), ...(images.length ? { images } : {}) }),
      });
      // optimistic echo — replaced by the logged event once the feed catches up.
      // promptId links it to the later prompt-delivered note (real LLM payload).
      //
      // Keyed by the AGENT WE SENT TO, not by the timeline on screen. Sending does not require
      // looking at the session — a harness prompt is fired at an agent that is not selected — and
      // the old key put that echo under the VISIBLE session, so an unrelated session showed
      // "⏳ 1 message queued" with someone else's message drawn in its timeline.
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
      // a send exits the maximized composer. It is `position:absolute;
      // inset:0` over the whole column, so leaving it maximized leaves the timeline
      // hidden — and since #134 stopped Enter sending, this is the only way out.
      // Autosize on the next frame: the tall height comes from `.maximized`, so
      // dropping the class alone would leave the textarea expanded.
      if (shouldRestoreAfterSend(composerMaximized())) setComposerMaximized(false);
      // NO explicit scroll here (#scroll).
      //
      // This used to be `requestAnimationFrame(() => requestAnimationFrame(() =>
      // scrollBottom(true)))` — a FORCED jump two frames later, which is the reported
      // "メッセージ送信直後に謎にスクロールする". Two things were wrong with it:
      //
      //   - `force = true` ignored whether the reader was following, so sending while
      //     reading back through history yanked them to the bottom;
      //   - it was a guess at when layout had settled. Sending clears the draft, the
      //     composer SHRINKS, the feed GROWS, and the optimistic echo adds a row — the
      //     scroll target was computed against whichever of those had landed by then.
      //
      // None of it is needed now: every one of those changes resizes `.feed`, and the
      // ResizeObserver on it re-pins iff the reader is following. `autosizeComposer` below
      // is still required to re-measure the (now empty) box.
      /**
       * Shrink the composer BEFORE the frame, not in one.
       *
       * draft effect had already written the empty value, so the box sat one frame at its
       * OLD multi-line height while the feed's ResizeObserver ran. The observer re-pinned
       * the tail against THAT layout, and only then did the composer collapse — which grew
       * the feed by however many lines the composer had been using, leaving the timeline
       * scrolled as if the box were still tall. That is the reported "入力欄が複数行に拡大して
       * いるときに送ると、拡大していない高さをベースにスクロールが戻る".
       *
       * Doing it synchronously makes the composer's final height part of the SAME layout the
       * observer then measures, so there is no stale intermediate state to pin against.
       */
      autosizeComposer();
      /**
       * …and PIN, right here, if the reader was following.
       *
       * NEW ROW, which grows content AFTER this turn. That does not resize `.feed` — the feed's
       * border box is unchanged when content inside it grows — so the ResizeObserver never
       * fires, and follow was one interaction behind: the view caught up only when something
       * else happened to change the box. Reported as "送信したときに追従が維持されることを
       * 期待するけど、追従されてなさそう / ちょっと遅れて追従してる".
       *
       * `atBottom()` is a STATE here, not a measurement: only a real reader scroll clears it,
       * so a follower reads true and a reader parked in history reads false.
       */
      if (atBottom()) {
        requestAnimationFrame(() => {
          // after the echo has been painted, so the pin target includes its height
          if (atBottom()) pinToTail();
        });
      }
    } catch (ex) {
      saveDraft(text); // never eat the user's message on a failed send
      console.error("send failed:", ex);
    }
  };

  const send = async (e: Event) => {
    e.preventDefault();
    const id = selected();
    const text = draft().trim();
    if (!id || !text) return;

    // @mentions: persona → spawn sub-agent; agent id → direct message
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

    // slash commands are client-side operations
    if (text.startsWith("/")) {
      const sp = text.indexOf(" ");
      const name = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
      const arg = sp === -1 ? "" : text.slice(sp + 1).trim();
      if (name === "goal" && !arg) { saveDraft("/goal "); return; } // keep typing
      if (name === "skill" && !arg) { saveDraft("/skill "); return; }
      saveDraft("");
      try {
        await executeSlash(name, arg);
      } catch (ex) {
        // a failed command must not eat the operator's input — sendText
        // already restores its draft on failure; commands now do too
        saveDraft(draft() ? `${text}\n${draft()}` : text);
        throw ex;
      }
      return;
    }

    saveDraft("");
    await sendText(text);
    // this USED to restore the normal view on send. The rationale was that
    // "staying maximized hid the timeline for no reason" — but that reason only
    // applies if you cannot see the reply. With Enter no longer sending (above),
    // a maximized composer is a deliberate writing mode you use for a whole
    // message, and collapsing it mid-message discarded the mode you asked for.
    //
    // The button beside the toggle is still there to restore it.
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

  // The right panel's scroll position used to reset whenever a control button
  // (▶ start / ■ stop / goal save…) refreshed the agents: content inside was
  // rebuilt and the browser clamped scrollTop. Keep the offset and restore it
  // on every repaint triggered by an agents update.
  let rightbarEl: HTMLDivElement | undefined;
  let rightbarTop = 0;
  createEffect(() => {
    agents(); // re-arm on every agents update (incl. start/stop refreshes)
    // double rAF: the first frame applies Solid's DOM writes, the second
    // measures/restores AFTER layout settles — restoring too early let the
    // browser clamp scrollTop to the OLD height and the panel visibly jumped
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

  /**
   * Archive this agent and its subtree.
   *
   * Lifted out of the right panel's `⏯ controls` block so the HEADER can own it (#panel):
   * those controls were only reachable with the details panel open, so pausing or archiving
   * the agent you were reading required opening a second surface first.
   */
  const archiveSelected = async () => {
    const id = selected();
    if (!id) return;
    // The whole SUBTREE goes too: a sub-agent cannot run once its parent is archived (the
    // parent is what spawns and messages it), so leaving the descendants in the list produced
    // entries that looked usable and were not.
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
    // the agent is gone, so its session is too — drop the cached index or the UI keeps
    // routing to a session that no longer exists
    void refreshSessionIndex(true);
    // Switch to a USABLE neighbour. `rest[0]` was picked blindly, and the first remaining row
    // can be a 👻 ghost (workspace gone) — landing the operator on a dead session right after
    // they tidied up is the opposite of what archiving is for.
    const next = pickAfterArchive(agents(), doomed);
    if (next) select(next.id);
    else {
      setSelected(null);
      setEvents([]);
    }
  };

  /** stop every sub-agent this agent spawned (descendants included) */
  const stopChildren = async () => {
    if (!selected()) return;
    const r = await api(`/api/agents/${selected()}/stop-children`, { method: "POST" });
    flashHint(`stopped: ${((r as any).stopped ?? []).join(", ") || "(none)"}`);
    refreshAgents();
  };

  /** fork: branch off the conversation here without disturbing the main line */
  const forkSelected = () =>
    api(`/api/agents/${sel()!.id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then(async () => {
      await refreshSessionIndex(true);
      await select(sel()!.id);
    });

  // Goal input as SIGNALS (not uncontrolled DOM): the right panel re-renders
  // on every agent snapshot, and status flips / <Show> boundary crossings
  // rebuilt the form subtree — silently wiping half-typed goals mid-input.
  const [goalDraft, setGoalDraft] = createSignal("");
  /**
   * The goal box is draggable and remembered — same treatment as the todo editor.
   *
   * に高い": it was a fixed `rows={3}`, so a long goal permanently owned three lines of a narrow
   * panel. `resize: vertical` was already on it, but the drag did not survive a reload.
   */
  const [goalHeight, setGoalHeight] = createSignal(storedTextareaHeight("goal"));
  // the PREVIEW is a separate box with its own remembered height
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
      goalSeededFor = id; // session switch → seed from the server copy
      setGoalDirty(false);
      setGoalDraft("");
      setGoalVerifyDraft("");
      void g; // goal text itself stays in the read-only card above the form
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
          // only send when non-empty — an empty box must not wipe a contract
          ...(goalVerifyDraft().trim() ? { verify: goalVerifyDraft() } : {}),
        }),
      });
      setGoalDraft("");
      setGoalVerifyDraft("");
      setGoalDirty(false);
      refreshAgents();
    } catch (ex) {
      // keep the draft on failure — a wiped form AND an error hint was the
      // worst possible outcome for a long goal text
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
    {/**
     * The wallpaper layer lives OUTSIDE `.layout`, as its own sibling.
     *
     * This is the whole fix for "背景色があるときにUIのほぼすべてが透明になってほぼ何も見えない":
     * the image was INSIDE `.layout`, which is `position: relative; z-index: 1` and therefore a
     * stacking context. Within that context `.bgphoto` had `z-index: 0`, while the sidebar, the
     * feed and the panels are ordinary STATIC elements — so the positioned image painted ON TOP of
     * all of them. What looked like transparency was the photo covering the UI with the text
     * faintly showing through.
     *
     * A backdrop cannot be a child of the thing it sits behind. As a sibling with `z-index: -1` it
     * is behind `.layout`'s own stacking context, and no z-index inside the app can accidentally
     * interact with it.
     */}
    <Show when={activeBgImage()}>
      {(src) => (
        /**
         * TWO elements, because the dim must be painted ABOVE the image.
         *
         * The image cannot dim itself: `filter: brightness()` with a factor below 1 darkens, and
         * above 1 it does NOT brighten — MEASURED, a white pixel at 0.45 renders 115/255 and a
         * black pixel at 1.55 stays 0. So one filter cannot do "dark veil on dark themes, pale
         * veil on light ones", which is what the operator asked for.
         *
         * A `background` on the `<img>` cannot either — a background paints BEHIND an image's own
         * pixels, and an `::after` never renders because an `<img>` is a replaced element. Hence a
         * sibling veil element stacked on top, both inside the fixed wrapper.
         */
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
      {/* A narrow screen gets a drawer for the SIDEBAR too, with the same gestures as the right
          panel: a hamburger to open, a backdrop or ✕ to close. Wide screens never see any of it —
          `narrow()` gates every piece, so the desktop grid is exactly what it was. */}
      <Show when={narrow() && showLeft()}>
        <div class="leftbarbackdrop" onclick={closeLeft} />
      </Show>
      {/* ---------- sidebar ---------- */}
      <nav class={"sidebar" + (showLeft() ? " open" : "")}>
        {/* the ✕ only exists in the drawer form; on desktop the sidebar is always visible */}
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
              {/* workspace header: which project this chat belongs to */}
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
                  {/* several separate chats often share one directory — say so,
                      so the group reads as N chats rather than one.
                      A COLLAPSED group must always show the count: that is
                      the only thing telling the operator how much is hidden. */}
                  <Show when={(wsChatCounts().get(row.wsHeader!) ?? 0) > 1 || row.wsCollapsedGroup}>
                    <span class="wscount">{wsChatCounts().get(row.wsHeader!) ?? 0}</span>
                  </Show>
                </div>
              </Show>
              {/* A collapsed group shows its header and nothing else; a header row
                  never renders its own agent, which would double the chat.
                  The `chat:<id>` header is GONE (#18 follow-up): a directory
                  holding six chats rendered thirteen rows, each chat repeated
                  under a header bearing its own name. The chat row is the
                  group — it carries the caret below — so nothing is lost but
                  the duplication. */}
              {/* A collapsed CHAT still renders its row (dimmed, ▸) — with the
                  chat header gone that row is the only control that can bring
                  it back, so hiding it would strand the chat for good.
                  Collapsing the DIRECTORY still hides every row under it,
                  because the directory header is what reopens that. */}
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
                    ? // #121: the name is what the operator needs; the parent is
                      // already visible in the row above. Fall back to the old
                      // wording when the id carries no recoverable name.
                      (() => {
                        const named = subAgentDisplayName(row.a.id, personas().map((p) => p.key));
                        return named
                          ? `sub-agent of @${row.a.parent} — "${named}"`
                          : `sub-agent of @${row.a.parent}`;
                      })()
                    : undefined
                }
              >
                {/* A TOP-LEVEL CHAT is always collapsible, whether or not it has
                    sub-agents. It is its own group — that is what #18 needed
                    when two chats shared a directory — and with the chat
                    header gone, this caret is the ONLY control for it, so
                    gating it on "has children" would make a childless chat
                    impossible to collapse and, once collapsed (by a stored
                    `chat:<id>` key), impossible to reopen. Only a SUB-agent
                    with no children of its own has nothing to collapse. */}
                {/* #106: a caret that collapses nothing is noise — but NEVER at
                 * the cost of stranding a chat.
                 *
                 * The report is right about the common case: a chat with no
                 * sub-agents, not collapsed, has a caret that does nothing.
                 *
                 * The obvious implementation — gate a top-level chat's caret on
                 * "has children" — is WRONG, and #18 documented why. Collapsing
                 * is what WRITES the `chat:<id>` key, so a childless chat can
                 * never have one from a click... but it can have a STALE one, and
                 * there are two ordinary paths to that:
                 *
                 *   1. upgrade: every chat was collapsed under the old header, so
                 *      every existing install starts with `chat:<id>` keys set;
                 *   2. a chat that HAD sub-agents, collapsed, then the subs
                 *      finished or were disposed.
                 *
                 * In both, `sidebarRowsOf` still renders the row (marked
                 * `chatCollapsedGroup`), so it is visible — but with no caret
                 * there is NO on-screen control to clear the key. The chat is
                 * stuck showing its ▸ forever. That is the strand-a-chat bug, and
                 * I reproduced it before writing this.
                 *
                 * So the gate is "has children OR is currently collapsed", which
                 * makes the caret exactly as visible as it needs to be: absent
                 * only when it would do nothing, present whenever it is the way
                 * out.
                 */}
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
                    // a top-level chat's subtree is hidden by TWO different
                    // sets, and the caret must agree with both.
                    //
                    //   - `chat:<id>` in wsCollapsed  (what this caret writes)
                    //   - the bare id in `teapot.collapsed` (what treeRowsOf
                    //     checks `collapsedSubs` to hide the children)
                    //
                    // Reading only chatCollapsed() is what produced the reported
                    // DOM: an expanded caret (▾), a 🧩N badge, and no child rows at
                    // all — because a stale `teapot.collapsed` entry hid the
                    // subtree while the caret claimed it was open. The badge uses
                    // descendantsOf() and never consults either set, so it kept
                    // counting children that were hidden.
                    //
                    // So `off` is true if EITHER set says collapsed, and clicking
                    // clears both — otherwise the caret could point open at a
                    // hidden subtree, or clear one key and leave the other.
                    // a top-level chat's caret hides its CHILD rows too, so it is
                    // collapsed if either the chat group or its own sub-group says so;
                    // both default to closed now
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
                          // top-level chats share the persisted group set, so a
                          // reload keeps them collapsed; sub-agent collapse is
                          // its own set, as before
                          if (isChat) {
                            // SUB-GROUPS ARE COLLAPSED BY DEFAULT, so `off` is true for a chat
                            // purely because its sub-group was never expanded. Toggling only the
                            // ws-group then EXPANDED the group while the caret still read
                            // closed — the click looked like it did nothing. Clear BOTH sources
                            // of "off" when opening, and set both when closing.
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
                {/* Two different waits, two different marks. `waiting` covers both a parked tool
                    (resumes by itself) and an ask_user question (needs the operator), and one
                    pulsing accent dot for both said "something is happening" without saying
                    whether it is waiting on YOU. */}
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
                  /* show the session's own title when it has one, so several
                     sessions of one agent are distinguishable at a glance. The id
                     stays visible in the tooltip AND remains the fallback text —
                     a session whose first prompt had no usable line must still
                     render something clickable. */
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
                {/* Collapsed tree: surface how many subs are hidden so a busy
                    parent doesn't look idle with its subtree away.
                    #81: the gate was `collapsedSubs().has(id)` alone, but there
                    are TWO ways a subtree gets hidden — collapsing the subs, or
                    collapsing the CHAT — and the second is tracked by
                    `chatCollapsed()`. So collapsing the chat hid every sub-agent
                    with no count and no indicator, which is exactly the reported
                    "a session that has sub-agents shows none of them".
                    Either way, hide the badge only when nothing is hidden. */}
                <Show
                  when={
                    // #panel: this read the RAW persisted set, but sub-agent groups are now
                    // COLLAPSED BY DEFAULT — "not in the set" means CLOSED, not open. So the
                    // badge was hidden on every default-collapsed row, which is nearly all of
                    // them: a caret appeared (there ARE children) but the count that explains
                    // it did not. `subsCollapsed()` is the same predicate the caret uses.
                    subsCollapsed(row.a.id) ||
                    (row.chatCollapsedGroup === true && chatCollapsed().has(`chat:${row.a.id}`))
                  }
                >
                  {(() => {
                    // DESCENDANTS, not just direct children. A sub-agent
                    // that spawned its own was not counted at all, so the badge
                    // understated the subtree and — because the `· ▶N` active
                    // count had the same shape — a busy nested sub read as idle.
                    // This is the same recursion `subtreeUnread` uses, so the
                    // badge and the unread badge can no longer disagree.
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
          {/* row 1: buttons (incl. notification bell) — row 2: branding + live dot */}
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
                // keep the selection valid when the current session gets hidden
                if (next && selected() && sel()?.workspaceMissing) {
                  const firstVisible = agents().find((a) => !a.workspaceMissing);
                  if (firstVisible) select(firstVisible.id);
                }
              }}
            />
            <IconBtn icon="＋" title="new agent" onClick={() => { loadCfg(); setShowNew(true); }} />
            {/* 🎨 themes moved into ⚙️ settings → appearance: a theme is a PREFERENCE, not a
                per-session action, and the editor (palette rows + a background picker) needs
                room a popover cannot give. */}
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
              {/**
                * `rss` leads but does not answer "is it leaking".
                *
                * V8 keeps freed pages in its arenas, so RSS sits far above the live set and only
                * drops on a major GC — an operator watching it saw "501.4MB · heap 220.3MB" and
                * reasonably asked whether memory was out of control. The committed heap and the
                * non-heap (`ext`) are shown alongside so the gap is readable at a glance instead
                * of needing a measurement session to interpret.
                */}
              master rss {metrics().rssMb}MB · heap {metrics().heapUsedMb}MB
              <Show when={metrics().heapTotalMb !== undefined}> · total {metrics().heapTotalMb}MB</Show>
              <Show when={metrics().externalMb !== undefined}> · ext {metrics().externalMb}MB</Show>
              <br />
              load1 {metrics().loadavg1} · up {Math.floor(metrics().uptimeSec / 60)}m
            </Show>
          </div>
        </div>
      </nav>

      {/* ---------- channel ---------- */}
      <section class="channel" style={{ "--termh": `${termHeight()}px` } as any}>
        {/* keyed on the agent id: an agent-update snapshot replaces the agent OBJECT, and an
            object-gated Show would rebuild the whole layout (and every focused
            control in it) on every poll. */}
        <Show when={sel()?.id} keyed fallback={<div style="display:grid;place-items:center;height:100%" class="muted">select an agent</div>}>
          <header class="chan-head">
            {/* the only way to reach the agent list on a phone; absent on a wide screen, where
                the sidebar is a permanent column and a hamburger would be a dead control */}
            <Show when={narrow()}>
              <button
                class="iconbtn ham"
                title="agent list"
                aria-expanded={showLeft()}
                onclick={() => setShowLeft(!showLeft())}
              >☰</button>
            </Show>
            <span class="hash">#</span>
            <span class="title" title={agentLabelWithId(sel(), sel()!.session)}>{agentLabel(sel())}</span>
            {/**
             * The badge carries the status; its tooltip carries the REASON, and only when the
             * reason adds something.
             *
             * The server writes a reason on every status change, so it is usually mechanical
             * ("round complete", "prompt", "goal set") — repeating it was what made a bare ℹ
             * glyph appear on almost every session. But one case IS worth reading: a tool that
             * parked the agent (`wait_children`) sets idle with an explanation of how to take
             * over. Saying so on the badge keeps that available without a glyph that stands for
             * nothing on its own.
             */}
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
                  /**
                   * Count and describe the queue by WHO queued each message.
                   *
                   * The badge counted every queued prompt but called them all "from you", and
                   * harness prompts (an audit retry, a "keep going" nudge) are in the same queue —
                   * so the count grew for messages the operator never wrote (#122). A harness
                   * message also cannot be withdrawn, so promising "each can be withdrawn with ✕
                   * cancel" was false for exactly those.
                   */
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
                {/**
                  * The LABEL must come from the same count as the visibility test.
                  *
                  * `<Show>` was gated on `queuedCount()` (snapshot OR echoes) while the text read
                  * the snapshot alone, so an echo-only queue rendered "⏳ 0 of yours queued" —
                  * a badge that says there is nothing while announcing itself.
                  */}
                ⏳ {queuedCount()} {queuedCount() === 1 ? "message" : "messages"} queued
                {sel()!.status === "stopped" ? " (stopped)" : ""}
              </span>
            </Show>
            <Show when={agentTasks(sel()!.id).length > 0}>
              <span class="badge cron" title={`scheduled tasks:\n${agentTasks(sel()!.id).map((t) => `${t.schedule} · ${t.id}${t.forked ? " (forked)" : ""}`).join("\n")}`}>
                ⏰ {agentTasks(sel()!.id).length}
              </span>
            </Show>
            {/* Metadata recedes: it is REFERENCE, not something read while
                working. It used to be the same weight as the controls beside it,
                so the header read as one undifferentiated row of text. */}
            <span class="sub" title={`${sel()!.model} · ${sel()!.session}/${sel()!.branch} · turns ${sel()!.stats.turns} · tools ${sel()!.stats.toolCalls}`}>
              {sel()!.model} · {sel()!.session}/{sel()!.branch} · {sel()!.stats.turns}↻ {sel()!.stats.toolCalls}⚙️
            </span>
            <span class="head-actions">
              {/* No ℹ glyph here.
                  It appeared whenever `statusReason` was set, which the server fills on EVERY
                  status write — "round complete" after each idle, "prompt", "goal set". So it
                  was almost always on screen, and it said nothing the `badge` beside it had not
                  already said: the one fact it carried was hidden behind a hover, and that fact
                  was mechanical. A glyph you cannot read without hovering, repeating a word
                  already on screen, is noise. */}
              {/* THE primary action, moved out of the details panel.
                  Starting and stopping is what an operator does most, and it was
                  only reachable by opening a side panel — every other control was
                  closer to hand than the one that matters. It keeps the same
                  persistent-element trick as its old home (a `() =>` wrapper, not a
                  bare expression, or the handler freezes to the label it was born
                  with — see the #59 note on the original). */}
              {/* The PRIMARY action carries its WORD, not just a glyph.
                  "▶" alone was indistinguishable from the four other square buttons beside it,
                  so the one control an operator uses constantly looked like decoration. A
                  labelled button also says what pressing it does before you press it. */}
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
              {/* SECONDARY actions, visually separated so they read as a group rather than as
                  five more things of equal weight. Stop-subs is the one exception that stays
                  close to ▶/■: it is the same "interrupt" family, and it is only present when
                  there are sub-agents to stop. */}
              <Show when={agents().some((a) => a.parent === selected())}>
                <IconBtn icon="⏹" title="stop every sub-agent this agent spawned (descendants included)" onClick={stopChildren} />
              </Show>
              <span class="head-sep" aria-hidden="true" />
              {/**
                * ORDER: archive · fork · terminal · panel.
                *
                * The panel toggle used to sit next to fork, and the operator kept hitting ARCHIVE
                * on the way to it: "右パネル開閉しようとしてアーカイブしかけたことが何回かある".
                * Archive is the destructive one, so it goes FURTHEST from the toggle rather than
                * beside it — the toggle is the most-used control, and its neighbour should not be
                * the only irreversible action in the row (it is reversible, but not obviously so).
                */}
              <IconBtn icon="🗄" title="archive this agent — reversible: it leaves the list but keeps its config and history (restore in ⚙️ settings → archive)" onClick={archiveSelected} />
              <IconBtn icon="⑂" title="fork: branch off the conversation here — try things without disturbing the main line" onClick={forkSelected} />
              <IconBtn icon="⌨" title="terminal (t)" onClick={toggleTerm} />
              {/* the panel toggle advertises its STATE, not just its action: `active` fills
                  it when the panel is open, so the button answers "is it showing?" without a
                  click. `aria-expanded` says the same thing to a screen reader. */}
              <IconBtn icon="▤" title="toggle details panel (d)" active={showRight()} onClick={toggleRight} />
            </span>
          </header>

          <div class="feed" ref={(el) => attachFeedObserver(el)} onscroll={(e) => {
            const el = e.currentTarget;
            const now: TailSample = { top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight };
            /**
             * WHO moved the viewport — the only question that may change the follow state.
             *
             * Asked by `classifyScroll()` (frontend/scroll-policy.ts), which answers it from two
             * facts that layout cannot fake:
             *
             *   - the content HEIGHT changed since the last delivery ⇒ layout. The reader cannot
             *     change `scrollHeight`, so this delivery carries no evidence about intent.
             *   - the position equals `min(ledger, floor)` ⇒ our own write delivered late, or the
             *     browser clamping after a shrink. Both look exactly like "scrolled up" to a
             *     direction test, which is why the old `movedAway()` kept needing a slack
             *     constant.
             *
             * `ledger` is cleared after ONE delivery: a programmatic write produces exactly one
             * scroll event, and keeping it longer would swallow the reader's next real move.
             */
            const cause = classifyScroll(now, ledger, lastSampleHeight, lastSampleViewport);
            /**
             * A `layout` cause MAY be a `content-visibility` unskip, which moves the viewport.
             *
             * Both engines do this now. It was Firefox-only while `.feed` kept native scroll
             * anchoring on: Blink special-cases `anchor_is_cv_auto_without_layout_` (see
             * `docs/firefox-scroll-defects.md`) and absorbed the shift for us. Disabling native
             * anchoring for the Firefox composer fix (`ca15d77`) removed that absorption, so
             * Chrome started showing the same drift — which is why this is no longer gated on
             * "not the tail".
             *
             * `!atBottom()` was here because a reader-scrolled viewport was assumed to be the
             * only one that could shift. While FOLLOWING, a row above unskipping moves the
             * floor too, and the visible result is the timeline jittering under a pinned tail.
             * Both cases need the same correction, so the condition is now purely "did layout
             * move us", with the anchor telling us where to put it back.
             *
             * Still gated on a `layout` cause, and the reason is measured: an earlier version
             * ran on any large height delta and caught the reader's OWN wheel step —
             * `firstVisibleRow()` forces rows to lay out, so the delivery arrives with a
             * changed height and was mistaken for an unskip, undoing the wheel. A delivery the
             * reader did NOT cause is the only safe trigger.
             */
            if (
              cause === "layout" &&
              /**
               * NEVER while following — a pinned tail has no anchor worth restoring.
               *
               * This ran on any layout delivery, including while pinned, and the anchor it aimed
               * at was captured BEFORE new content was inserted above (a reasoning block appearing
               * at the start of an assistant turn is the usual case). Restoring to that row scrolls
               * the viewport back by the height of the new content — reported as "プロンプトを送って
               * からreasoningが出たくらいのタイミングでスクロールが何百pxか古い方に飛んだ".
               *
               * It also ran BEFORE the pin further down, so by the time `shouldPin` looked at the
               * distance to the tail the resync had created one, and the pin was skipped. While
               * following the only correct position is the tail, and `restoreAfterBoxChange`
               * already re-pins on the box change.
               */
              !atBottom() &&
              resyncBudget > 0 &&
              Math.abs(now.height - (lastSampleHeight ?? now.height)) > 1
            ) {
              resyncBudget--;
              resyncAfterUnskip(el, unskipAnchor);
            }
            /**
             * The ledger is consumed AFTER use, but a write whose delivery never arrived would
             * otherwise authorise the reader's NEXT move too. Any intervening layout (`layout`
             * cause) invalidates it, because the position it recorded no longer means anything.
             */
            ledger = null;
            lastSampleHeight = now.height;
            lastSampleViewport = now.viewport;
            lastSample = now;
            // the pill reads this instead of measuring the DOM itself
            publishGap(now);
            const wasFollowing = atBottom();
            /**
             * Keep the unskip anchor current — WHETHER OR NOT we are following.
             *
             * It used to be captured only for a parked reader, and cleared while following,
             * because the tail was assumed to be the only position that mattered there. Once
             * native scroll anchoring was disabled (`ca15d77`) that stopped being true: a row
             * above unskipping moves the floor under a pinned tail too, and with no anchor
             * recorded there is nothing to restore against — the correction had nothing to aim
             * at and the timeline jittered.
             *
             * Throttled: finding the row costs a binary search over row boxes, and a drag fires
             * scroll continuously. 100ms is well under the time it takes to read one row.
             */
            const t = performance.now();
            if (t - unskipAnchorAt > 100) {
              unskipAnchorAt = t;
              unskipAnchor = firstVisibleRow(el);
            }
            const follow = nextFollowing(wasFollowing, cause, now);
            if (follow !== wasFollowing) setAtBottom(follow);
            // a delivery the READER caused means they are driving: refill the unskip budget
            if (cause === "reader") resyncBudget = RESYNC_BUDGET_PER_GESTURE;
            /**
             * NEVER re-pin a delivery the READER caused.
             *
             * `shouldPin()` allows pinning while within `STICKY_PX` of the tail, which is right
             * for layout-driven deliveries — a streaming bubble that overshoots for one frame
             * must not drop follow. Applied to a reader's own scroll it is a trap: they wheel up
             * 40px, the delivery is classified `reader`, `nextFollowing` keeps follow because
             * they are still inside the sticky range, and this line immediately drags them back
             * to the tail. Reported as "スクロール追従時にユーザーからのスクロールが無効化される".
             *
             * A reader who moved away from the tail has expressed intent, whether or not they
             * are still inside the sticky band. Sticky exists to survive LAYOUT, not to
             * overrule a person.
             */
            if (follow && cause !== "reader") {
              if (missed()) setMissed(0);
              // reaching the tail marks this session read — the scroll itself, not a
              // new event arriving while we happen to be here
              markReadIfFollowing();
              // a delivery we caused can land a few pixels short of the floor (fractional
              // heights, content still being laid out). While following, keep it exact.
              if (shouldPin(follow, now) && distanceToTail(now) > 0) pinToTail();
            } else if (follow && atTail(now)) {
              // the reader arrived AT the tail: nothing to correct, but the read marker and the
              // missed counter still apply
              if (missed()) setMissed(0);
              markReadIfFollowing();
            }
            // reached the top → pull the next older page (infinite scroll up). Runs BEFORE
            // any follow logic: a reader at the very top is by definition not at the bottom,
            // and returning early here silently swallowed every loadOlder trigger.
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
               * While the FIRST page is in flight, say so.
               *
               * This fallback used to appear immediately, so switching into a slow or still-running
               * session showed "no events yet" for the length of the fetch — indistinguishable from
               * a session that had lost its history. Reported as "タイムラインロード中にアイテムが
               * 無いって表示されてるの微妙なので、loadingの状態がちゃんと分かるように".
               */
              loadingFeed()
                ? <div style="display:grid;place-items:center;height:100%" class="muted">
                    <span><span class="spinner" aria-hidden="true" /> loading timeline…</span>
                  </div>
                : <div style="display:grid;place-items:center;height:100%" class="muted">no events yet — say something or press ▶ start</div>
            }>
              {/* `<For>` iterates the ROWS THEMSELVES, not a wrapper object.
                  The wrapper existed to avoid `chatEvents()[i() - 1]` (which made every
                  row a subscriber of the whole memo — #178), but keying `<For>` on a
                  WRAPPER reintroduces the remount problem: a row whose neighbour changed
                  gets a new wrapper, so `<For>` disposes the row and its DOM state with it
                  (an expanded <details> slams shut). Neighbours are therefore passed as
                  ACCESSORS derived from the row's own position — the row object stays the
                  <For> item forever, while `grouped` still re-evaluates when the neighbour
                  changes. */}
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
                      // the DISPLAYED session must be the live one, not
                      // merely the same agent
                      isTimelineLive() && isOwnLiveWork(row)
                    }
                    // A row that EXPANDS when its result arrives (a `<details>` opening,
                    // a tool body growing) is one of the growth paths — decided by the
                    // policy, from geometry sampled at the moment the row resized.
                    onResize={() => {
                      // A row that EXPANDS (a `<details>` opening, a tool body growing) moves
                      // the content under the reader. While following, re-pin; otherwise leave
                      // them alone. Testing `atTail(after)` HERE was wrong: the row has
                      // already grown by the time this fires, so a follower is already "not
                      // at the tail" and the re-pin never ran — the feed drifted by the growth.
                      if (atBottom()) pinToTail();
                    }}
                    onCancel={
                      // only an OPERATOR prompt can be withdrawn. A harness
                      // prompt has no composer draft to return to — cancelling it
                      // would discard a system message the operator never wrote.
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
                                // put the text back WITHOUT clobbering what
                                // the user has typed since sending it
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
                      // settled user prompts only: a pending message has not reached the model
                      row.type === "prompt" &&
                      row.data?.source === "user" &&
                      !(row.data?.pending && row.data?.sent !== true) &&
                      !row.data?.cancelled
                        ? async () => {
                            // The server refuses to edit history under a running loop, because an
                            // unconsumed prompt is what the loop resumes into. Hiding the button
                            // instead made it disappear for anyone whose agent is usually running,
                            // so the click performs the two steps the operator already understands.
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
              {/**
                * A TAIL indicator while a refresh is in flight.
                *
                * Switching to a session that was already loaded paints its cached rows immediately,
                * then re-fetches — and that second step had NO visible sign, because the full-screen
                * spinner is gated on an EMPTY feed. The operator saw a complete-looking (but stale)
                * timeline that did not update for a while, reported as "最新アイテムをロードしている
                * 間に loading timeline... が出てなくてUXも悪い".
                *
                * At the BOTTOM of the feed rather than as a full-screen overlay: the rows on screen
                * are still valid, so covering them would throw away the reason they are cached. The
                * browser keeps the tail pinned because this row is part of the feed — the same
                * mechanism that follows new messages.
                */}
              {/**
                * `loadingFeed()` is the ONLY condition.
                *
                * Requiring rows as well made this dead: a switch clears the feed and hydrates from
                * cache within the same task, so there is no frame where both "loading" and "has
                * rows" hold — MEASURED as `feedloading` never appearing at all. The full-screen
                * spinner above already covers the empty case; this row is for the case where the
                * fetch is in flight, whatever is on screen.
                */}
              <Show when={loadingFeed()}>
                <div class="feedloading">
                  <span class="spinner" aria-hidden="true" /> loading newer events…
                </div>
              </Show>
              {/* #146: `live()` is keyed by AGENT, so a buffer saved while another
                  session of the same agent was on screen would still render here.
                  Show the bubble only for the session actually being displayed. */}
              <Show when={isTimelineLive() && live()}>
                <div class="msg live">
                  <div class="avatar" style="background:#5865f233;border:1px solid #5865f266">🫖</div>
                  <div class="msg-body">
                    <div class="msg-head">
                      <span class="author" style="color:var(--acc)">agent</span>
                      <span class="ts">streaming…</span>
                    </div>
                    {/* `.trim()` guard: a provider streams reasoning as DELTAS, and a
                        chunk can be pure whitespace ("\n\n"). `Show when={str}` is
                        truthy for that, so an empty 💭 block rendered for a frame —
                        the reported "agent が一瞬空のreasoning を表示する". The
                        reasoning is not empty, it just has nothing in it yet. */}
                    <Show when={liveReasoning().trim() !== ""}>
                      <details class="reasoning" open>
                        <summary>
                          💭 thinking <ThinkingTimer startedAt={liveStartedAt()} />
                        </summary>
                        {/* ref + scroll-follow: the thinking block grows from the
                            bottom; keep its tail visible while it streams. The
                            effect only scrolls THIS div — never the feed itself —
                            so the two follow loops can't fight each other. */}
                        <div
                          class="mono thinkscroll"
                          ref={(el) => {
                            // follow the thinking tail ONLY while the reader
                            // is at the block's own bottom — scrolling up
                            // inside it must pause follow (and returning to
                            // the tail resumes), independent of feed position
                            let stick = true;
                            el.addEventListener("scroll", () => {
                              stick = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                            });
                            createEffect(() => {
                              liveReasoning(); // re-run on every throttled tick
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
                  // pressing "jump to present" IS reading the tail — the
                  // operator asked to be taken to the newest content, so the
                  // badge must settle exactly as it does for a manual scroll
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
              {/* staged image chips — clicking ✕ unstages before send */}
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
                // NOT `value={draft()}`: Solid writes the node's `value` on every
                // change of the signal, and a write during an IME composition ends
                // the composition and discards the kana typed so far — the
                // "入力中にメッセージが消える" report. Measured: two DOM writes per
                // input event, both mid-composition. The value is synced by the
                // effect below instead, which stands down while composing.
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
                  // Safari fires compositionend BEFORE the final keydown for
                  // Enter, so defer the reset one frame to let that keydown
                  // observe the flag (see imeInProgress).
                  requestAnimationFrame(() => {
                    imeInProgress = false;
                  });
                  // the composition's RESULT must reach the signal, or the next
                  // sync would overwrite the converted text with the pre-edit
                  // draft
                  saveDraft(composerEl?.value ?? "");
                }}
                onpaste={(e) => {
                  // screenshots land on the clipboard as files — stage them
                  const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
                  if (imgs.length) {
                    e.preventDefault();
                    addImages(imgs);
                  }
                }}
                oninput={(e) => {
                  saveDraft(e.currentTarget.value);
                  setCmdIdx(0); // highlight first suggestion while popup is open
                  autosizeComposer();
                }}
                onkeydown={(e) => {
                  // unified suggestion navigation — the input keeps focus, the
                  // highlighted row just moves (↑↓), Tab/Enter accepts
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
                    setCmdIdx(-1); // close popup only
                    return;
                  }
                  // IME composition: Enter confirms the conversion, never sends.
                  // Test our own flag, not e.isComposing — Safari has already
                  // ended composition by the time this keydown arrives.
                  // a MAXIMIZED composer takes Enter as a newline.
                  //
                  // Maximize exists for composing long text — a pasted stack trace,
                  // a multi-paragraph question — and in that mode Enter has to mean
                  // "new line" or the text cannot be written at all. Shift+Enter
                  // inserts a newline in the normal composer, so the expanded one is
                  // strictly more permissive, not inconsistent: what changed is only
                  // that Enter no longer SHORTCUTS to a send.
                  //
                  // Sending is still one keystroke away (the send button), so nothing
                  // becomes unreachable.
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
                  // re-run autosize under the new regime, then keep the feed
                  // pinned / restored correctly across the relayout
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
              {/* hidden input lives here so the 📎 button can trigger it */}
              <input
                id="composer-file"
                type="file"
                accept="image/*"
                multiple
                style="display:none"
                onchange={(e) => {
                  if (e.currentTarget.files?.length) addImages(e.currentTarget.files);
                  e.currentTarget.value = ""; // allow re-selecting the same file
                }}
              />
            </form>
            {/**
             * The hint line is for FLASH messages only.
             *
             * It used to hold a permanent keyboard cheat-sheet under the composer, which the
             * operator reads once and then has to look past forever. The same text now lives in
             * ⚙️ settings → ❔️ help, where it is found when it is needed; a keyboard reference is
             * something you consult, not something you stare at while typing.
             */}
            {/**
             * The hint is an OVERLAY, not a sibling.
             *
             * When it was a normal child of the composer block, showing it pushed the whole
             * column up by its height and hiding it dropped it back — so every flash message
             * (a background job finishing, "copied", "memory saved") bounced the composer and
             * with it the timeline. Reported as "時々届く通知によって入力欄が上下する".
             *
             * Absolutely positioned below the box, so it is readable when it appears and costs
             * zero layout at any other moment.
             */}
            <Show when={flash()}>
              <div class="hint flashhint">{flash()}</div>
            </Show>
          </div>
        </Show>
      </section>

      {/* ---------- right bar ---------- */}
      {/* Drawer-only close row. In wide mode .rightbar is a grid column
          that sits next to the content, and the ▤ button in the channel header
          is right there — so this row stays `display:none` (see app.css) and
          costs a wide-screen user nothing. Narrow, the panel is a fixed drawer
          covering up to 92vw of the screen; it covers the ▤ button that opened
          it, leaving NO visible way back out. This is that way out. */}
      {/* Click-outside dismiss for the drawer. Mirrors .notifbackdrop:
          an invisible full-screen layer UNDER the panel but OVER everything
          else, so a click anywhere on the content closes the drawer — the same
          gesture users already know from the notification popover.
          Rendered only in narrow mode: on a wide screen the panel is a static
          column and a full-screen click-catcher would swallow every click in
          the app. Gated on showRight() too, so a closed drawer — which is still
          in the DOM, translated off-screen — never blocks the UI. */}
      <Show when={narrow() && showRight()}>
        <div class="rightbarbackdrop" onclick={() => setRight(false)} />
      </Show>
      <aside
        class={"rightbar" + (showRight() ? " open" : "")}
        ref={rightbarEl}
        onscroll={(e) => { rightbarTop = (e.currentTarget as HTMLDivElement).scrollTop; }}
      >
        {/* Close row — INSIDE the panel, and sticky so the panel's own
            overflow-y can never scroll it out of reach. On a wide screen
            .rightbar is a grid column sitting next to the content and the ▤
            button is right there, so this row stays display:none and a static
            column gets no new control. Narrow, the panel is a fixed drawer
            covering up to 92vw; it covers the ▤ button that opened it, leaving
            no visible way back out. This is that way out.

            Sticky rather than merely first-child: .rightbar is a long scroll
            container (session, runtime, files, tasks…), and a close button
            that scrolls away is the bug one scroll away from returning. The
            negative margin lets the row's background cover the panel's padding
            while the sticky top stays 0. */}
        <div class="rightbarhead">
          <span class="muted">details</span>
          <IconBtn icon="✕" title="close details panel (esc)" onClick={closeRight} />
        </div>
        {/* Gated on the agent ID, not the agent OBJECT. `when={sel()}`
            re-ran this whole subtree whenever an agent-update snapshot replaced
            the object — its compiled children getter builds a fresh array each
            time, so Solid rebuilt the panel and any focused control inside it
            (the tasks editor lost focus and caret). The id only changes when the
            operator actually switches agent, which is the only case where a
            rebuild is correct. Same trick FilesPanel uses below. */}
        <Show when={sel()?.id} keyed fallback={null}>
          {(_aid) => (
          <>
          {/* 🎛 session used to be a CARD here: agent / workspace / session+branch.
              Every one of those was already on screen — the header shows the agent, its
              status, the model and session/branch, and the file tree below is rooted at the
              workspace. Folding it would have hidden the duplication rather than removed it
              (#panel), so the card is gone and the workspace path moved onto the header
              title as a tooltip: the one fact it added, at zero cost in width. */}

          {/* keyed by agent id: Solid re-runs the JSX expression on every
              snapshot update, but <Show keyed> + primitive props keep the
              FilesPanel subtree from re-rendering unless the agent changes */}
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
                // switching provider must SELECT that provider's default
                // model. The draft used to keep the previous provider's value,
                // so apply carried a foreign model id to the new endpoint.
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
            {/* #47: reasoning effort. Shown ONLY when the endpoint's catalogue
                says this model advertises `reasoning_effort` — support is 196/462
                on OpenRouter and absent elsewhere, so offering it everywhere
                would be a control that silently does nothing. */}
            <Show when={sel()!.effortSupported}>
              <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
                <label class="muted" style="font-size:11.5px;white-space:nowrap">effort</label>
                <select
                  style="flex:1;min-width:0"
                  value={effortDraft()}
                  onchange={(e) => setEffortDraft(e.currentTarget.value)}
                >
                  <option value="">provider default</option>
                  {/* Offer the levels THIS model accepts when the endpoint publishes
                      them: a model advertising ["max","high","low"] must not be
                      shown minimal/medium, which would be refused or silently clamped.
                      Falls back to the four we offer when the endpoint says nothing. */}
                  <For each={sel()!.effortOptions?.length ? sel()!.effortOptions : REASONING_EFFORT_OPTIONS}>
                    {(v) => <option value={v}>{v}</option>}
                  </For>
                </select>
              </div>
            </Show>
            {/* ONE apply for the whole 🧦 model box (#3 follow-up).
                There used to be a button beside the model input AND one beside
                the effort select, both posting to the same endpoint. Two buttons
                for one form is ambiguous about what each one sends — the operator
                could not tell whether pressing "apply" next to the effort had
                also carried their model edit, and it had not. So there is one
                button, it sits here under both fields, and it sends both. */}
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
                        // pass the provider-reported window so the runtime
                        // gauge + derived compaction budget work immediately
                        contextWindowTokens:
                          models().find((m) => m.id === (modelDraft().trim() || undefined))?.contextLength,
                        // "" clears it back to the provider default. Sent only
                        // when the endpoint offers the control at all: a model
                        // with no effort support must not have one forced on it.
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

          {/* ⏯ CONTROLS MOVED TO THE HEADER (#panel).
              start/stop, fork, stop-subs and archive used to live here, which meant the
              operator had to open the details panel to pause the agent they were reading.
              A control belongs next to the thing it controls, and the header already names
              the agent. What remains here is a SETTING rather than a control: auto-continue
              describes how the loop behaves, so it sits with the goal it loops for. */}
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
                  // an EMPTY goal must not light up "▶ working": fresh
                  // sessions store status:"active" by default, which made a
                  // brand-new timeline look like the agent was already on it
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
          {/* the explanation is the heading's tooltip: it never changes, so printing it under
              the goal permanently costs a line in the panel every time the operator looks */}
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

          {/* 📊 runtime — ONE GAUGE, THEN A GRID.
              The previous two-layer version folded "usage & cost" into <details>. That was
              the wrong shape: folding is for things you rarely need, and these numbers are
              read constantly — a `<details>` is a click tax on every glance, and it hides
              the very thing (cost, turns, how often it compacted) that says whether the
              session is behaving.

              The rows were dense because they were ROWS: each number got a label column, a
              value, and its own line. As a 3-column grid the same facts occupy three lines
              instead of seven, so nothing has to be hidden to keep the panel readable. */}
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
                // ALL derived values are memos: this callback used to run ONCE
                // (unkeyed <Show> builds its children a single time), freezing
                // pct/bar/labels at the first snapshot — the gauge then showed
                // "0% of 1m" forever while the token count itself kept updating
                // (that count is a JSX expression, so it stayed reactive).
                const ctxVals = createMemo(() => {
                  const cv = c;
                  const modelMeta = models().find((m) => m.id === sel()!.model);
                  const effectiveWindow = cv.window || modelMeta?.contextLength || 0;
                  // one decimal place — 0.4% vs 0% matters on million-token windows
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
                    {/* ONE threshold, stated once. This used to appear three times —
                        the `compact` row, a "(75% of window)" suffix, and a sentence
                        below — plus a SECOND gauge measuring the same thing against
                        `derivedBudget`. Two bars for one quantity is what made the
                        panel read as dense while conveying less. */}
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
            {/* the reference numbers: always visible, as a grid rather than as rows */}
            <div class="rtgrid">
              {/**
               * ONE NUMBER PER CELL.
               *
               * These were composites — `202.8m/230k`, `7440/7682` — and a composite is
               * whatever its two halves add up to. A long session pushed both past the column
               * width and the value escaped the card (reported twice, for tokens AND turns).
               * No amount of ellipsis fixes that honestly: eliding "202.8m/230k" hides which
               * half was clipped.
               *
               * Split, each cell holds one short value that fits at any scale, and the label
               * says which half it is. The grid then needs no elision at all for real numbers.
               */}
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
                {/* no unit line: "times" restated the label, and "never" is already visible from the 0 */}
              </div>
              <Show when={(sel()!.stats.costUsd ?? 0) > 0}>
                <div
                  class="rtcell"
                  title={`≈ ${(sel()!.stats.costUsd ?? 0).toFixed(4)} this session, from the model's USD/token pricing and per-turn usage. Cached input is estimated at ~10% of the prompt rate; treat as an approximation, not an invoice.`}
                >
                  <span>cost</span>
                  <b>${costFmt(sel()!.stats.costUsd ?? 0)}</b>
                  {/* the label says cost; "this session" restated the panel's own scope */}
                </div>
              </Show>
              <Show when={(sel()!.stats.cachedInputTokens ?? 0) > 0}>
                <div
                  class="rtcell"
                  title={`${fmtK(sel()!.stats.cachedInputTokens)} input tokens were served from the provider's prompt cache — billed far cheaper than fresh input`}
                >
                  <span>cached</span>
                  <b>{Math.round((sel()!.stats.cachedInputTokens / Math.max(1, sel()!.stats.inputTokens)) * 100)}%</b>
                  {/* "of input" is implied by the `cached` label */}
                </div>
              </Show>
            </div>
          </div>

          {/* 🌿 branches stays OPEN: each row FILTERS the feed, so it is an active control,
              not reference data. Folding it was the "hiding instead of shaping" mistake — a
              filter you cannot see is a filter you forget exists. */}
          <h3>🌿 branches <span class="muted" style="text-transform:none;letter-spacing:0">· click to filter the feed</span>
            {/* Say what the filter actually does. A fork INHERITS everything
                before its fork point, and that history is now included, so the
                view matches the context the agent actually reasons over. Say
                so explicitly, because a strict branch filter used to hide the
                inherited rows and read as data loss. */}
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
                  // A filter change is a new VIEW, exactly like a session switch:
                  // bump the generation so an in-flight fetch for the previous
                  // filter is discarded rather than landing in this one.
                  if (changing) {
                    feedGeneration++;
                    // and drop the rows that no longer belong — loadEvents
                    // union-merges with `prev`, so without this the previous
                    // branch's rows stayed on screen after filtering, which is
                    // the "the branch filter doesn't work" report.
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

          {/* ⏰ schedule — OPEN, not folded.
              It was folded on the argument that it lists cron tasks for all agents and so is
              unrelated to the agent being viewed. That reasoning justified SHOWING it less
              prominently, not hiding it: an unread schedule is a schedule you forget is
              running, and the section is short (a few rows) so folding saved no real space. */}
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
                  {/* NOT monospace: this line is mostly prose ("→ next 5m · last
                      2h"), and reading it in a fixed-width face was hard (#tasks).
                      Only the raw `- [ ]` markdown editor keeps monospace. */}
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
      {/* notification center — pops from the sidebar footer, bottom-left */}
      {/* click-outside closer: an invisible full-screen layer under the panel */}
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
                    // mark THIS one read, jump to its agent and scroll the
                    // timeline to the exact message that raised it
                    setNotifs((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
                    if (selected() !== n.agentId && agents().some((a) => a.id === n.agentId)) select(n.agentId);
                    setShowNotifs(false);
                    if (n.eventId)
                      // wait for the timeline swap before scrolling
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
          /**
           * PREVIEW setters: they change what is painted and write NOTHING.
           *
           * The settings dialog previews an appearance before committing it, so a preview must not
           * be a commit. Storage belongs to `commitAppearance` alone, which the save button calls.
           *
           * These used to be the bare Solid setters with every caller expected to persist, and
           * `pickThemeCard` did not — MEASURED: clicking a light card while "follow the system" was
           * on left the painted theme `dark` and never wrote `teapot.theme.light`.
           */
          setDark: setSysDarkTheme,
          light: sysLightTheme,
          setLight: setSysLightTheme,
          setThemes: setCustomThemes,
          setActive: setFixedTheme,
          /** paint this id regardless of the slot the OS selects — the settings preview */
          preview: (id: string | null) => setPreviewTheme(id),
          /**
           * Commit the appearance to storage — the SAVE path.
           *
           * Split from the setters above so a preview cannot decide anything. Everything the
           * operator can see is already live by this point; this only makes it survive a reload.
           */
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
        const [tail, setTail] = createSignal<"summarize" | "discard">(afterCount() > 0 ? "summarize" : "discard");
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
                    body: JSON.stringify({ eventId: ed().eventId, text: ta.value, tail: tail() }),
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
                <div>
                  <div style="font-size:12.5px;margin-bottom:4px">
                    {afterCount()} event(s) came after this prompt — what should happen to them on the new branch?
                  </div>
                  <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--fg)">
                    <input type="radio" name="tail" checked={tail() === "summarize"} onchange={() => setTail("summarize")} />
                    summarize them into a note the agent can still read
                  </label>
                  <label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--fg)">
                    <input type="radio" name="tail" checked={tail() === "discard"} onchange={() => setTail("discard")} />
                    discard them entirely (clean timeline)
                  </label>
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

  // The server resolves each requested path (absolute + ~ expansion) and
  // returns the RESOLVED path as d.path plus its parent. Keep those in state:
  // the old ↑ button sent a bare "..", which the server resolved against ITS
  // cwd — so going up never worked from the picker.
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
        // start: false → the agent stays lazy/stopped; the first prompt (or
        // ▶ start) kicks off the loop, so no API call fires on an empty agent
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
