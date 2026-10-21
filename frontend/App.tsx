import { createSignal, onMount, onCleanup, For, Show, createMemo, createEffect, untrack, Index } from "solid-js";
import { renderMarkdown } from "./md";
import { fmtDur } from "./format";
import {
  applyDelta,
  clearLive,
  clearThinkClockIfDone,
  isCoveredByLog,
  isTurnBoundary,
  isOwnLiveWork,
  pruneDeadLiveBuffers,
  reconcileLiveBuffer,
} from "./live-buffer";
import { buildTimeline, type TimelineEvent, type PendingEchoLike } from "./timeline";
import { goalLine, isPlaceholderDetail } from "./goal-timeline";
// #98: descendant-aware counting, so the 🧩 badge matches the real subtree.
import { descendantsOf, shouldShowCollapseCaret, subAgentDisplayName } from "./sidebar-tree";
// #75: extracted so the tests drive the code that runs — they used to carry their
// own copy, and deleting the real execCommand fallback left them green.
import { copyText } from "./clipboard";
import { groupedWith, type RowLike } from "./row-grouping";
import { answeredQuestionIdsOf, type QuestionEvent } from "./question-answered";
import { reconcilePending, type PendingEcho } from "./pending-echo";
// #141: pure + exported, so the session switcher is testable rather than re-implemented
import { resolveTimelineSession } from "./session-index";
// #146: the scope predicates are PRODUCTION, so the tests can assert the same code
// the handler runs — a test-local copy proves nothing (#75)
import { deltaBelongsToTimeline, eventBelongsOnTimeline, timelineIsLive } from "./session-scope";
import { retintTerminal, themeColors } from "./terminal-theme";
import { shellOutcome, shellHint, outcomeMarker } from "./shell-outcome";
import {
  treeRowsOf,
  sidebarRowsOf,
  workspaceOf as workspaceOfPure,
  chatGroupKeyOf,
  wsChatCountsOf,
} from "./sidebar-tree";
import { effectiveProviderOf, mayResyncProvider, modelOnProviderSwitch, modelPlaceholderFor } from "./model-selection";
import { composerValueChanged, shouldWriteComposerValue } from "./composer-ime";
import { atTail, gapToTail, movedAway, shouldShowJumpToPresent, type TailSample } from "./scroll-policy";
import {
  applyCustomTheme,
  loadCustomThemes,
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
} from "./theme-store";

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
import { indexAfterAppend, paneIndexAfterClose, rightPaneSeed } from "./term-tabs";
import { pickAfterArchive } from "./archive-target";

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
  id: string; status: string; statusReason: string; workspace: string;
  /** is work in flight that `stop` would stop? `status` alone cannot say — a
   *  parked tool and queued prompts are both live while status reads "idle" (#59) */
  live?: boolean;
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

interface Ev {
  id: string; seq: number; ts: string; session: string; branch: string;
  type: string; parent: string | null; data: any;
}

const AUTHORS: Record<string, { name: string; icon: string; color: string }> = {
  prompt: { name: "you", icon: "🟧", color: "#faa81a" },
  user: { name: "you", icon: "🟧", color: "#faa81a" },
  message: { name: "agent", icon: "🫖", color: "#5865f2" },
  progress: { name: "progress", icon: "📈", color: "#3ba55d" },
  question: { name: "agent", icon: "❓", color: "#5865f2" }, // ask_user comes from the agent too
};
const HARNESS_AUTH = { name: "harness", icon: "📣", color: "#3ba55d" };

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
type ThemeMeta = {
  key: string;
  label: string;
  mode: "dark" | "light";
  /** three preview dots: page bg · raised surface · accent */
  sw: [string, string, string];
};
const THEMES: ThemeMeta[] = [
  { key: "dark", label: "Dark", mode: "dark", sw: ["#1a1c22", "#2b2e39", "#5865f2"] },
  { key: "midnight", label: "Midnight", mode: "dark", sw: ["#0d0f18", "#252a42", "#8b7cf7"] },
  { key: "tea", label: "Milk Tea", mode: "dark", sw: ["#241c16", "#493b2d", "#d98e32"] },
  { key: "coffee", label: "Coffee", mode: "dark", sw: ["#191410", "#403527", "#c68a4b"] },
  { key: "matcha", label: "Matcha", mode: "dark", sw: ["#1b2217", "#3c4a33", "#8db64e"] },
  { key: "matrix", label: "Matrix", mode: "dark", sw: ["#060a06", "#18301d", "#2fd558"] },
  { key: "sunset", label: "Sunset", mode: "dark", sw: ["#1c1422", "#452f52", "#f2784b"] },
  { key: "light", label: "Light", mode: "light", sw: ["#eceef4", "#ffffff", "#4757d8"] },
  { key: "strawberry", label: "Strawberry", mode: "light", sw: ["#fbe4ea", "#fffafb", "#e05575"] },
  { key: "ramune", label: "Ramune", mode: "light", sw: ["#ddeff7", "#fbfeff", "#1d86ae"] },
];

/** author for an event — mirrored sub-agent rows act under their own id */
const authorOf = (e: Ev) => {
  if (e.data?.actor) return { name: `@${String(e.data.actor)}`, icon: "🧩", color: "#3ba0c9" };
  if (e.type === "tool_call" || e.type === "tool_result")
    return { name: String(e.data?.name ?? "tool"), icon: "⚙", color: "#3ba0c9" };
  if (e.type === "prompt") {
    const src = String(e.data?.source ?? "user");
    if (src === "user") return AUTHORS.prompt;
    return src.startsWith("scheduler:") ? { name: src.slice(10), icon: "📣", color: "#3ba55d" } : HARNESS_AUTH;
  }
  return AUTHORS[e.type] ?? { name: e.type, icon: "•", color: "#9298a5" };
};

// state/error/fork/goal render as dividers or embeds inside the feed
const FEED_TYPES = new Set([
  "user", "message", "prompt", "tool_call", "tool_result", "progress",
  "state", "error", "fork", "goal", "todo", "question", "decision", "compaction",
  "system_note",
  // NOTE: "sub" is deliberately NOT here. A child's activity is no longer
  // mirrored into the parent's log (#63) — those rows flooded the parent's
  // timeline, and they were display-only anyway: `rebuildMessagesFrom` never
  // read them, so the model never saw them either. A chat's timeline is its own.
  // The expansion below still handles a `sub` row so an OLD log that already
  // contains one renders as an attributed child row rather than vanishing.
]);
// system_note rows never RENDER, but two of them drive pending-echo state:
// prompt-delivered flips the echo to "sent" and must ALSO refresh the feed so
// the logged prompt row replaces the echo right away (otherwise the "sent ✓"
// echo lingered until some unrelated event happened to refresh the timeline)
const NOTE_FEED_TYPES = new Set(["system_note"]);

/**
 * The types that actually DRAW a row — `FEED_TYPES` minus the ones that pass the
 * filter but render nothing (#75).
 *
 * `state` is the offender that was measured: it is in `FEED_TYPES`, neither
 * MessageRow nor SwitchContent has a branch for it, and yet it became the
 * grouping `prev` of the next row. Because `groupedWith()` keys on the row TYPE,
 * an invisible row CUT a run of bash calls in half — reported as "bashが連続なのに
 * 両方にアイコンがついてる", and it also merged unrelated runs, which stole the icon
 * from a run's FIRST row.
 *
 * `system_note` renders only for a few event kinds (runaway-detected, error-retry,
 * background-exit, context-compacted, context-compaction-started). The rest —
 * `prompt-delivered`, `session-restored`, `llm-retry`, … — are log-only, and they
 * have exactly the same effect on grouping, so they are dropped from the chain by
 * the note-event check below rather than by type.
 *
 * Kept as an explicit list so adding a feed type without a render branch is a
 * visible omission: the tests assert every member renders something.
 */
const RENDERED_TYPES = new Set([
  "user", "message", "prompt", "tool_call", "tool_result", "progress",
  "error", "fork", "goal", "todo", "question", "decision", "compaction",
]);

/** system_note shapes that DO draw a divider/embed; the rest are log-only. */
const RENDERED_NOTE_EVENTS = new Set([
  "runaway-detected",
  "error-retry",
  "background-exit",
  "context-compacted",
  "context-compaction-started",
]);
const fmtTs = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

async function api(path: string, opts?: RequestInit) {
  const token = localStorage.getItem("teapot.token");
  const headers = new Headers(opts?.headers);
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) {
    // auth gate: surface once so the login overlay can appear
    if (res.status === 401) window.dispatchEvent(new CustomEvent("teapot:unauthorized"));
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not json */ }
    const detail =
      (body && typeof body === "object" && "error" in body ? String((body as any).error) : "") ||
      `${path}: HTTP ${res.status}`;
    // carry the full payload (e.g. a 409's `current` file content) to callers
    throw Object.assign(new Error(detail), { payload: body });
  }
  return res.json();
}

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
   * #155: session id → human title, from `/api/sessions`.
   *
   * The per-agent snapshot also carries a title, but only for a session whose agent
   * has been RESTORED. Boot leaves agents stopped, so the sidebar would show raw ids
   * for every session the operator has not opened — i.e. the ones they most need to
   * tell apart. This index is built from the logs themselves and covers all of them.
   */
  const [sessionTitles, setSessionTitles] = createSignal<Map<string, string>>(new Map());
  let sessionIndexFetched = false;
  async function refreshSessionIndex(force = false): Promise<void> {
    // A permanent latch meant a session created or deleted while the tab was
    // open never appeared — the UI kept a handle to a session that no longer
    // existed, which is the unusable half of #39. Refetch when asked; the
    // caller decides when that is worth it.
    if (sessionIndexFetched && !force) return;
    sessionIndexFetched = true;
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
    } catch { /* transient — retried on next agent-set change */ }
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
  const [showCfg, setShowCfg] = createSignal(false);
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

  /* #103: a resize must not move the operator's place in the timeline.
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
  let feedRo: ResizeObserver | undefined;
  let feedRoEl: HTMLElement | undefined;
  let feedRoRaf = 0;
  let feedRoLastBox = "";
  const restoreAfterBoxChange = () => {
    feedRoRaf = 0;
    const f = feedEl();
    if (!f) return;
    if (atBottom()) {
      // following: re-pin to the NEW maximum. Assigning scrollHeight lets the browser clamp,
      // so this is correct without knowing the new viewport height.
      pinToTail();
      return;
    }
    const anchorRow = firstVisibleRow(f);
    if (!anchorRow) return;
    const el = f.querySelector<HTMLElement>(anchorRow.sel);
    if (!el) return;
    const delta = el.getBoundingClientRect().top - anchorRow.top;
    if (delta) f.scrollTop += delta;
    // the box changed, so the gap did too — keep the pill honest
    publishGap(tailSample());
  };
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
   *  viewport-relative top. Used as the anchor a resize must preserve (#103). */
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
     * BINARY SEARCH, not a linear scan (#179).
     *
     * MEASURED cost of the old loop: `getBoundingClientRect()` on every row until one was
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

  /* ---------- theme picker (per-browser, localStorage-backed) ---------- */
  // fixed theme…
  const [fixedTheme, setFixedTheme] = createSignal(localStorage.getItem("teapot.theme") ?? "dark");
  // …or follow the OS, with an explicit choice per system appearance
  const [themeAuto, setThemeAuto] = createSignal(localStorage.getItem("teapot.theme.auto") === "1");
  const [sysLightTheme, setSysLightTheme] = createSignal(
    localStorage.getItem("teapot.theme.light") ?? "light",
  );
  /**
   * Operator-authored themes, persisted separately from the preset choice.
   *
   * A preset is a `[data-theme]` block in app.css; a custom theme cannot be one (nothing in the
   * browser can write a stylesheet), so it is applied as INLINE custom properties on `<html>`.
   * That is why the two are separate signals: `fixedTheme` names a preset OR a custom id, and
   * `customThemes` is the palette behind that id.
   */
  const [customThemes, setCustomThemes] = createSignal<CustomTheme[]>(loadCustomThemes());
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
    const want = themeAuto()
      ? sysPrefersLight()
        ? sysLightTheme()
        : sysDarkTheme()
      : fixedTheme();
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
   * #143 A/B: paint/layout containment for timeline rows, toggleable at runtime.
   *
   * The client held 418 MB for one session (600 MB after a reload) because a page of
   * 2000 events is ~22 000 DOM nodes of already-parsed markdown, all of it LAID OUT.
   * `content-visibility: auto` lets the browser skip layout/paint for rows outside the
   * viewport while keeping them in the DOM, so scroll anchoring, `data-eid` lookups,
   * cmd-F and text selection all keep working — unlike virtual scrolling, which would
   * buy the memory by unmounting rows.
   *
   * It is a data attribute rather than a plain CSS rule so the change can be A/B'd on
   * a live server: `teapot.feedCv=0` in localStorage turns it off without a rebuild,
   * which is what makes a memory comparison between two releases meaningful.
   */
  createEffect(() => {
    const off = localStorage.getItem("teapot.feedCv") === "0";
    if (off) delete document.documentElement.dataset.feedcv;
    else document.documentElement.dataset.feedcv = "on";
  });
  // NOTE (#179): there used to be a second effect here that walked every row and wrote an
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
  // #47: reasoning effort draft ("" = provider default). Seeded from the
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
      text: "📄", image: "🖼️", audio: "🔊", video: "🎬", file: "📎",
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
  // #3: set when the operator works the provider dropdown themselves. The
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
      // touched the dropdown (#3)
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
  const liveBody = () => (liveIsCompact() ? liveText().slice("[compact] ".length) : liveText());
  // a summarizer's streamed output is shown in the live bubble; clear it when
  // the pass ends so a stale "[compact] …" bubble can't outlive it
  createEffect(() => {
    if (!compacting()) setLive((l) => (l?.text.startsWith("[compact] ") ? null : l));
  });
  // #108: re-pin the feed when the compaction banner appears or disappears.
  //
  // The banner lives INSIDE the feed, so a pass changes its height twice — and
  // on `phase: done` the live-text effect above clears the bubble in the same
  // frame, tripping its own `if (!txt && !rsn) return;` guard. The feed got
  // shorter with follow still `true` and the reader was left above the bottom.
  // Nothing else fires on that transition: per-row `onResize` only runs when the
  // OPERATOR opens a `<details>`.
  createEffect(() => {
    // key on the banner's presence, in BOTH directions
    void compacting();
    // No before/after comparison: while following, the pin is simply applied once the DOM
    // has settled. Whether the banner ADDED or REMOVED height is irrelevant — a pinned feed
    // should show its tail either way, and a reader who scrolled up is not followed at all
    // (`atBottom()` inside `scrollBottom`).
    //
    // The two frames are still needed: one for the banner to enter/leave the flow, one to
    // paint. Deferring does not need a decision, because pinning is idempotent.
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
    // #40: sweep EVERY agent's buffer against its OWN status, not the selected
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
  // Reconcile by IDENTITY, not by count (#9). This used to be slice(0, queued)
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
    // wrote the result under the new key, dropping the echo (#87). The smoke
    // test caught it: "undelivered log row leaked through as settled".
    const mine = pendingFor(key);
    const next = reconcilePending(mine, queued, liveIds);
    if (next !== mine) writePending(key, next);
  });

  /**
   * Rebuild echoes the UI does not have for a queue it does (#87).
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
    const key = pendingKey();
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
        // #122: the snapshot already carries `source`; dropping it made every
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
          // #160: returning to the tab and finding the tail is the same act of
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
   * Is the selected agent doing work that `stop` would stop? (#59)
   *
   * The server is the authority (`Agent.live`), because the client genuinely
   * cannot derive it: a parked tool and queued prompts both leave `status` at
   * "idle" while the loop is alive. Falls back to the status check for an older
   * server, where it is at worst the behaviour we had before.
   */
  const isSelLive = (): boolean => {
    const a = sel();
    if (!a) return false;
    return a.live ?? (a.status === "running" || a.status === "waiting");
  };
  /**
   * Is the TIMELINE BEING DISPLAYED the one that is live?
   *
   * #146: `isSelLive()` answers "is this AGENT working", but the timeline is
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
    // gate separately, and the three drifted (#54).
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
   * Optimistic echoes, PER SESSION (#87).
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
    // #100: at most ONE echo per promptId, enforced at the single point every
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
   * Mark the DISPLAYED session read when the reader is at its tail (#160).
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
          // #54: the call scrolled out of the events window while the command
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
   * yet (#55).
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
  // extracted to ./question-answered so the rule can be tested against the code
  // that runs — it used to live inline here, and the tests re-implemented it,
  // which is why deleting either half left them all green (#75)
  const answeredQuestionIds = createMemo(() =>
    answeredQuestionIdsOf(events() as unknown as QuestionEvent[], locallyAnswered()),
  );
  const chatEvents = createMemo(() =>
    // The pipeline lives in ./timeline so its stages cannot be reordered by accident
    // and so it can be driven with a plain array (#timeline-refactor). It used to be a
    // ~240-line memo that MUTATED its own input rows, so a re-run saw the previous
    // run's writes — the structural reason timeline bugs were intermittent.
    buildTimeline({
      events: events() as TimelineEvent[],
      consumed: pairInfo().consumed,
      pending: pendingMsgs() as PendingEchoLike[],
      echo: echoEv as (p: PendingEchoLike) => TimelineEvent,
      feedTypes: FEED_TYPES,
      renderedTypes: RENDERED_TYPES,
      renderedNoteEvents: RENDERED_NOTE_EVENTS,
    }) as Ev[],
  );
  /**
   * Each row paired with the row ABOVE it, computed once per rebuild.
   *
   * WHY THIS EXISTS (#178): the template used to pass `prev={chatEvents()[i() - 1]}`
   * directly. Inside `<For>`, `i` is a SIGNAL (`mapArray` does `indexes[j] = createSignal(i)`
   * and re-runs `indexes[j](j)` when slots shift), so every one of the ~16,600 rendered rows
   * became a SUBSCRIBER of the whole `chatEvents()` memo through that read. Any change to
   * the timeline therefore re-ran that lookup in every row, and each re-run walked the memo's
   * dependency graph — on a large session the UI was unusable on load.
   *
   * Pairing up front is O(n) once per rebuild and gives each row a plain value: `prev` is
   * then a prop comparison, not a reactive dependency on the entire array. `groupedWith()`
   * only needs the immediately preceding row, so nothing else is lost.
   */
  /**
   * Each row paired with its neighbours, REUSING the wrapper objects.
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
        // #122: was hardcoded "user", so a harness prompt looked like an operator
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
      // #88: saving now shows the RESULT. The button previously left the editor
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
 * #40: the server re-serialises every agent on every poll and WS frame, and a new
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
      // #81: a TOP-LEVEL chat id in this set is a leftover, not a choice.
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
   * Sidebar rows, annotated with where the WORKSPACE changes (#18).
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

  /** collapsed workspace groups in the sidebar (#18) — persisted, like the
   *  sub-agent collapse state above, so a reload keeps the operator's grouping */
  const [wsCollapsed, setWsCollapsed] = createSignal<Set<string>>((() => {
    try {
      const raw = JSON.parse(localStorage.getItem("teapot.wsCollapsed") ?? "[]");
      const keys = Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];

      // #81: migrate keys left by the deleted #18 chat-header row, which wrote
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
   * Sidebar rows with TWO header levels (#18).
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
   * #54: the timeline pairs a tool_call with its tool_result by walking the
   * events it holds, so a window that can contain a result WITHOUT its call
   * strands the bash row at "running…" forever. The server default was raised
   * to 2000 for exactly this, but the UI passed an explicit `limit=300` and
   * therefore never benefited — 300 is small enough that a command streaming
   * one event per delta evicts its own call.
   *
   * A page is cheap (a tail read) and the clamp is server-side, so ask for the
   * size the pairing actually needs rather than a round number that undoes the
   * fix.
   */
  // #54: measured, not guessed. The `/events` window must exceed the largest
  // gap between a `tool_call` and its `tool_result`, or the call is evicted while
  // the command runs and the row can only be rescued by the orphan path.
  //
  // Across every session log: the largest observed gap is **1284** events
  // (wait_children; bash tops out at ~302). Headroom at the worst case is ~716
  // events and **zero** gaps reach 2000, so eviction is not currently reachable.
  //
  // Recorded because this looks like a tuning knob worth "fixing" and is not:
  // raising it costs a bigger fetch on every refresh. If a future session does
  // produce a gap near 2000, that is the signal to raise it — not this comment.
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
      const sessQ = tid && tid !== id ? `&session=${encodeURIComponent(tid)}` : "";
      const res = await api(
        // #77: `lineage=true` here too. The tail fetch asks for it, so a filtered
        // fork's first page shows the INHERITED history; omitting it on the
        // older-pages fetch made scrolling up switch to strict filtering, and the
        // parent's pre-fork rows vanished from the top — reading as data loss,
        // which is exactly what #38 was about.
        `/api/agents/${id}/events?limit=${FEED_PAGE}&before=${encodeURIComponent(oldest.id)}${sessQ}${bf ? `&branch=${encodeURIComponent(bf)}&lineage=true` : ""}`,
      );
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
      const sessQ = tid && tid !== id ? `&session=${encodeURIComponent(tid)}` : "";
      const [ev, br, sk] = await Promise.all([
        // #38: `lineage=true` so a filtered fork shows the history it inherited,
        // matching the context the agent actually reasons over. Filtering by
        // strict branch id showed less than the model sees, which read as data
        // loss even though nothing was missing from the log.
        api(`/api/agents/${id}/events?limit=${FEED_PAGE}${sessQ}${bf ? `&branch=${encodeURIComponent(bf)}&lineage=true` : ""}`),
        needsBranches
          ? api(`/api/agents/${id}/branches`)
          : Promise.resolve({ branches: branches() }),
        api(`/api/agents/${id}/skills`).catch(() => ({ skills: [] })),
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
      setAgentSkills(sk.skills ?? []);
    } catch { /* agent may be gone */ }
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
    setMissed(0);
  }
  function scrollBottom(force = false) {
    if (force || atBottom()) pinToTail();
  }

  // Per-session timeline snapshots: switching back to a recently viewed
  // session restores its last-known rows INSTANTLY, then loadEvents refreshes
  // in the background. Without this, every switch cleared the feed and
  // re-fetched (a visible blank flash + full round trip).
  const timelineCache = new Map<string, { events: Ev[]; total: number; at: number }>();
  const TIMELINE_CACHE_MAX = 6;

  /**
   * The session an agent should open: the one the server says it is BOUND to,
   * falling back to the newest on disk.
   *
   * Taking the newest by mtime is what resurrected a deleted/old session (#39):
   * the list is a directory scan, so a stale dir with a newer chat.jsonl won
   * and the operator's view and the agent's actual timeline disagreed.
   */
  // #141: extracted to a pure, exported function so it can be TESTED.
  //
  // `test/session-switcher.test.ts` used to re-implement this logic in the test
  // file and assert against that copy — three tests, ZERO coverage of shipped
  // code. The logic is pure in (owned sessions, bound session, requested), so
  // there was no reason for it to be a closure.
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
    let tid = latestSessionOf(id, forceSession) ?? id;
    if (prevId !== id || tid !== prevTid) {
      // remember what the outgoing session looked like so returning is instant
      if (prevTid && prevEvents.length) {
        timelineCache.set(prevTid, { events: prevEvents, total: prevTotal, at: Date.now() });
        if (timelineCache.size > TIMELINE_CACHE_MAX) {
          const oldest = [...timelineCache.entries()].sort((x, y) => x[1].at - y[1].at)[0];
          if (oldest) timelineCache.delete(oldest[0]);
        }
      }
      // drop the previous session's timeline immediately — otherwise it stays
      // visible (or bleeds into the merge) until this session's fetch lands,
      // which read as "the old conversation showing up in the new session"
      setEvents([]);
      evCache.clear(); // event ids are per-log (e1, e2…) — never share across sessions
      // #55: the optimistic answer set is per-SESSION. Carrying it across would
      // disable a question that merely reuses a callId, or one the operator
      // has not actually answered in this session.
      clearLocallyAnswered();
      // NOTE: live buffers are per-agent — leaving a session must NOT drop its
      // streaming bubble; the map keeps every session's stream independently.
      setCompacting(null);
      setMissed(0);
      // follow mode must NOT leak across sessions: leaving it false showed
      // "jump to present" on a brand-new/empty timeline whose feed had never
      // been scrolled (the pill only disappears once a real scroll lands)
      setAtBottom(true);
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
    // #87: this used to CLEAR the list, so echoes were lost on every switch and
    // a still-queued message came back looking settled. Save the outgoing
    // session's echoes and restore the incoming session's, like the draft and
    // the timeline cache above.
    writePending(prevTid || prevId || "?", pendingMsgs());
    setPendingMsgs(pendingFor(tid || id));
    localStorage.setItem("teapot.session", id);
    navigate(tid, push); // URL carries the internal session id, not the agent id
    // HYDRATE from cache first: rows paint immediately (no blank flash), and
    // loadEvents below merges in whatever happened since. Cached events are
    // re-stabilized into evCache so reference identity survives the switch.
    const cached = timelineCache.get(tid);
    if (cached?.events.length) {
      // stabilize() re-registers every row under THIS session's scoped keys
      stabilize(cached.events);
      setEvents(stabilize(cached.events));
      setEventsTotal(cached.total);
      requestAnimationFrame(() => {
        if (selected() === id) scrollBottom(true);
      });
    }
    // lazy sessions sit in "stopped" until touched — clicking loads them
    api(`/api/agents/${id}/load`, { method: "POST" }).then(refreshAgents).catch(() => {});
    await loadEvents(id, tid);
    if (selected() !== id) return; // another switch won while we were loading
    // #40: RECONCILE this agent's live buffer against the timeline just loaded.
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
    requestAnimationFrame(() => {
      if (selected() === id) scrollBottom(true);
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
  // the visibilitychange listener is registered ONCE below (outside
  // connectWs) — a reconnect used to add another copy each time, leaking
  // closures and timers with every reconnect cycle
  let onTabVisible: (() => void) | null = null;
  document.addEventListener("visibilitychange", () => onTabVisible?.());
  onCleanup(() => { onTabVisible = null; });
  // the FIRST onopen must not double-load; every later one is a reconnect (#54)
  let firstConnect = true;
  /**
   * After a socket reconnect, fetch only the events we missed (#54).
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
      const sessQ = tid && tid !== id ? `&session=${encodeURIComponent(tid)}` : "";
      const bf = branchFilter();
      const q = `/api/agents/${id}/events?after=${encodeURIComponent(cursor)}${sessQ}${
        bf ? `&branch=${encodeURIComponent(bf)}&lineage=true` : ""
      }`;
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
    // #54: `firstConnect` belongs to a SOCKET, not to the page. Reset it per
    // connection, or a reconnect that itself dropped would be mistaken for the
    // first connect and the resync skipped again — reintroducing the original
    // bug after a single bounce.
    firstConnect = true;
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    const sock = new WebSocket(`${proto}${location.host}/api/ws${wsTokenQuery()}`);
    ws = sock;
    // #54: a reconnect RESYNCS. The server delivers events only to live
    // sockets and replays nothing, so anything logged while the socket was down
    // — a bash tool_result above all — simply never arrived. The feed refresh
    // is otherwise 100% dependent on an unbroken stream, which is why the
    // ordinary HTTP path appeared to work and the socket path did not.
    //
    // The first connect is skipped: select() already loads events, and doing it
    // twice would double every fetch on startup.
    //
    // #54: this flag was NEVER SET TO FALSE, so `!firstConnect` was always false
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
      // #54: a RECONNECT asks only for what it missed.
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
      // #79: the server's ping doubles as a liveness probe — a client that has
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
      // #40: the server sends an AUTHORITATIVE snapshot the moment the socket
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
        // TURN BOUNDARY (#40). The agent's `status` does not change between
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
        // #146: the bubble lives INSIDE a session-scoped timeline, so the delta must
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
            // #131: arm on the first reasoning chunk. Guarded so a mid-stream
            // delta that arrives with NEITHER text nor reasoning cannot re-arm it,
            // which would restart the elapsed time mid-thought.
            if (!thinkStartedAt()) setThinkStartedAt(Date.now());
          } else if (t) {
            // #131: reset only when real TEXT arrives. The old second clause was
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
      if (msg.kind === "event") {
        const et = msg.event?.type;
        const ed = msg.event?.data ?? {};
        // a prompt-delivered note means the text ENTERED an LLM call payload —
        // flip the matching pending echo to "sent"; a prompt-cancelled note
        // drops the echo. BOTH fall through so the feed refresh below picks up
        // the logged prompt row in the same pass (the old early-returns made
        // the "sent ✓" echo linger until some unrelated event refreshed).
        if (et === "system_note" && ed.event === "prompt-delivered" && msg.agentId === selected()) {
          // delivery = the message now belongs to the log row. REMOVE the echo
          // from the list (the display filter alone kept it forever, and any
          // filter regression resurfaced it as a duplicate row).
          writePending(pendingKey(), pendingMsgs().filter((p) => p.promptId !== ed.promptId));
        } else if (et === "system_note" && ed.event === "prompt-cancelled" && msg.agentId === selected()) {
          writePending(pendingKey(), pendingMsgs().filter((p) => p.promptId !== ed.promptId));
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

        // #54: the socket payload IS the data — it is the same object the log
        // wrote, and `mergeEvents` dedupes by id and sorts by seq, so a REST page
        // and a socket event can arrive in either order.
        //
        // It must not be the ONLY path, though: `pairInfo` walks events() in
        // order and can only pair a result with a call it has already seen, and
        // `agentActive` comes from refreshAgents. So merge for immediacy AND
        // refresh for coherence — see the #145 note that follows.
        mergeEvents([msg.event as Ev]);
        // #40: a LOGGED assistant reply covers the live bubble the INSTANT it is
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
        if (msg.event?.type === "message" && (msg.event.data as { role?: string })?.role === "assistant") {
          const buf = live();
          if (buf && isCoveredByLog(buf, events(), sel()?.status)) setLive(null);
        }
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
        await refreshAgents();
        await refreshMetrics();
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
          await loadEvents(selected()!);
          // #40: reconcile the bubble on EVERY pass, NOT inside the
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
      // #139: returning to a VISIBLE tab must verify, not assume.
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
    const url = `/session/${encodeURIComponent(sessionId)}`;
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }
  window.addEventListener("popstate", () => {
    const sid = pathId();
    // resolve the internal id to its owning agent and open THAT agent's tab;
    // the timeline itself is fetched by ?session=<internalId> in loadEvents
    const owner = masterSessionIndex().get(sid);
    // #58: this used to require `owner !== selected()`, which made Back and
    // Forward between two sessions of the SAME agent a no-op — the very case
    // the history entry exists for. Compare the SESSION, not the agent, and let
    // select() ignore a repeat of what is already showing.
    if (owner && (owner !== selected() || sid !== timelineId())) select(owner, false, sid || null);
  });

  /* ---------- small UX niceties ---------- */
  createEffect(() => {
    const a = sel();
    const base = a
      ? `${isSelLive() ? "▶ " : a.status === "error" ? "⚠ " : ""}${a.id} · teapot`
      : "teapot";
    // unread notification count in the tab title — "(2) linux · teapot"
    document.title = unreadCount() > 0 ? `(${unreadCount()}) ${base}` : base;
  });
  /**
   * Is any overlay open? Single source of truth for the keydown handler (#107).
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
      // #107: Escape closes overlays; the shortcut guard below reuses the same
      // predicate so the two cannot disagree about what counts as an overlay.
      if (showNew()) { setShowNew(false); return; }
      if (showCfg()) { setShowCfg(false); return; }
      if (editing()) { setEditing(null); return; }
      // BEFORE the running-agent interrupt (#50): narrow, the drawer is a modal
      // sheet over the content and Escape must close THAT first. It used to
      // fall through to the /stop branch, so with an agent working, Escape
      // stopped the agent and left the panel stuck open.
      if (isNarrow() && showRight()) { closeRight(); return; }
      const s = sel();
      // #59: `live`, not `status` — an agent parked in wait_children reads
      // "idle", and Escape then did nothing at all on a working agent.
      if (s && isSelLive()) {
        // Claude-Code-style: Esc interrupts the running agent
        api(`/api/agents/${s.id}/stop`, { method: "POST" }).then(refreshAgents);
        return;
      }
      return;
    }
    // #107: a single-key shortcut must not fire while ANY overlay is up.
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
      // so `termTabs().length` read afterwards is one past the end (#172)
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

  // #137: re-theme terminals ALREADY OPEN when the theme changes. The reuse path
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
    // #137: a terminal created under a DARK theme kept its palette after the
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
          return;
        }
        if (t.cols !== last.cols || t.rows !== last.rows) {
          last = { cols: t.cols, rows: t.rows };
          w.send(JSON.stringify({ kind: "resize", cols: t.cols, rows: t.rows }));
        }
      };
      // the socket may not have been open for the initial pushResize — send the size now
      w.addEventListener("open", () => pushResize());
      const ro = new ResizeObserver(() => {
        if (resizeTimer[0]) clearTimeout(resizeTimer[0]);
        resizeTimer[0] = setTimeout(pushResize, 250);
      });
      ro.observe(el);
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
  // watching agent B swapped B's terminal away (#10).
  let _termFollowAgent: string | null = null;
  createEffect(() => {
    if (!termOpen()) return;
    const id = selected();
    if (!id) return;
    if (id === _termFollowAgent) return;
    _termFollowAgent = id;
    if (!termTabs().some((t) => t.agentId === id)) {
      // the selected agent has no tab yet (other agents own all tabs).
      // The old code tried focusTab(findIndex→-1) and silently did nothing,
      // leaving the pane stuck on "no shell here" or another agent's shell.
      addTab(id);
    } else {
      // its tab exists — focus the LAST one for it, so returning to an agent
      // lands on the shell you most recently opened rather than its first.
      let last = -1;
      termTabs().forEach((t, i) => {
        if (t.agentId === id) last = i;
      });
      if (last >= 0) focusTab(last);
    }
  });

  // drawer height drag (double-click resets)
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
      // #58: pass the deep-linked session through. `select(initial.id)` alone
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
    const mi = setInterval(() => {
      refreshMetrics();
      loadTasks();
    }, 30_000);
    onCleanup(() => clearInterval(mi));
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
  /**
   * Size the composer to its content, and keep the reader pinned to the tail when THAT
   * resize is what moved the bottom of the feed.
   *
   * ## Why this is not allowed to touch layout on every keystroke (#179)
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
  const autosizeComposer = () => {
    if (!composerEl) return;
    const maximized = composerMaximized();
    // `height: auto` first, or `scrollHeight` never shrinks when text is DELETED — the box
    // would stay at its tallest. This is a write on ONE element, not a feed measurement.
    composerEl.style.height = "auto";
    const wanted = maximized ? -1 : Math.min(composerEl.scrollHeight, MAX_COMPOSER_H);
    // apply it unconditionally: an early return must NOT leave the box at `auto`, which
    // collapses a textarea to its `rows` default and looks like the composer ate the text.
    composerEl.style.height = wanted === -1 ? "" : `${wanted}px`;
    // NOTE (#scroll): this function does NOT touch the feed's scroll position any more.
    //
    // The feed is a flex sibling, so growing this box shrinks the feed's viewport. That is
    // a change to `.feed`'s own BORDER BOX, and the ResizeObserver on the feed (see the
    // #103 effect) sees it — before paint, with the final layout, and for every other cause
    // too (the terminal drawer, the right panel, a window resize).
    //
    // Pinning from HERE was the bug. This runs inside the input handler, i.e. in the same
    // task as the `height` write, and `pinToTail()` resolved `scrollHeight` against a layout
    // that did not yet include the new composer height — so the reader was pinned to the
    // tail as it was when the box still had its OLD height, which is exactly the reported
    // "ちょうど1行の高さまで戻る" (one line of drift, every line added).
  };
  /** the previous scroll sample, for telling a deliberate scroll from a reflow/clamp */
  let lastSample: TailSample | undefined;
  createEffect(() => {
    const v = draft(); // re-run on typing AND after send() clears the draft
    // #the RESIZE must happen AFTER the DOM text is synced, not before. This
    // effect used to run first and call autosizeComposer() straight away, which
    // measured `scrollHeight` of the OLD content: sending a long message left the
    // box at its full multi-line height with nothing in it. `send()` clears the
    // signal, so the order is: write the value, then measure.
    if (!composerEl) return;
    if (!shouldWriteComposerValue(imeInProgress)) return;
    if (composerValueChanged(composerEl.value, v)) composerEl.value = v;
    autosizeComposer();
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
  const sendText = async (text: string, targetId?: string) => {
    const id = targetId ?? selected();
    if (!id) return;
    const images = pendingImages();
    try {
      const r = await api(`/api/agents/${id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, start: true, ...(images.length ? { images } : {}) }),
      });
      // optimistic echo — replaced by the logged event once the feed catches up.
      // promptId links it to the later prompt-delivered note (real LLM payload).
      writePending(pendingKey(), [
        ...pendingMsgs(),
        {
          id: `@p${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          text,
          at: Date.now(),
          promptId: (r as any).promptId,
          ...(images.length ? { images: images.map((i) => i.url) } : {}),
        },
      ]);
      setPendingImages([]);
      // #138: a send exits the maximized composer. It is `position:absolute;
      // inset:0` over the whole column, so leaving it maximized leaves the timeline
      // hidden — and since #134 stopped Enter sending, this is the only way out.
      // Autosize on the next frame: the tall height comes from `.maximized`, so
      // dropping the class alone would leave the textarea expanded.
      if (composerMaximized()) setComposerMaximized(false);
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
       * MEASURED: this used to be `requestAnimationFrame(() => autosizeComposer())`. The
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
    // #134: this USED to restore the normal view on send. The rationale was that
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
          "KEPT — restore any of them from ⚙ settings → archive.",
      )
    )
      return;
    await api(`/api/agents/${id}/archive`, { method: "POST" }).catch(() => {});
    setAgents(agents().filter((a) => !doomed.has(a.id)));
    // the agent is gone, so its session is too — drop the cached index or the UI keeps
    // routing to a session that no longer exists (#39)
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
    <Show when={cfg()?.needsSetup} fallback={null}>
      <SetupWizard onDone={() => location.reload()} />
    </Show>
    <Show when={authLocked()}>
      <div class="overlay">
        <div class="modal" style="max-width:360px">
          <div class="modal-head"><b>🔒 sign in</b><span /></div>
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
            <button type="submit" style="background:var(--acc);border:none;border-radius:6px;color:#fff;padding:7px 12px;cursor:pointer">unlock</button>
            <span class="muted" style="font-size:11px">the token is stored locally and sent as Bearer to this server only</span>
          </form>
        </div>
      </div>
    </Show>
    <Show when={!cfg()?.needsSetup}>
    <div class={"layout" + (showRight() ? "" : " right-hidden")}>
      {/* ---------- sidebar ---------- */}
      <nav class="sidebar">
        <div class="agent-list">
          <For each={sidebarRows()}>
            {(row) => (
              <>
              {/* workspace header: which project this chat belongs to (#18) */}
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
                      so the group reads as N chats rather than one (#18).
                      A COLLAPSED group must always show the count: that is
                      the only thing telling the operator how much is hidden. */}
                  <Show when={(wsChatCounts().get(row.wsHeader!) ?? 0) > 1 || row.wsCollapsedGroup}>
                    <span class="wscount">{wsChatCounts().get(row.wsHeader!) ?? 0}</span>
                  </Show>
                </div>
              </Show>
              {/* A collapsed group shows its header and nothing else (#18); a header row
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
                // #66: a COLLAPSED chat must be selectable. What made it read as
                // unselectable was its APPEARANCE — `opacity: .5` plus
                // `cursor: default`, so a collapsed parent looked greyed out and
                // disabled. That was a styling bug, and it is fixed in the CSS:
                // the name is full-contrast and the row keeps `cursor: pointer`.
                //
                // #85: an earlier version of this ALSO expanded the chat on
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
                    // #81: a top-level chat's subtree is hidden by TWO different
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
                <span class={`dot ${row.a.status}`} />
                <span
                  class={row.a.workspaceMissing ? " ghost" : ""}
                  /* #155: show the session's own title when it has one, so several
                     sessions of one agent are distinguishable at a glance. The id
                     stays visible in the tooltip AND remains the fallback text —
                     a session whose first prompt had no usable line must still
                     render something clickable. */
                  title={
                    row.a.workspaceMissing
                      ? `workspace not found on disk (${row.a.workspace}) — it will be created when this session runs`
                      : (row.a.sessionTitle ?? sessionTitles().get(row.a.session ?? ""))
                        ? `${row.a.sessionTitle ?? sessionTitles().get(row.a.session ?? "")} — ${row.a.id}`
                        : row.a.id
                  }
                >{row.a.sessionTitle ?? sessionTitles().get(row.a.session ?? "") ?? row.a.id}</span>
                {row.a.workspaceMissing ? <span class="ghosttag" title="workspace missing">👻</span> : null}
                <Show when={subtreeUnread(row.a.id) > 0}>
                  <span class="notifbadge" title={`${subtreeUnread(row.a.id)} unread notification${subtreeUnread(row.a.id) > 1 ? "s" : ""} (including sub-agents)`}>
                    🔔{subtreeUnread(row.a.id)}
                  </span>
                </Show>
                {/* Collapsed tree: surface how many subs are hidden so a busy
                    parent doesn't look idle with its subtree away (#81).
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
                    // #98: DESCENDANTS, not just direct children. A sub-agent
                    // that spawned its own was not counted at all, so the badge
                    // understated the subtree and — because the `· ▶N` active
                    // count had the same shape — a busy nested sub read as idle.
                    // This is the same recursion `subtreeUnread` uses, so the
                    // badge and the unread badge can no longer disagree.
                    const kids = descendantsOf(agents(), row.a.id);
                    const running = kids.filter((k) => k.live ?? (k.status === "running" || k.status === "waiting")).length;
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
              🔔<Show when={unreadCount() > 0}><i class="notifdot">{unreadCount()}</i></Show>
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
            {/* 🎨 themes moved into ⚙ settings → appearance: a theme is a PREFERENCE, not a
                per-session action, and the editor (palette rows + a background picker) needs
                room a popover cannot give. */}
            <IconBtn icon="⚙" title="settings" onClick={() => { loadCfg(); setShowCfg(true); }} />
          </div>
          <div class="brand-row">
            <div class="brand">
              🫖 teapot <span class="version">v{__APP_VERSION__}</span>
              <span class={"conn" + (connected() ? " ok" : "")} title={connected() ? "live (websocket)" : "reconnecting…"} />
            </div>
          </div>
          <div class="metrics">
            <Show when={metrics()}>
              master rss {metrics().rssMb}MB · heap {metrics().heapUsedMb}MB<br />
              load1 {metrics().loadavg1} · up {Math.floor(metrics().uptimeSec / 60)}m
            </Show>
          </div>
        </div>
      </nav>

      {/* ---------- channel ---------- */}
      <section class="channel" style={{ "--termh": `${termHeight()}px` } as any}>
        {/* keyed on the agent id: an agent-update snapshot replaces the agent OBJECT, and an
            object-gated Show would rebuild the whole layout (and every focused
            control in it) on every poll (#30). */}
        <Show when={sel()?.id} keyed fallback={<div style="display:grid;place-items:center;height:100%" class="muted">select an agent</div>}>
          <header class="chan-head">
            <span class="hash">#</span>
            <span class="title">{sel()!.id}</span>
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
            <Show when={(sel()!.pendingPromptIds?.length ?? sel()!.pendingPrompts ?? 0) > 0}>
              <span
                class="badge queued"
                title={
                  sel()!.status === "stopped"
                    ? `${sel()!.pendingPromptIds?.length ?? sel()!.pendingPrompts ?? 0} message${(sel()!.pendingPromptIds?.length ?? sel()!.pendingPrompts ?? 0) > 1 ? "s" : ""} from you are still queued, but this agent is STOPPED — nothing will run until you press start (or it is resumed). Each can be withdrawn with ✕ cancel while it is still queued.`
                    : `${sel()!.pendingPromptIds?.length ?? sel()!.pendingPrompts ?? 0} message${(sel()!.pendingPromptIds?.length ?? sel()!.pendingPrompts ?? 0) > 1 ? "s" : ""} from you waiting in the queue. They will be handed to the model at its next turn boundary — the timeline shows them as "pending (queued)…" until then, and each can be withdrawn with ✕ cancel while it's still queued.`
                }
              >
                ⏳ {sel()!.pendingPromptIds?.length ?? sel()!.pendingPrompts} of yours queued{sel()!.status === "stopped" ? " (stopped)" : ""}
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
              {sel()!.model} · {sel()!.session}/{sel()!.branch} · {sel()!.stats.turns}↻ {sel()!.stats.toolCalls}⚙
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
              <IconBtn icon="⑂" title="fork: branch off the conversation here — try things without disturbing the main line" onClick={forkSelected} />
              <IconBtn icon="⌨" title="terminal (t)" onClick={toggleTerm} />
              {/* the panel toggle advertises its STATE, not just its action: `active` fills
                  it when the panel is open, so the button answers "is it showing?" without a
                  click. `aria-expanded` says the same thing to a screen reader. */}
              <IconBtn icon="▤" title="toggle details panel (d)" active={showRight()} onClick={toggleRight} />
              <IconBtn icon="🗄" title="archive this agent — reversible: it leaves the list but keeps its config and history (restore in ⚙ settings → archive)" onClick={archiveSelected} />
            </span>
          </header>

          <div class="feed" ref={(el) => attachFeedObserver(el)} onscroll={(e) => {
            const el = e.currentTarget;
            const now: TailSample = { top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight };
            /**
             * THE FOLLOW STATE, decided from ONE question: did the reader move up?
             *
             * That is the only input, because it is the only thing layout cannot fake.
             * `movedAway()` (frontend/scroll-policy.ts) compares `scrollTop`, and ignores a
             * decrease that came from the browser clamping after a SHRINK — which used to
             * lock follow off after every compaction and every collapsing tool row.
             *
             * Everything else that changes geometry (content arriving below, the live
             * bubble streaming, a tool row expanding, THIS composer growing and shrinking
             * the viewport) leaves `scrollTop` alone and therefore cannot touch the state.
             * That is the whole fix for "typing into a 2-line composer nudges the feed up":
             * the old code re-derived follow from a before/after gap, so a 40px viewport
             * shrink read as "the reader is now away".
             */
            const away = movedAway(now, lastSample);
            const firstSample = lastSample === undefined;
            lastSample = now;
            // the pill reads this instead of measuring the DOM itself
            publishGap(now);
            // reaching the tail re-arms following; leaving it is the only thing that clears
            if (atTail(now)) {
              setAtBottom(true);
              if (missed()) setMissed(0);
              // #160: reaching the tail marks this session read — the scroll itself, not a
              // new event arriving while we happen to be here
              markReadIfFollowing();
            } else if (away || firstSample) {
              // FIRST SAMPLE COUNTS (#send-scroll). `movedAway()` needs a previous sample, so
              // with none it said "not away" — and the follow state therefore stayed TRUE
              // while the reader was a thousand pixels up the timeline. Nothing showed it
              // until the next box change re-pinned them to the tail, which is the reported
              // "送信直後に謎にスクロールする": the send resized the feed, the observer saw
              // `atBottom() === true`, and pinned.
              //
              // A scroll event arriving away from the tail, with the content no taller than
              // when we last looked, IS the reader having moved — there is no third cause.
              // The growth case is still excluded by `away` being false there.
              setAtBottom(false);
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
              <div style="display:grid;place-items:center;height:100%" class="muted">no events yet — say something or press ▶ start</div>
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
                    // #32: only worth labelling when the session HAS more than one
                    // branch (a fork). With a single branch every row repeated the
                    // same constant.
                    showBranch={branches().length > 1}
                    res={() => pairInfo().resFor.get(row.id)}
                    // #54: an unpaired tool_result is rendered as a COMPLETED
                    // tool row of its own — its call fell out of the events
                    // window while the command ran. Without this the result was
                    // a bare anonymous row and the run read as unfinished.
                    orphan={pairInfo().orphanCalls.has(row.id)}
                    onOption={(t) => void sendText(t)}
                    // #55: pass the ACCESSOR, not the Set. A <For> child is a
                    // non-reactive closure, so `answeredQuestionIds()` was
                    // evaluated once when the row was built and never re-read.
                    // The old derivation only ever changed when `events()`
                    // changed, which re-created the rows and hid the bug; an
                    // optimistic answer changes nothing about `events()`, so
                    // the row kept a snapshot from before the click.
                    answeredIds={answeredQuestionIds}
                    onAnswered={markAnswered}
                    // #40: a row showing MIRRORED SUB-AGENT activity is the
                    // child's work, not this agent's, so it must not wear the
                    // parent's live chrome ("writing…", the running blink)
                    // just because the parent happens to be running.
                    agentActive={
                      // #146: the DISPLAYED session must be the live one, not
                      // merely the same agent (#120, #133)
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
                      // #122: only an OPERATOR prompt can be withdrawn. A harness
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
                      // settled user prompts only: a pending message has not
                      // reached the model, so there is nothing to fork from —
                      // cancel (✕) returns its text to the composer instead.
                      // A withdrawn message likewise never reached the model.
                      row.type === "prompt" &&
                      row.data?.source === "user" &&
                      !(row.data?.pending && row.data?.sent !== true) &&
                      !row.data?.cancelled &&
                      // #129: do NOT offer the editor while the agent is live.
                      //
                      // `editPromptAt` refuses a running agent ("agent is running —
                      // stop it before editing history"), so the button opened a modal
                      // whose only possible submission was a 409. The modal then sat
                      // over the controls: Escape closed the MODAL rather than stopping
                      // the agent (that ordering is deliberate, #107), so the operator
                      // pressing stop appeared to do nothing until a reload.
                      //
                      // The server-side guard is correct and stays; this just stops
                      // offering an action that cannot succeed.
                      !isSelLive()
                        ? () => setEditing({ eventId: row.id, text: String(row.data?.text ?? "") })
                        : undefined
                    }
                  />
                )}
              </For>
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
                  // #160: pressing "jump to present" IS reading the tail — the
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
                  // #134: a MAXIMIZED composer takes Enter as a newline.
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
                  if (e.key === "Enter" && !e.shiftKey && !imeInProgress && !composerMaximized()) {
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
             * ⚙ settings → ❔ help, where it is found when it is needed; a keyboard reference is
             * something you consult, not something you stare at while typing.
             */}
            <Show when={flash()}>
              <div class="hint">{flash()}</div>
            </Show>
          </div>
        </Show>
      </section>

      {/* ---------- right bar ---------- */}
      {/* Drawer-only close row (#50). In wide mode .rightbar is a grid column
          that sits next to the content, and the ▤ button in the channel header
          is right there — so this row stays `display:none` (see app.css) and
          costs a wide-screen user nothing. Narrow, the panel is a fixed drawer
          covering up to 92vw of the screen; it covers the ▤ button that opened
          it, leaving NO visible way back out. This is that way out. */}
      {/* Click-outside dismiss for the drawer (#50). Mirrors .notifbackdrop:
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
        {/* Close row (#50) — INSIDE the panel, and sticky so the panel's own
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
        {/* Gated on the agent ID, not the agent OBJECT (#30). `when={sel()}`
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

          <h3 title="switch provider/model live — applies from the agent's next turn; the list shows context window & pricing from the provider">🧦 model</h3>
          <div class="modelbox">
            <select
              value={modelProvider()}
              onchange={(e) => {
                // #3: switching provider must SELECT that provider's default
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
                      them (#150): a model advertising ["max","high","low"] must not be
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
            <div class="meta">
              current: {sel()!.model}<Show when={models().length}> · {models().length} models loaded</Show>
            </div>
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
            <div class="card">
              <div class="content" innerHTML={renderMarkdown(String(sel()!.goal.text))} />
            </div>
            <Show when={sel()!.goal.verify}>
              <div class="card verifycard" title="verification contract — finish(goalComplete=true) is audited against these requirements by an independent reviewer before the goal counts as done">
                <div class="vtitle">🔍 verification contract</div>
                <div class="content" innerHTML={renderMarkdown(String(sel()!.goal.verify))} />
              </div>
            </Show>
            <Show when={sel()!.goal.audit}>
              {(a) => (
                <div class={"card auditcard " + (a().verdict === "approved" ? "ok" : "warn")}>
                  <div class="vtitle">
                    {a().verdict === "approved" ? "✅ audit: approved" : "⚠ audit: changes required"}
                    <span class="meta muted" style="margin-left:auto">{relTime(a().at)}</span>
                  </div>
                  {/* #51: the auditor can return a verdict with no reason.
                      An empty card says less than an honest one-liner. */}
                  <div
                    class="content"
                    innerHTML={
                      isPlaceholderDetail(a().feedback)
                        ? renderMarkdown("_the auditor returned a verdict with no detail_")
                        : renderMarkdown(a().feedback)
                    }
                  />
                </div>
              )}
            </Show>
          </Show>
          {/* the explanation is the heading's tooltip: it never changes, so printing it under
              the goal permanently costs a line in the panel every time the operator looks */}
          <form onsubmit={setGoal} style="display:flex;flex-direction:column;gap:6px;margin-top:8px;margin-bottom:6px">
            <textarea
              id="goal-input"
              rows={3}
              placeholder="set new goal…"
              value={goalDraft()}
              oninput={(e) => { setGoalDraft(e.currentTarget.value); setGoalDirty(true); }}
              style="background:var(--bg-darkest);border:none;border-radius:6px;padding:6px 8px;color:var(--fg);font:inherit;width:100%;resize:vertical"
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
              <button type="submit" style="background:var(--acc);border:none;border-radius:6px;color:#fff;padding:4px 12px;cursor:pointer">✓ save goal</button>
            </div>
          </form>

          <h3 title="todo.md — a shared checklist in the session dir. Write tasks like '- [ ] fix login'; the agent ticks them off via set_todo, you edit here. With notify on, it's told at its next turn boundary.">
            ✅ tasks
            <Show when={todoStats().total > 0}>
              <span class="badge" style={todoStats().done === todoStats().total ? "color:var(--ok)" : "color:var(--warn)"}>
                {todoStats().done}/{todoStats().total} done
              </span>
            </Show>
            <span class="muted" style="text-transform:none;letter-spacing:0">· shared checklist (you + agent)</span>
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
              style="background:var(--ok);border:none;border-radius:6px;color:#fff;padding:4px 12px;cursor:pointer"
            >✓ save tasks</button>
          </div>

          <h3 title="latest report_progress snapshot. The harness asks for one after real activity (time AND output gates); errors show under ⚠ problems">📈 progress</h3>
          <Show
            when={sel()!.latestProgress}
            fallback={<div class="muted">none yet — the harness asks for a report after real activity, and the agent can report_progress anytime</div>}
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
              <div class="rtcell" title="tokens billed this session: prompt (in) and completion (out)">
                <span>tokens</span>
                <b>{fmtK(sel()!.stats.inputTokens)}<span class="rtsep">/</span>{fmtK(sel()!.stats.outputTokens)}</b>
                <em>in / out</em>
              </div>
              <div class="rtcell" title="assistant turns and tool calls made this session">
                <span>turns</span>
                <b>{sel()!.stats.turns}<span class="rtsep">/</span>{sel()!.stats.toolCalls}</b>
                <em>turns / tools</em>
              </div>
              <div
                class="rtcell"
                title={`how many times old turns were summarized into notes to make room. ${sel()!.stats.compactions ? "Each one keeps the recent stretch verbatim." : "Not yet — the context has fit so far."}`}
              >
                <span>compacted</span>
                <b>{sel()!.stats.compactions ?? 0}</b>
                <em>{sel()!.stats.compactions ? "times" : "never"}</em>
              </div>
              <Show when={(sel()!.stats.costUsd ?? 0) > 0}>
                <div
                  class="rtcell"
                  title={`≈ ${(sel()!.stats.costUsd ?? 0).toFixed(4)} this session, from the model's USD/token pricing and per-turn usage. Cached input is estimated at ~10% of the prompt rate; treat as an approximation, not an invoice.`}
                >
                  <span>cost</span>
                  <b>${costFmt(sel()!.stats.costUsd ?? 0)}</b>
                  <em>this session</em>
                </div>
              </Show>
              <Show when={(sel()!.stats.cachedInputTokens ?? 0) > 0}>
                <div
                  class="rtcell"
                  title={`${fmtK(sel()!.stats.cachedInputTokens)} input tokens were served from the provider's prompt cache — billed far cheaper than fresh input`}
                >
                  <span>cached</span>
                  <b>{Math.round((sel()!.stats.cachedInputTokens / Math.max(1, sel()!.stats.inputTokens)) * 100)}%</b>
                  <em>of input</em>
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
                inherited rows and read as data loss (#38). */}
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
                  // filter is discarded rather than landing in this one (#38).
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
          <h3 title="cron tasks, all agents — click a row to open that agent. Edit them in ⚙ settings → scheduled tasks.">
            ⏰ schedule
            <Show when={tasks().length > 0}>
              <span class="muted" style="text-transform:none;letter-spacing:0">· {tasks().length} · all agents</span>
            </Show>
          </h3>
          <Show
            when={tasks().length > 0}
            fallback={<div class="muted">no scheduled tasks — add them in ⚙ settings ("scheduled tasks")</div>}
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
    </Show>
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
                    <span class="nicon">{n.kind === "finish" ? "✅" : n.kind === "question" ? "❓" : n.kind === "error" ? "⚠️" : "📈"}</span>
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
        onSaved={() => {
          loadCfg();
          loadTasks();
        }}
        // theme state lives in App (it paints `<html>`), so the appearance panel edits it
        // through these rather than keeping a second copy that would drift
        theme={{
          themes: customThemes,
          activeId: fixedTheme,
          auto: themeAuto,
          setAuto: setThemeAuto,
          dark: sysDarkTheme,
          setDark: setSysDarkTheme,
          light: sysLightTheme,
          setLight: setSysLightTheme,
          setThemes: setCustomThemes,
          setActive: setFixedTheme,
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
                <button type="submit" style="background:var(--acc);border:none;border-radius:6px;color:#fff;padding:6px 12px;cursor:pointer">
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
function BashElapsed(props: { startedAt: string; inline?: boolean; timeoutMs?: number }) {
  const start = new Date(props.startedAt).getTime();
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    // 500ms tick is plenty for a seconds readout and stops with the row
    const t = setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => clearInterval(t));
  });
  // shares fmtDur() with the finished rows so a running call and its result
  // read identically instead of flipping between two formats (#24)
  const txt = () => fmtDur(Math.max(0, now() - start));
  // inline: compact form for the folded summary ("running… 1m 26s")
  if (props.inline) {
    return (
      <span class="bashelapsed">
        running… {txt()}
        {props.timeoutMs ? ` · timeout ${Math.round(props.timeoutMs / 1000)}s` : ""}
      </span>
    );
  }  return <span class="bashelapsed">{txt()} elapsed</span>;
}

/** Live elapsed-seconds readout for the current thinking stretch. */
function ThinkingTimer(props: { startedAt: number }) {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => clearInterval(t));
  });
  // #131: `startedAt` is 0 until a reasoning delta arms the clock, which is the
  // state right after a session switch. `now() - 0` is elapsed since the EPOCH, so
  // it flashed "thinking 497531h". 0 is a sentinel, never a timestamp.
  if (!props.startedAt) return null;
  return <span class="thinktimer">{fmtDur(Math.max(0, now() - props.startedAt))}</span>;
}

/* ---------- per-tool timeline rendering ---------- */

function ToolRow(props: { e: Ev; prev?: Ev; res?: () => Ev | undefined; orphan?: boolean; agentActive?: boolean; onResize?: () => void }) {
  const e = props.e;
  // GROUPING (#75 pattern, again). `groupedWith()` is the shared rule and it
  // ALWAYS said these two bash calls group — but ToolRow never received `prev`, so
  // the rule never ran for tool rows and every one of them rendered a full head:
  //
  //     embed class="embed done" summary="⚙ $ echo ALPHA3ms…"
  //     embed class="embed done" summary="⚙ $ echo BETA3ms…"     <- reported
  //
  // Measured by dumping the real bundle in happy-dom, not by reading code: the
  // helper was right and the CALL was missing. A run of commands therefore read as
  // a stack of unrelated blocks, which is the "timeline is cluttered" complaint.
  const grouped = groupedWith(props.prev as RowLike | undefined, e as RowLike);
  // #54: read the result prop REACTIVELY. `<For each={chatEvents()}>` builds the
  // row while its result is still undefined, and a destructured `const res =
  // props.res` is bound once — so the row kept rendering "running…" forever when
  // the result arrived.
  //
  // `props.res` is now an ACCESSOR from the caller, not a value: `pairInfo()` re-runs on
  // every append, so passing `pairInfo().resFor.get(id)` inline re-evaluated the prop and
  // re-built this row's whole JSX tree — harmless for a label, fatal for a `<pre>` whose
  // scroll offset lives on the element. MEASURED: a scrolled bash-output block lost its
  // offset whenever an unrelated message arrived, with the row ELEMENT itself reused. An
  // accessor makes the row's tree a one-time build that reads a fresh value on demand.
  const res = () => props.res?.();
  // STALE-RUN GUARD: if the agent is no longer running, an unpaired tool_call
  // cannot still be in flight (its result event was missed — e.g. logged while
  // the tab was hidden). Rendering it forever as "running…" was exactly that:
  // switching sessions and back "fixed" it because that reloaded the log.
  //
  // #54: this must be a FUNCTION, not a value. Computed once in the component
  // body it captured `props.agentActive` as it was when the row was BUILT — i.e.
  // `true`, because a row only exists because the agent was working — so the
  // guard could never fire. It was written to close exactly this bug and could
  // not, which is why the issue kept coming back.
  const staleDone = () => !props.agentActive && !res();
  const d = e.data ?? {};
  const name = String(d.name ?? "tool");
  const out = () => String(res()?.data?.result ?? "");

  const argStr = (k: string) => String(d.args?.[k] ?? "");
  // best-effort "what was run" text per tool: bash→the command, others→path/args
  const cmdText = () => {
    if (name === "bash") return argStr("command");
    return argStr("path") || JSON.stringify(d.args ?? {}, null, 1);
  };
  // effective timeout for live elapsed display — tools with defaults that the
  // model omitted (wait_children: 5 min) still show their real cap
  const effTimeout = () => {
    if (name === "bash") return Number(argStr("timeout_ms")) || undefined;
    if (name === "wait_children") return Number(argStr("timeout_ms")) || 300_000;
    return Number(argStr("timeout_ms")) || undefined;
  };
  const codeBlock = (text: string, max = 1500) => (
    <pre class="mono toolbody">{truncate(text, max)}</pre>
  );
  const resultBlock = (max = 4000) =>
    (() => {
      const r = res();
      return r ? (
      <>
        {codeBlock(out(), max)}
        <div class="meta">
          {fmtDur(r.data?.durationMs)}
          {/* #46: a killed shell said nothing here beyond a generic · FAILED, so
              a TIMED OUT command still read as an ordinary completed run. */}
          {name === "bash"
            ? outcomeMarker(shellOutcome(r.data?.ok, String(r.data?.result ?? "")))
            : r.data?.ok === false
              ? " · FAILED"
              : ""}
          <CopyBtn text={out()} />
        </div>
      </>
    ) : (
      <div class="meta">waiting for output…</div>
    );
    })();

  // #54: this whole derivation depends on the result, so it must be a MEMO. It used to
  // run once in the component body, which is why a row created before its result
  // arrived kept the pre-result label and body for good: only the class (re-read
  // from the prop) changed. See the note on `res` above.
  /**
   * The per-tool summary AND its body, built once per RESULT.
   *
   * `body` is a JSX value, so every re-run of this memo builds a NEW element tree — and a
   * `<pre>` replaced that way loses its scroll offset even when the row element itself is
   * reused. MEASURED: a scrolled bash-output block reset whenever an unrelated message
   * arrived, with `ownerWasReused=true`.
   *
   * Two things were needed:
   *
   *  1. read `res()` through a local so the memo's dependencies are explicit;
   *  2. give `createMemo` an `equals` that compares the RESULT ID. Without it the memo's
   *     return value is a fresh `{label, hint, body}` object every run, which never equals
   *     the previous one, so Solid re-rendered the body on every `pairInfo()` recompute —
   *     and `pairInfo()` recomputes on every append, because its `resFor` Map is new even
   *     when the `Ev` inside it is the same object.
   *
   * With the `equals`, the only re-run left is a result that actually changed, which is
   * exactly when the body must be rebuilt.
   */
  const derived = createMemo(
    () => {
  const r = res();
  void r;
  // per-tool summary line: [label, hint]. There is no icon: the default was "⚙" for
  // every tool and no case ever overrode it, so it identified nothing — the tool NAME
  // is already in the row's author slot, and a grouped row showed no ⚙ at all, which is
  // the inconsistency this removes.
  let label = name;
  let hint: string | null = "";
  let body: any = <div class="mono">{truncate(JSON.stringify(d.args ?? {}, null, 1), 2000)}</div>;
  try {
    switch (name) {
      case "bash": {
        const cmd = argStr("command");
        const isBg = d.args?.background === true;
        // background jobs return INSTANTLY (the shell keeps running) — a plain
        // "$ cmd · 12ms" row read as "finished immediately" and the job was
        // forgotten. Give them their own identity + the job id for bash_output.
        const bgJob = isBg ? (String(out()).match(/job (bg\d+)/)?.[1] ?? "") : "";
        label = (isBg ? "⏳ " : "$ ") + oneLine(cmd, 96);
        const timeoutMs = argStr("timeout_ms") ? Number(argStr("timeout_ms")) : undefined;
        // #46: a command the harness KILLED used to render as
        // `300ms · timeout 1s` — indistinguishable from a fast success, so the
        // row never read as finished. Name the outcome on the summary line.
        const r = res();
        const outcome = shellOutcome(r?.data?.ok, r ? String(r.data?.result ?? "") : "");
        hint = r
          ? isBg
            ? `background job${bgJob ? ` ${bgJob}` : ""}${timeoutMs ? ` · timeout ${Math.round(timeoutMs / 1000)}s` : ""}`
            : shellHint({ outcome, durationMs: r.data?.durationMs, timeoutMs, fmtDur })
          : null; // live elapsed renders in the summary (below)
        body = (
          <>
            {isBg ? (
              <div class="meta bgjob-note">
                runs in background — poll with <b>bash_output(job_id=&quot;{bgJob || "?"}&quot;)</b>
                {bgJob ? <> · kill with <b>action="kill"</b></> : null}
              </div>
            ) : null}
            {cmd !== label.slice(isBg ? 2 : 2) ? codeBlock(cmd, 800) : null}
            {resultBlock(6000)}
          </>
        );
        break;
      }
      case "read_file": {
        label = argStr("path") || "(no path)";
        const bits: string[] = [];
        if (argStr("pattern")) bits.push(`grep /${oneLine(argStr("pattern"), 40)}/`);
        if (Number(d.args?.offset) < 0) bits.push(`last ${-Number(d.args.offset)} lines`);
        else if (d.args?.offset) bits.push(`from L${d.args.offset}`);
        if (d.args?.limit) bits.push(`≤${d.args.limit} lines`);
        hint = bits.join(" · ");
        body = resultBlock(6000);
        break;
      }
      case "write_file": {
        const content = String(d.args?.content ?? "");
        label = argStr("path") || "(no path)";
        hint = `${fmtK(content.length)} bytes`;
        // content was rendered UNTRUNCATED — a few big write_file calls (the
        // 100KB+ ones real sessions accumulate) made those chats take seconds
        // to open and chew CPU on every prepend while scrolling back
        body = (
          <>
            {codeBlock(content, 1500)}
            {content.length > 1500 ? <div class="meta muted">{fmtK(content.length)} bytes — open it from 🗂 files for the full view</div> : null}
            {res() ? <div class="meta">{oneLine(out(), 160)}</div> : <div class="meta">writing…</div>}
          </>
        );
        break;
      }
      case "edit_file": {
        label = argStr("path") || "(no path)";
        hint = d.args?.replace_all === true ? "replace all" : "unique spot";
        body = (
          <>
            <pre class="mono toolbody del">{truncate("- " + argStr("old_text"), 900)}</pre>
            <pre class="mono toolbody add">{"+ " + truncate(argStr("new_text"), 900)}</pre>
            {res() ? (
              <div class="meta">
                {oneLine(out(), 120)} · {fmtDur(res()!.data?.durationMs)}
              </div>
            ) : (
              <div class="meta">applying…</div>
            )}
          </>
        );
        break;
      }
      case "apply_patch": {
        const patchLines = argStr("patch").split("\n").filter((l) => l && !/^---$/.test(l.trim()));
        const files = patchLines
          .map((l) => l.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)?.[1])
          .filter(Boolean) as string[];
        label = files.length ? `${files.length} file${files.length > 1 ? "s" : ""}: ${oneLine(files.join(", "), 80)}` : "patch";
        // huge patches rendered one <div> PER LINE with no cap — multi-thousand-
        // line patches froze the feed. Show the head; the rest is noise here.
        const MAX_PATCH_LINES = 60;
        const shown = patchLines.slice(0, MAX_PATCH_LINES);
        body = (
          <>
            <pre class="mono toolbody patch">
              {shown.map((l) => {
                const cls = l.startsWith("+") ? " add" : l.startsWith("-") ? " del" : /^\*\*\*|^@@/.test(l) ? " meta" : "";
                return <div class={"pline" + cls}>{l.length > 240 ? l.slice(0, 240) + "…" : l}</div>;
              })}
              {patchLines.length > MAX_PATCH_LINES ? <div class="pline meta">… {patchLines.length - MAX_PATCH_LINES} more lines</div> : null}
            </pre>
            {res() ? <div class="meta">{oneLine(out().split("\n")[0] ?? "", 140)}{res()!.data?.ok === false ? " · FAILED" : ""}</div> : <div class="meta">validating…</div>}
          </>
        );
        break;
      }
      case "list_dir": {
        label = argStr("path") || ".";
        body = resultBlock(4000);
        break;
      }
      case "read_url": {
        let host = argStr("url");
        try { const u = new URL(host); host = u.host + u.pathname; } catch { /* keep raw */ }
        label = oneLine(host, 70);
        hint = "web";
        body = (
          <>
            <div class="meta">
              <Show
                when={/^https?:/i.test(argStr("url"))}
                fallback={<span class="muted">{oneLine(argStr("url"), 80)}</span>}
              >
                <a href={argStr("url")} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">open ↗</a>
              </Show>
            </div>
            {resultBlock(3000)}
          </>
        );
        break;
      }
      case "bash_output": {
        // reading vs killing reads differently at a glance
        const action = argStr("action") || "read";
        const jobId = argStr("job_id") || "(?)";
        label = `bash_output ${jobId}`;
        hint = action;
        body = resultBlock(4000);
        break;
      }
      case "load_skill": {
        label = `skill: ${argStr("name")}`;
        const mdBody = out().replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""); // strip frontmatter
        body = res() ? (
          <>
            <div class="content" innerHTML={renderMarkdown(mdBody)} />
            <div class="meta">{fmtDur(res()!.data?.durationMs)}</div>
          </>
        ) : (
          <div class="meta">loading…</div>
        );
        break;
      }
      case "save_skill": {
        label = `skill: ${argStr("name")}`;
        hint = oneLine(argStr("description"), 60);
        const files = Array.isArray(d.args?.files) ? d.args.files.map((f: any) => f?.name).filter(Boolean) : [];
        body = (
          <>
            {files.length ? <div class="meta">bundled: {files.join(", ")}</div> : null}
            {res() ? <div class="meta">{oneLine(out(), 160)} · {fmtDur(res()!.data?.durationMs)}</div> : <div class="meta">saving…</div>}
          </>
        );
        break;
      }
    }
  } catch {
    /* fall back to the generic view on anything unexpected */
  }
    // `key` is what the memo's `equals` compares: the RESULT's identity plus the label. Two
    // runs that would build the same body must produce the same key, or the `<pre>` inside is
    // discarded and its scroll offset with it.
    return { label, hint, body, key: `${res()?.id ?? "none"}|${label}|${hint ?? ""}` };
    },
    undefined,
    {
      // compare the RESULT the memo was built from, not the returned object (which is always
      // a fresh `{label, hint, body}` and would therefore never compare equal)
      equals: (a, b) => (a as { key?: string }).key === (b as { key?: string }).key,
    },
  );

  return (
    <details
      class={"embed" + (grouped ? " grouped" : "") + (res() ? (res()!.data?.ok === false ? " fail" : " done") : staleDone() ? " done" : " running")}
      title={`${name}${derived().hint ? " — " + derived().hint : ""}`}
      onToggle={(ev: ToggleEvent) => {
        // expanding/collapsing changes the feed height; while following, the
        // bottom line must stay pinned instead of drifting out of view
        if ((ev.target as HTMLDetailsElement).open) props.onResize?.();
      }}
    >
      <summary>
        {/* A GROUPED row keeps its command (you still need to know what ran) but drops
            the repeated marker, so a run of commands reads as one block instead of N
            unrelated ones (#75). The label already carries its own marker ("$ ", "⏳ "). */}
        <b>{derived().label}</b>
        <Show when={e.data?.actor}>
          <span class="actor">@{String(e.data.actor)}</span>
        </Show>
        <span class="meta">
          {res()
            ? derived().hint || ""
            : staleDone()
              ? "(result missed)"
              : name === "bash" || effTimeout()
                ? // any tool with a timeout shows live elapsed + its cap
                  <BashElapsed startedAt={e.ts} inline timeoutMs={effTimeout()} /> // visible while folded
                : "running…"}
        </span>
        {/* dedicated copy buttons: the generic header "copy" copied "" on tool
            rows (rawOf only knows prompts/messages) — now the command that ran
            and its output each have their own button */}
        <span class="toolcopy">
          <CopyBtn text={cmdText()} label="⧉ cmd" title={`copy the ${name} arguments`} />
          <Show when={res()}>
            <CopyBtn text={out()} label="⧉ out" title="copy this tool's full output" />
          </Show>
        </span>
      </summary>
      {derived().body}
    </details>
  );
}

/** The un-rendered source text of a chat row — what "copy raw" should give. */
function rawOf(e: Ev): string {
  const d = e.data ?? {};
  if (e.type === "prompt") return String(d.text ?? "");
  if (e.type === "message") {
    // include reasoning when present, separated, so nothing is lost
    const r = typeof d.reasoning === "string" && d.reasoning.trim()
      ? `<reasoning>\n${d.reasoning}\n</reasoning>\n\n`
      : "";
    return `${r}${String(d.content ?? "")}`;
  }
  if (e.type === "tool_call") {
    // the header copy button used to sit on tool rows too and copied ""
    // (rawOf only knew prompts/messages) — tool rows get dedicated
    // command/output buttons inside ToolRow instead, so nothing here
    return "";
  }
  return "";
}

function MessageRow(props: { e: Ev; prev?: () => Ev | undefined; next?: () => Ev | undefined; res?: () => Ev | undefined; orphan?: boolean; showBranch?: boolean; onEdit?: () => void; onCancel?: () => void; onOption?: (text: string) => void; answeredIds?: () => Set<string>; onAnswered?: (callId: string) => void; agentActive?: boolean; onResize?: () => void }) {
  const e = props.e;
  const a = authorOf(e);
  // Grouping is `groupedWith()` from ./row-grouping — extracted so the rule can
  // be tested against the code that runs (#75). It used to live inline here,
  // and the tests re-implemented it, which is why deleting the real #49 fix left
  // them all green.
  const grouped = () => groupedWith(props.prev?.() as RowLike | undefined, e as RowLike);
  /**
   * Whether the row BELOW continues this run — computed here rather than in CSS.
   *
   * The spacing around a run needs three facts: is this a continuation (`grouped`), does a
   * continuation follow, and does one follow THIS row. `:has(+ .msg.grouped)` could answer
   * the last two, but it makes the style engine run a sibling-matching pass for EVERY row on
   * every style recalc — and this feed renders ~1,100 rows on open (#178). The component
   * already knows the next event, so the answer is free here and the selector disappears.
   */
  const nextGrouped = () => {
    const n = props.next?.();
    return !!n && groupedWith(e as RowLike, n as RowLike);
  };

  // non-chat-looking events become divider lines
  if (e.type === "fork") {
    const d = e.data ?? {};
    return (
      <div class="divider-msg">
        ⑂ forked from {String(d.fromBranch ?? "?")} → {String(d.newBranch ?? e.branch)}
      </div>
    );
  }
  if (e.type === "goal") {
    // #41: the finish→audit→continue lifecycle used to render as bare labels
    // with an EMPTY body ("🎯 goal audit:"), hiding the verification contract
    // and the verdict. Every branch now carries a real detail, and "done" is
    // labelled as PENDING audit because it is logged before the audit runs.
    //
    // #51: the label and this card were children of `.divider-msg`, which is
    // `display:flex` with ::before/::after filling the slack — so the card was
    // a FLEX SIBLING of the label and everything shared one row, with the
    // card's left edge wherever the flex layout put it. `.goalline` stacks them
    // instead: label on its own line, card beneath, both aligned to the same
    // left edge as every other card in the feed.
    const line = goalLine(e.data ?? {});
    return (
      <div class={"goalline " + (line.tone === "err" ? "err" : line.tone === "warn" ? "warn" : "")}>
        <div class="goalline-label">{line.label}</div>
        {/* an empty detail means "nothing real to show" — the label stands
            alone rather than getting a placeholder card (#51). `hasCard` is
            the explicit flag, so this is never a guess from an empty string. */}
        <Show when={line.hasCard}>
          <div
            class={"card " + (line.tone === "ok" ? "auditcard ok" : line.tone === "warn" ? "auditcard" : "verifycard")}
            innerHTML={
              line.markdown
                ? renderMarkdown(line.detail)
                : renderMarkdown(`\`\`\`\n${line.detail}\n\`\`\``)
            }
          />
        </Show>
      </div>
    );
  }
  if (e.type === "todo") {
    return <div class="divider-msg">✅ tasks updated ({String(e.data?.by ?? "human")})</div>;
  }
  if (e.type === "state") {
    if (e.data.from === e.data.to) return null;
    return (
      <div class={"divider-msg" + (e.data.to === "error" ? " err" : "")}>
        {e.data.from} → {e.data.to}{e.data.reason ? ` — ${e.data.reason}` : ""}
      </div>
    );
  }
  // system_note MUST resolve here (before the .msg wrapper): the wrapper
  // always renders an avatar + empty body, so notes handled only inside
  // SwitchContent appeared as mysterious EMPTY rows on the timeline.
  // Most notes are log-only; these few earn a visible divider/embed row.
  if (e.type === "system_note") {
    const ev = String(e.data?.event ?? "");
    if (ev === "runaway-detected") {
      return (
        <div class="embed fail" title={`${e.data?.failures} consecutive tool failures hit the configured limit (${e.data?.limit})`}>
          <div class="mono">🛑 runaway: {String(e.data?.failures)} tool failures in a row (limit {String(e.data?.limit)})</div>
          <div class="meta">last: {String(e.data?.lastTool)} — {String(e.data?.lastError ?? "").slice(0, 200)}</div>
        </div>
      );
    }
    if (ev === "error-retry") {
      return (
        <div class="embed warn-embed" title="a round-fatal API error occurred; auto-retry is waiting, then a fresh round starts (onError: retry)">
          <div class="mono">↻ API error — retrying (attempt {String(e.data?.attempt)}) in {Math.round(Number(e.data?.waitMs) / 1000)}s…</div>
        </div>
      );
    }
    if (ev === "background-exit") {
      const failed = e.data?.failed === true;
      const secs = Math.round(Number(e.data?.durationMs ?? 0) / 1000);
      return (
        <div class={"divider-msg" + (failed ? " err" : "")} title={String(e.data?.cmd ?? "")}>
          {(failed ? "⚠ background job " : "✓ background job ") +
            String(e.data?.jobId ?? "?") + " " +
            (failed ? `FAILED (exit ${String(e.data?.code ?? "?")})` : `finished (${secs}s)`)}
        </div>
      );
    }
    if (ev === "context-compacted") {
      return (
        <div class="divider-msg">
          🗜 compacted: {String(e.data?.tokensBefore ?? "?")} → {String(e.data?.tokensAfter ?? "?")} tok ({String(e.data?.mode ?? "")})
        </div>
      );
    }
    // #56: the START of the pass, logged before the (slow) summarizer runs so
    // the timeline shows the conversation being rewritten rather than going
    // quiet for the whole summarize. The completion divider above carries the
    // after-figures; this one only claims what was already known.
    if (ev === "context-compaction-started") {
      return (
        <div class="divider-msg" title="compaction is rewriting older history — the agent is not stuck">
          🗜 compacting: summarizing {String(e.data?.messages ?? "?")} earlier messages from{" "}
          {String(e.data?.tokensBefore ?? "?")} tok ({String(e.data?.reason ?? "auto")})…
        </div>
      );
    }
    return null; // log-only notes (prompt-delivered, llm-retry, …)
  }

  return (
    <div
      class={
        "msg" +
        (grouped() ? " grouped" : "") +
        // the row BELOW continues this run — replaces a `:has(+ .msg.grouped)` selector,
        // which made every row pay for a sibling match on every recalc (#178)
        (nextGrouped() ? " next-grouped" : "") +
        (e.data?.pending ? " pending" : "") +
        (e.data?.cancelled ? " withdrawn" : "")
      }
      data-eid={e.id}
    >
      {/* grouped rows keep the same geometry as the row that started the
          run — same avatar slot, but EMPTY (no faded ghost icon): a column of
          faint 🧩s read as separate "sub messages" instead of continuation
          lines. Hover still shows time+branch via the title. */}
      <div
        class={"avatar avghost" + (grouped() ? " ghosted" : "")}
        style={{ background: grouped() ? "transparent" : a.color + "33", border: grouped() ? "1px solid transparent" : `1px solid ${a.color}66` }}
        title={grouped() ? `${fmtTs(e.ts)} · ${e.branch}` : undefined}
      >
        {grouped() ? "" : a.icon}
      </div>
      <div class="msg-body">
        {grouped() && <span class="grouptime" title={`${fmtTs(e.ts)} · ${e.branch}`} />}
        <Show when={!grouped()}>
          <div class="msg-head">
            <span class="author" style={{ color: a.color }}>{a.name}</span>
            <Show when={e.data?.actor}>
              <span class="actor">@{String(e.data.actor)}</span>
            </Show>
            <span class="ts">{e.data?.pending ? "queued…" : e.data?.cancelled ? "withdrawn" : fmtTs(e.ts)}</span>
            {/* #32 (clutter): the branch label is constant for a whole session and
                was repeated on EVERY row — MEASURED, all 14940 events of this
                session carry `br0`, so ~1500 rendered rows said "br0" for no
                information. Show it only when the session actually HAS more than
                one branch (a fork), which is the only time it distinguishes
                anything. It stays in the row title, and in the branch picker. */}
            <Show when={props.showBranch}>
              <span class="ts">{e.branch}</span>
            </Show>
            <Show when={props.onCancel}>
              <button
                class="editbtn"
                title="withdraw this message — it has not reached the model yet; the text goes back to the input box"
                onclick={(ev: MouseEvent) => { ev.stopPropagation(); props.onCancel!(); }}
              >✕ cancel</button>
            </Show>
            {/* tool rows have no copyable message body — their command/output
                buttons live inside ToolRow; rendering the header button anyway
                produced a "copy" that silently copied the empty string */}
            <Show when={e.type !== "tool_call"}>
              <CopyBtn text={rawOf(e)} label="⧉ copy" title="copy the RAW text of this message (no markdown rendering)" />
            </Show>
            <Show when={props.onEdit}>
              <button
                class="editbtn"
                title="edit this prompt — forks the conversation here (later events are dropped or summarized)"
                onclick={(ev: MouseEvent) => { ev.stopPropagation(); props.onEdit!(); }}
              >✎ edit</button>
            </Show>
          </div>
        </Show>

        <SwitchContent e={e} prev={props.prev?.()} res={props.res} orphan={props.orphan} onOption={props.onOption} answeredIds={props.answeredIds} onAnswered={props.onAnswered} agentActive={props.agentActive} onResize={props.onResize} />
      </div>
    </div>
  );
}

/**
 * Free-text answer row under an ask_user embed. The agent's reply arrives as
 * a regular user prompt, so this just routes through onOption — but it lets
 * the operator answer with something that wasn't among the offered options.
 */
function FreeTextAnswer(props: { answered: boolean; onOption?: (t: string) => void }) {
  const [val, setVal] = createSignal("");
  const submit = () => {
    const t = val().trim();
    if (!t || props.answered) return;
    setVal("");
    props.onOption?.(t);
  };
  return (
    <div class="qfree">
      <input
        type="text"
        placeholder={props.answered ? "answered" : "or type your own answer…"}
        disabled={props.answered}
        value={val()}
        oninput={(e) => setVal(e.currentTarget.value)}
        onkeydown={(e: KeyboardEvent) => {
          // same Safari IME caveat as the main composer: isComposing is
          // already false by the time Enter's keydown arrives
          if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); }
        }}
      />
      <button disabled={props.answered || !val().trim()} onclick={submit}>reply</button>
    </div>
  );
}

function SwitchContent(props: { e: Ev; prev?: Ev; res?: () => Ev | undefined; orphan?: boolean; onOption?: (text: string) => void; answeredIds?: () => Set<string>; onAnswered?: (callId: string) => void; agentActive?: boolean; onResize?: () => void }) {
  const e = props.e;
  switch (e.type) {
    case "prompt": {
      // image attachments render as thumbnails under the text (logged events
      // carry data.images; optimistic echoes carry data.pending images array)
      const imgs: string[] = e.data?.images ?? [];
      return (
        <>
          <div class="content" innerHTML={renderMarkdownCached(String(e.data.text ?? ""))} />
          <Show when={imgs.length}>
            <div class="promptimgs">
              <For each={imgs}>{(src) => <img src={src} class="promptimg" alt="attachment" />}</For>
            </div>
          </Show>
        </>
      );
    }
    case "message":
      return (
        <>
          <Show when={typeof e.data.reasoning === "string" && e.data.reasoning.trim()}>
            <details class="reasoning">
              <summary>💭 reasoning{String(e.data.reasoning).length > 4000 ? ` (${fmtK(String(e.data.reasoning).length)} — truncated)` : ""}</summary>
              <div class="mono">{truncate(String(e.data.reasoning), 8000)}</div>
            </details>
          </Show>
          <div class="content" innerHTML={renderMarkdownCached(String(e.data.content ?? ""))} />
          <Show when={e.data.interrupted}>
            <div class="interrupted">⚠ interrupted — partial output kept</div>
          </Show>
          <Show when={e.data.final}>
            <div class="msgfoot"><CopyBtn text={String(e.data.content ?? "")} /><span>copy summary</span></div>
          </Show>
        </>
      );
    case "tool_call":
      // `prev` must be FORWARDED (grouping #75): without it ToolRow cannot know it
      // continues the previous actor's run, which is what made every consecutive
      // bash row render its own icon + label.
      return <ToolRow e={e} prev={props.prev} res={props.res} orphan={props.orphan} agentActive={props.agentActive} onResize={props.onResize} />;
    case "tool_result": {
      // #54: a result whose call is no longer in the events window. It used to
      // render as a bare output blob with no tool name and no command, which
      // read as "the run never finished". Render the SAME completed tool row a
      // paired result gets, from the result's own metadata, so it is
      // indistinguishable from one that survived in the window.
      const out = String(e.data.result ?? "");
      const name = String(e.data.name ?? "tool");
      const ok = e.data.ok !== false;
      return (
        <details class={"embed " + (ok ? "" : "fail")} open={props.orphan}>
          <summary>
            <span class="meta">
              {/* the call is gone, so the command is too — show the tool and
                  the outcome rather than inventing an argument that was never
                  logged here */}
              {name === "bash" ? `$ (bash, call evicted)` : name}
            </span>
            <CopyBtn text={out} />
          </summary>
          <div class="mono">{truncate(out, 4000)}</div>
          <div class="meta">
            {fmtDur(e.data.durationMs)}
            {name === "bash"
              ? outcomeMarker(shellOutcome(e.data.ok, out))
              : ok
                ? ""
                : " · FAILED"}
          </div>
          <Show when={props.orphan}>
            <div class="meta">its call is no longer in the loaded events — the run itself finished</div>
          </Show>
        </details>
      );
    }
    case "decision": {
      const alts = Array.isArray(e.data?.alternatives) ? (e.data.alternatives as string[]) : [];
      return (
        <details class="embed decision">
          <summary>
            <b>📌 <span class="content inline-md" innerHTML={renderMarkdownCached(String(e.data?.decision ?? ""))} /></b>
            <span class="meta">decision logged</span>
          </summary>
          {/* model-written markdown, same as progress bodies */}
          <div class="content" innerHTML={renderMarkdownCached(String(e.data?.rationale ?? ""))} />
          <Show when={alts.length}>
            <div class="content muted">Rejected: {alts.join(" / ")}</div>
          </Show>
        </details>
      );
    }
    case "question": {
      const opts = Array.isArray(e.data?.options) ? (e.data.options as string[]) : [];
      // a question is ANSWERED once its tool_result exists in the log (ask_user
      // parks the loop; the reply lands as a user prompt and the tool_result
      // closes the call). Answered questions keep their options visible but
      // disabled — tapping them twice used to send duplicate prompts.
      const callId = e.data?.callId ? String(e.data.callId) : "";
      // called inside the row, so it tracks the signal reactively (#55)
      const answered = () => props.answeredIds?.().has(callId) ?? false;
      return (
        <div class={"embed question" + (answered() ? " answered" : "")}>
          {/* questions are model-written and often carry markdown (code refs,
              lists) — render them like progress embeds instead of dumping raw */}
          <div>❓ <div class="content inline-md" innerHTML={renderMarkdownCached(String(e.data?.question ?? ""))} /></div>
          <Show when={answered()}>
            <div class="meta" style="color:var(--ok)">✓ answered — continuing below</div>
          </Show>
          <Show when={opts.length > 0}>
            <div class="qopts">
              <For each={opts}>
                {(o) => (
                  <button
                    class="qopt"
                    disabled={answered()}
                    onclick={() => {
                      // #55: mark it answered NOW, before the POST. The derived
                      // set only catches up when the prompt event is logged, and
                      // until then the buttons stayed live — so a second click
                      // sent a duplicate prompt.
                      props.onAnswered?.(callId);
                      const actor = e.data?.actor;
                      if (actor) {
                        void api(`/api/agents/${encodeURIComponent(String(actor))}/prompt`, {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ text: o, start: true }),
                        }).then(() => flashHint(`→ answered @${String(e.data.actor)}`)).catch(() => flashHint("answer failed"));
                      } else {
                        props.onOption?.(o);
                      }
                    }}
                  >{o}</button>
                )}
              </For>
            </div>
          </Show>
          <FreeTextAnswer answered={answered()} onOption={props.onOption} />
        </div>
      );
    }
    case "progress":
      return (
        <div class="embed" style="border-color: var(--ok)">
          {/* progress bodies are model-written markdown — render them, don't
              dump raw text (structured fields keep their labels) */}
          <div>📈 <div class="content inline-md" innerHTML={renderMarkdownCached(String(e.data.doing ?? ""))} /></div>
          <Show when={e.data.goalStatus}><div class="progrow"><b>goal</b><span>{String(e.data.goalStatus)}</span></div></Show>
          <Show when={e.data.recent}><div class="progrow"><b>recent</b><span class="content inline-md" innerHTML={renderMarkdownCached(String(e.data.recent))} /></div></Show>
          <Show when={e.data.problems}><div class="progrow warn"><b>⚠ problems</b><span class="content inline-md" innerHTML={renderMarkdownCached(String(e.data.problems))} /></div></Show>
          <Show when={e.data.next}><div class="progrow"><b>next</b><span class="content inline-md" innerHTML={renderMarkdownCached(String(e.data.next))} /></div></Show>
        </div>
      );
    case "error":
      return <div class="embed fail"><div class="mono">⚠ {String(e.data.message ?? "")}</div></div>;
    case "compaction":
      return (
        <details class="embed compaction">
          <summary>
            <b>🗜 context compacted</b>
            <span class="meta">
              {String(e.data.mode ?? "")} · {fmtK(Number(e.data.tokensBefore ?? 0))} → {fmtK(Number(e.data.tokensAfter ?? 0))} tok
              {" · "}{e.data.summarized ? `${e.data.summarized} summarized` : `${e.data.dropped} dropped`}
            </span>
          </summary>
          <Show when={e.data.summary}>
            <div class="vtitle" style="margin-top:6px">what the agent kept</div>
            <div class="content" innerHTML={renderMarkdownCached(String(e.data.summary))} />
          </Show>
        </details>
      );
    default:
      return <div class="content muted">{truncate(JSON.stringify(e.data), 200)}</div>;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + " …" : s;
}

/** "in 5m" / "3m ago" — for schedule next/last columns */
function relTime(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const unit =
    abs < 90_000 ? `${Math.round(abs / 1000)}s`
    : abs < 5_400_000 ? `${Math.round(abs / 60_000)}m`
    : `${(abs / 3_600_000).toFixed(1)}h`;
  return ms >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** compact token counts with k/m/b suffixes: 12345 → "12k", 2.2M → "2.2m" */
function fmtK(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}b`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}m`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** session cost in USD: cents below $1, whole dollars above — no noise */
function costFmt(usd: number): string {
  if (usd >= 100) return Math.round(usd).toLocaleString();
  if (usd >= 10) return usd.toFixed(1);
  if (usd >= 1) return usd.toFixed(2);
  if (usd >= 0.01) return usd.toFixed(3);
  return usd.toFixed(4);
}

/** single-line preview with collapsed whitespace */
function oneLine(s: string, n: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return truncate(line, n);
}

/* ---------- copy-to-clipboard button ---------- */
/** Centered icon button — the shared home for emoji-glyph buttons. Emoji
 *  baselines sit off-center in plain text buttons, so every icon button
 *  should render through this (inline-flex centers the glyph properly). */
function IconBtn(props: {
  icon: string;
  title: string;
  onClick?: (e: MouseEvent) => void;
  active?: boolean;
  class?: string;
  style?: string;
}) {
  return (
    <button
      type="button"
      class={"iconbtn" + (props.active ? " active" : "") + (props.class ? " " + props.class : "")}
      title={props.title}
      onclick={props.onClick}
      style={props.style}
    >
      <span class="iconbtn-glyph">{props.icon}</span>
    </button>
  );
}

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

function CopyBtn(props: { text: string; label?: string; title?: string }) {
  const [done, setDone] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const copy = (e: MouseEvent) => {
    e.preventDefault(); // <summary> buttons must not toggle the details row
    e.stopPropagation();
    void copyText(props.text ?? "").then((result) => {
      if (result === "unsupported" || result === "failed") {
        setFailed(true); // nothing copied — say so instead of a silent no-op
        setTimeout(() => setFailed(false), 1200);
        return;
      }
      setDone(true);
      setTimeout(() => setDone(false), 900);
    });
  };
  return (
    <button
      class="copybtn"
      title={props.title ?? "copy to clipboard"}
      onclick={copy}
    >{done() ? "✓" : failed() ? "✗" : props.label ?? "⧉"}</button>
  );
}

/* ---------- modal shell ---------- */
function Modal(props: { title: string; onClose: () => void; children: any }) {
  return (
    <div class="overlay" onclick={(e: Event) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal">
        <div class="modal-head">
          <b>{props.title}</b>
          <button class="iconbtn" onclick={props.onClose}>✕</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

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

/* ---------- workspace file tree ---------- */

interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
  ignored?: boolean;
}

type MediaKind = "image" | "video" | "audio";
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]);
function ficon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const mk = mediaKindOf(name);
  if (mk === "image") return "🖼";
  if (mk === "video") return "🎬";
  if (mk === "audio") return "🎵";
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return "🟦";
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return "🟨";
  if (ext === "json" || ext === "jsonc") return "🧾";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "📝";
  if (ext === "css" || ext === "scss" || ext === "less") return "🎨";
  if (ext === "html" || ext === "htm" || ext === "svg") return "🌐";
  if (["py", "pyi"].includes(ext)) return "🐍";
  if (ext === "rs") return "🦀";
  if (ext === "go") return "🐹";
  if (ext === "java" || ext === "kt" || ext === "kts") return "☕";
  if (ext === "rb") return "💎";
  if (ext === "php") return "🐘";
  if (ext === "c" || ext === "h" || ext === "cpp" || ext === "hpp" || ext === "cc") return "🧩";
  if (ext === "sh" || ext === "bash" || ext === "zsh" || ext === "fish") return "🐚";
  if (ext === "sql") return "🗄";
  if (ext === "yml" || ext === "yaml" || ext === "toml" || ext === "ini" || ext === "conf") return "⚙";
  if (ext === "lock") return "🔒";
  if (name === "Dockerfile" || ext === "dockerfile") return "🐳";
  if (ext === "zip" || ext === "gz" || ext === "tar" || ext === "tgz" || ext === "bz2") return "📦";
  if (ext === "pdf") return "📕";
  if (ext === "txt" || ext === "log") return "📄";
  return "·";
}

function mediaKindOf(path: string): MediaKind | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
}

/* ---------- per-agent file-panel UI state (remount-proof) ----------
 * Preview popups / expanded dirs used to live INSIDE FilesPanel. Any parent
 * re-render that remounted the panel (agent snapshot churn re-evaluating the
 * keyed <Show>) wiped them: an open file popup vanished mid-read and the
 * tree collapsed. Keeping the state in a module-level store keyed by agent
 * makes it survive remounts; only a REAL agent switch starts fresh. */
type FileUiState = {
  expanded: Set<string>;
  preview: { path: string; content: string; binary?: boolean; truncated?: boolean } | null;
  media: { path: string; kind: MediaKind } | null;
  viewMode: "code" | "edit" | "md" | "media";
};
const fileUi = new Map<string, FileUiState>();
const fileUiFor = (agentId: string): FileUiState => {
  let s = fileUi.get(agentId);
  if (!s) {
    s = { expanded: new Set(), preview: null, media: null, viewMode: "code" };
    fileUi.set(agentId, s);
  }
  return s;
};

/**
 * The tasks editor, as its own component with PRIMITIVE props (#30).
 *
 * Inline in the right panel it was re-created whenever an `agent-update`
 * snapshot replaced the agent object — verified by staging the real UI: the
 * editor survived typing, saving and the /api/agents poll, and was recreated
 * only by the websocket snapshot, taking focus and caret with it. A component
 * boundary with primitive props (a string, a function) gives Solid a stable
 * element to keep, exactly as FilesPanel below already does for the file tree.
 *
 * `renderMarkdownCached` still renders the checklist preview from the draft.
 */
/**
 * The custom-theme editor: palette rows, a background image, and duplicate/delete.
 *
 * ## Why a component with primitive-ish props
 *
 * It renders a live PREVIEW (`applyCustomTheme` on the real `<html>`), so it must be the only
 * writer while open — otherwise the settings form's own colour changes would fight the
 * committed theme. Edits therefore apply immediately and are persisted on every change: a
 * "save" button would leave the preview and the stored state disagreeing whenever the dialog
 * was closed with Escape.
 *
 * Colours are edited as TEXT plus a native colour input. The text field is what makes paste
 * work (people copy `#5865F2` from a design tool) and the input is what makes picking
 * work; `normalizeColour` reconciles `#RGB`, `#RRGGBB` and `#RRGGBBAA`.
 */
/**
 * A theme drawn as a MINIATURE OF THE UI, not as a row of dots.
 *
 * Taken from Misskey's `MkThemePreview.vue`: a nav strip, a header, a panel with text lines and
 * accent dots, all from the theme's own colours. Choosing a theme then means looking at what you
 * will be staring at, rather than translating three swatches in your head — which is the
 * difference between a picker that is usable and one that is decorative.
 *
 * Pure presentational: it takes a palette and paints it, so a preset and a custom theme render
 * through exactly the same path and cannot drift apart.
 */
function ThemePreview(props: { palette: ThemePalette }) {
  const p = () => props.palette;
  return (
    <span class="tprev" style={{ background: p().bgDark }}>
      <span class="tprev-nav" style={{ background: p().bgDarkest }} />
      <span class="tprev-head" style={{ background: p().bgDarkest }} />
      <span class="tprev-panel" style={{ background: p().bgMid }} />
      {/* text lines: two "words" then a shorter one, so it reads as prose */}
      <span class="tprev-line" style={{ left: "32%", top: "38%", width: "34%", background: p().fg, opacity: 0.85 }} />
      <span class="tprev-line" style={{ left: "32%", top: "50%", width: "22%", background: p().acc }} />
      <span class="tprev-line" style={{ left: "32%", top: "62%", width: "40%", background: p().dim }} />
      {/* the accent and status dots: what tells two dark themes apart at a glance */}
      <span class="tprev-dot" style={{ left: "6%", top: "20%", background: p().acc }} />
      <span class="tprev-dot" style={{ left: "6%", top: "40%", background: p().dim }} />
      <span class="tprev-dot" style={{ left: "6%", top: "60%", background: p().ok }} />
      <span class="tprev-dot" style={{ left: "70%", top: "12%", background: p().warn }} />
      <span class="tprev-dot" style={{ left: "84%", top: "12%", background: p().err }} />
    </span>
  );
}

function ThemeEditor(props: {
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
    return list.find((t) => t.id === editingId()) ?? list[0];
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
    const id = editingId();
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
    // Copy whatever is ACTIVE — preset or custom. Looking the id up in THEMES alone meant that
    // duplicating a CUSTOM theme silently produced "Dark copy" with `mode: "dark"`, because the
    // lookup missed and fell back to THEMES[0]. MEASURED: active=custom-x (mode light) produced
    // a dark copy labelled after the wrong theme.
    const activeCustom = props.themes().find((t) => t.id === props.activeId);
    const activePreset = THEMES.find((t) => t.key === props.activeId);
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
        ? { backgroundImage: activeCustom.backgroundImage, backgroundDim: activeCustom.backgroundDim }
        : {}),
    };
    props.onChange([...props.themes(), theme]);
    setEditingId(id);
  };

  const importFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BACKGROUND_BYTES) {
      flashHint(`that image is ${Math.round(file.size / 1024)}KB — the limit is ${Math.round(MAX_BACKGROUND_BYTES / 1024)}KB`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      // store the data URI itself, so the image survives a reload with no server involved
      if (/^data:image\//.test(url)) patch((t) => ({ ...t, backgroundImage: url }));
    };
    reader.readAsDataURL(file);
  };

  return (
    <div class="themeeditor">
      <h4 class="cfgsub">your themes</h4>
      <div class="btnrow">
        <button type="button" onclick={duplicatePreset} title="copy the theme you are using into a new editable one — presets themselves are never modified">
          ＋ duplicate current
        </button>
        <Show when={props.themes().length > 0}>
          <select
            value={editingId()}
            onchange={(e) => setEditingId(e.currentTarget.value)}
            title="which custom theme to edit"
          >
            <For each={props.themes()}>
              {(t) => <option value={t.id}>{t.label}</option>}
            </For>
          </select>
        </Show>
      </div>

      <Show
        when={editing()}
        fallback={
          <div class="muted" style="margin:6px 0">
            no custom themes yet — press <b>＋ duplicate current</b> to start from the palette you are using.
          </div>
        }
      >
        {(t) => (
          <>
            <div class="cfggrid" style="margin-top:8px">
              <label class="trow">name
                <input
                  class="w100"
                  value={editing()!.label}
                  oninput={(e) => patch((cur) => ({ ...cur, label: e.currentTarget.value.slice(0, 40) }))}
                />
              </label>
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
              {/* A BUTTON that opens the file picker, not a bare <input type="file">.
                  The native control always shows "no file chosen" once its value is cleared —
                  and it MUST be cleared so the same file can be picked twice — so the one piece
                  of state it displays was permanently wrong, immediately after a successful
                  upload. Reported twice. The button reports what actually happened instead. */}
              <button
                type="button"
                class="trow"
                onclick={() => filePick?.click()}
                title="PNG/JPG/WebP. Stored in this browser, applied behind the panels."
              >
                {editing()!.backgroundImage ? "🖼 replace image…" : "🖼 choose image…"}
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
                  // clear so the SAME file can be picked again; the button above, not this
                  // input, is what tells the operator what is applied
                  e.currentTarget.value = "";
                }}
              />
              <Show when={editing()!.backgroundImage}>
                <div class="bgpreview">
                  <img src={editing()!.backgroundImage} alt="theme background preview" />
                  <span class="muted" title="this image is stored inside the theme">
                    ✓ image set — {Math.round(((editing()!.backgroundImage?.length ?? 0) * 3) / 4 / 1024)} KB
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
                    <button type="button" onclick={() => patch((cur) => ({ ...cur, backgroundImage: undefined }))}>
                      ✕ remove
                    </button>
                  </div>
                </div>
              </Show>
            </div>
            <div class="muted" style="margin-top:6px;font-size:var(--text-xs)">
              the image is stored in this browser ({Math.round(MAX_BACKGROUND_BYTES / 1024)}KB limit) and sits behind
              the panels, dimmed so text stays readable.
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

function TodoEditor(props: {

  draft: string;
  preview: boolean;
  onDraft: (text: string) => void;
}) {
  // #88: these two branches were INVERTED — `<Show when={…}>` rendered the TEXTAREA
  // and the checklist was the `fallback`, so `true` meant "editor". `saveTodo` set
  // `true` to reach the preview and therefore did the opposite.
  //
  // The prop is named `preview`, not `viewMode`, because there is an unrelated
  // `viewMode` signal in this file (the file-viewer's code/md/media mode) and the
  // two were being confused. The branches are also swapped, so the name states what
  // actually renders.
  //
  // HEIGHT IS SHARED BY THE TWO VIEWS. The textarea is natively resizable
  // (`resize: vertical`), so the browser applies the drag as an INLINE height on that
  // one element — and the preview is a DIFFERENT element, which fell back to the
  // stylesheet's `11.5em`. Dragging the editor therefore lost its height the moment you
  // switched to the checklist. Observed with a ResizeObserver and applied to both, so a
  // drag survives the toggle; persisted so it also survives a reload.
  const stored = Number(localStorage.getItem("teapot.todoH") ?? "");
  const [todoHeight, setTodoHeight] = createSignal<number>(
    Number.isFinite(stored) && stored > 0 ? stored : 0,
  );
  const heightStyle = () => (todoHeight() > 0 ? { height: `${todoHeight()}px` } : undefined);
  /**
   * Track a height the user produced by dragging.
   *
   * A ResizeObserver rather than `onpointerup`: the native resize handle does not have to
   * involve a pointer event this listener sees (a touch drag, a keyboard/assistive
   * resize), and the observer reports the real box either way. It is armed per element, so
   * whichever view is mounted feeds the same signal.
   */
  const trackHeight = (el: HTMLElement) => {
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h <= 0) return;
      setTodoHeight((cur) => {
        if (Math.abs(cur - h) < 1) return cur; // no churn from sub-pixel reflow
        localStorage.setItem("teapot.todoH", String(h));
        return h;
      });
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };

  return (
    <Show
      when={props.preview}
      fallback={
        /* the markdown editor — the default view */
        <textarea
          id="todo-input"
          class="mono todopane-edit"
          rows={5}
          style={heightStyle()}
          ref={trackHeight}
          placeholder={"- task one\n- task two"}
          value={props.draft}
          oninput={(e) => props.onDraft(e.currentTarget.value)}
          title="shared with the agent \u2014 it may check items off via set_todo; your unsaved edits win until you save"
        />
      }
    >
      {/* rendered checklist; #124: both views take their height from `.todopane`,
          so they cannot drift again — plus the shared dragged height above */}
      <div
        class="content mdpreview todopane"
        style={heightStyle()}
        ref={trackHeight}
        innerHTML={renderMarkdownCached(props.draft)}
      />
    </Show>
  );
}

function FilesPanel(props: { agentId: string; workspace: string }) {
  const ui = fileUiFor(props.agentId);
  // path → lazily fetched child listing ("" = workspace root)
  const [kids, setKids] = createSignal<Map<string, TreeNode[]>>(new Map());
  const [expanded, setExpandedRaw] = createSignal<Set<string>>(ui.expanded);
  // every preview/media/mode write mirrors into `ui` so a remount of this
  // panel (parent re-render churn) restores the open popup instead of losing it
  const [preview, setPreviewRaw] = createSignal(ui.preview);
  const setPreview = (v: FileUiState["preview"]) => { ui.preview = v; setPreviewRaw(v); };
  const setExpanded = (v: Set<string>) => { ui.expanded = v; setExpandedRaw(v); };
  const [media, setMediaRaw] = createSignal(ui.media);
  const setMedia = (v: FileUiState["media"]) => { ui.media = v; setMediaRaw(v); };
  const [viewMode, setViewModeRaw] = createSignal(ui.viewMode);
  const setViewMode = (v: FileUiState["viewMode"]) => { ui.viewMode = v; setViewModeRaw(v); };
  const [err, setErr] = createSignal("");
  // gitignored files: "dim" (default) | "hide" | "show"
  const [ignoreMode, setIgnoreMode] = createSignal(
    localStorage.getItem("teapot.ignoreMode") ?? "dim",
  );
  const cycleIgnoreMode = () => {
    const order = ["dim", "hide", "show"] as const;
    const next = order[(order.indexOf(ignoreMode() as any) + 1) % 3];
    setIgnoreMode(next);
    localStorage.setItem("teapot.ignoreMode", next);
  };
  /** filter helper per current mode */
  // "hide" removes ignored entries entirely — INCLUDING ignored directories
  // (node_modules/, dist/…). The old `!n.dir` exception kept ignored dirs
  // visible, which read as the toggle being broken. Expanding a hidden dir is
  // still possible via 🙈→👁 if ever needed.
  const ignoreFilter = (n: TreeNode) => (ignoreMode() === "hide" ? !n.ignored : true);
  // show dotfiles — also persisted; toggling refetches the open dirs
  const [showHidden, setShowHidden] = createSignal(
    localStorage.getItem("teapot.showHidden") === "1",
  );
  const toggleHidden = () => {
    const next = !showHidden();
    // Fetch FIRST with the new flag, then flip the signal and patch the map
    // in place — flipping before the fetch landed left the tree showing its
    // old rows under a new filter (or nothing at all while in flight), which
    // collapsed .filebox and visibly reflowed the whole right panel.
    const targets = ["", ...expanded()];
    void Promise.all(targets.map(async (p) => ({ p, rows: await fetchDirWith(p, next) })))
      .then((results) => {
        setShowHidden(next);
        localStorage.setItem("teapot.showHidden", next ? "1" : "0");
        // merge (not replace): unchanged rows keep their object identity, so
        // the toggle no longer rebuilds every visible row
        for (const { p, rows } of results) if (rows) mergeKids(p, rows);
      });
  };

  const parseEntries = (parentPath: string, list: any[]): TreeNode[] =>
    list.map((e) => ({
      name: String(e.name),
      path: parentPath ? `${parentPath}/${e.name}` : String(e.name),
      dir: !!e.dir,
      ...(typeof e.size === "number" ? { size: e.size } : {}),
      ...(e.ignored ? { ignored: true } : {}),
    }));

  async function fetchDir(path: string): Promise<TreeNode[] | null> {
    return fetchDirWith(path, showHidden());
  }

  /** same, but with an explicit dotfiles flag (used by the toggle's pre-fetch) */
  async function fetchDirWith(path: string, hidden: boolean): Promise<TreeNode[] | null> {
    try {
      const qs = new URLSearchParams();
      if (path) qs.set("path", path);
      if (hidden) qs.set("hidden", "1");
      const r = await api(
        `/api/agents/${props.agentId}/tree?${qs.toString()}`,
      );
      return parseEntries(path, r.entries ?? []);
    } catch (ex) {
      setErr((ex as Error).message);
      return null;
    }
  }

  // reset & load the root whenever a DIFFERENT agent is selected. The guard
  // matters: agent snapshots update on every poll/event burst, and without it
  // each update cleared + re-fetched the whole tree (visible flicker and a
  // pointless /tree request per snapshot).
  // Merge fetched rows into the cache WITHOUT replacing row objects that are
  // unchanged (same path+dir+size). Solid's <For> diffs by reference: handing
  // it brand-new TreeNode objects on every refresh tore down and rebuilt the
  // whole visible list — the "tree flickers on refresh" bug.
  const mergeKids = (path: string, rows: TreeNode[]) =>
    setKids((prev) => {
      const old = prev.get(path);
      if (!old) return new Map(prev).set(path, rows);
      const merged = old.map((o) => {
        const fresh = rows.find((r) => r.path === o.path);
        // keep the previous object when nothing changed → no remount
        return fresh && fresh.dir === o.dir && fresh.size === o.size &&
               fresh.ignored === o.ignored && fresh.name === o.name
          ? o
          : (fresh ?? o);
      });
      // append genuinely new entries (created since the last fetch)
      for (const r of rows) if (!old.some((o) => o.path === r.path)) merged.push(r);
      // drop entries that vanished from disk — but never the one being previewed
      const kept = merged.filter((m) => rows.some((r) => r.path === m.path) || ui.preview?.path === m.path);
      const next = new Map(prev);
      next.set(path, kept);
      return next;
    });

  let kidsFor = "";
  createEffect(() => {
    const id = props.agentId;
    if (id === kidsFor) return; // same agent — keep the loaded tree as-is
    kidsFor = id;
    // a REAL agent switch starts a fresh view; a mere panel remount keeps
    // everything (state lives in `ui`, see fileUiFor above)
    setExpanded(new Set<string>());
    setPreview(null);
    setMedia(null);
    setKids(new Map());
    void fetchDir("").then((rows) => {
      if (rows && kidsFor === id) setKids(new Map([[ "", rows ]]));
    });
  });

  const toggleDir = async (node: TreeNode) => {
    const next = new Set<string>(expanded());
    if (next.has(node.path)) {
      next.delete(node.path);
      setExpanded(next);
      return;
    }
    next.add(node.path);
    setExpanded(next);
    if (!kids().has(node.path)) {
      const rows = await fetchDir(node.path);
      if (rows) mergeKids(node.path, rows);
    }
  };

  const [hlHtml, setHlHtml] = createSignal("");
  const [hlPending, setHlPending] = createSignal(false);
  // editBuf stays local — it is transient typing state tied to one popup
  const [editBuf, setEditBuf] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const isMd = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
  let hlRun = 0;
  const startHighlighting = async (p: { path: string; content: string; truncated?: boolean }) => {
    const run = ++hlRun;
    setHlHtml("");
    setHlPending(true);
    try {
      const { highlightChunks } = await import("./shiki");
      for await (const chunk of highlightChunks(p.path, p.content)) {
        if (hlRun !== run) return;
        setHlHtml((prev) => prev + chunk);
      }
    } catch {
      if (hlRun === run) setHlHtml(""); // give up → plain fallback
    } finally {
      if (hlRun === run) setHlPending(false);
    }
  };
  onCleanup(() => { hlRun++; });

  const openFileWith = async (
    node: TreeNode,
    mode: "code" | "edit" | "md",
  ) => {
    // media files stream from the raw endpoint instead of text preview
    const mk = mediaKindOf(node.path);
    if (mk) {
      setPreview({ path: node.path, content: "", binary: true });
      setMedia({ path: node.path, kind: mk });
      setViewMode("media");
      return;
    }
    try {
      const r = await api(
        `/api/agents/${props.agentId}/file?path=${encodeURIComponent(node.path)}`,
      );
      setMedia(null);
      setPreview({ path: node.path, content: r.content ?? "", binary: r.binary, truncated: r.truncated });
      setEditBuf(r.content ?? "");
      setViewMode(r.binary ? "code" : mode);
      if (!r.binary && mode !== "md") {
        startHighlighting({ path: node.path, content: r.content ?? "", truncated: r.truncated });
      }
    } catch (ex) {
      flashHint(`open failed: ${(ex as Error).message}`);
    }
  };

  /** PUT the edited buffer back; on conflict offer to load the disk version */
  const saveFile = async () => {
    const pv = preview();
    if (!pv || saving()) return;
    setSaving(true);
    try {
      await api(`/api/agents/${props.agentId}/file?path=${encodeURIComponent(pv.path)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: editBuf(), baseContent: pv.content }),
      });
      setPreview({ ...pv, content: editBuf() }); // new baseline for future conflicts
      flashHint(`saved ${pv.path}`);
    } catch (ex) {
      const raw = (ex as { payload?: unknown }).payload;
      const conflict =
        raw && typeof raw === "object" && (raw as any).error === "file changed on disk"
          ? (raw as { current?: string })
          : null;
      if (conflict?.current !== undefined) {
        // offer the fresh disk content instead of throwing away the save
        const take = confirm(
          "This file changed on disk since you opened it.\n" +
            "OK = load the disk version into the editor (your edits are discarded)\n" +
            "Cancel = keep editing your copy",
        );
        if (take) {
          setEditBuf(conflict.current!);
          setPreview({ ...pv, content: conflict.current! });
          flashHint("loaded the current file from disk");
        } else {
          flashHint("kept your edits — use Save As via bash to force-write");
        }
      } else {
        flashHint(`save failed: ${(ex as Error).message}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const isEditable = (pv: { binary?: boolean; truncated?: boolean }) =>
    !pv.binary && !pv.truncated;

  const row = (node: TreeNode, depth: number): any => (
    <>
      <div
        class={
          "filerow" + (node.dir ? " isdir" : "") +
          (node.ignored && ignoreMode() === "dim" ? " gitignored" : "")
        }
        style={`padding-left:${depth * 13 + 8}px`}
        onclick={() => (node.dir ? void toggleDir(node) : void openFileWith(node, "code"))}
        title={node.dir ? `browse ${node.path}` : `preview ${node.path}`}
      >
        <span class="ficon">{node.dir ? (expanded().has(node.path) ? "▾" : "▸") : ficon(node.name)}</span>
        <span class="fname">{node.name}</span>
        <Show when={!node.dir && node.size !== undefined}>
          <span class="fsize">{fmtK(node.size!)}</span>
        </Show>
      </div>
      <Show when={node.dir && expanded().has(node.path)}>
        <For each={(kids().get(node.path) ?? []).filter(ignoreFilter)}>{(child) => row(child, depth + 1)}</For>
      </Show>
    </>
  );

  const wsName = () => props.workspace.split("/").filter(Boolean).pop() ?? props.workspace;

  /** refresh root + every expanded dir IN PLACE — mergeKids keeps unchanged
   * row objects, so the tree updates without flicker and an open file popup
   * is never touched (its state lives outside the row list entirely). */
  const [refreshing, setRefreshing] = createSignal(false);
  const refreshTree = async () => {
    if (refreshing()) return;
    setRefreshing(true);
    try {
      const targets = ["", ...expanded()];
      const results = await Promise.all(
        targets.map(async (p) => ({ p, rows: await fetchDirWith(p, showHidden()) })),
      );
      for (const { p, rows } of results) if (rows) mergeKids(p, rows);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <h3 style="display:flex;align-items:center;gap:6px" title="the agent's workspace — lazy-loaded, dotfiles hidden; click a folder to expand, a file to preview">
        🗂 files <span class="muted" style="text-transform:none;letter-spacing:0">· {wsName()}</span>
        <IconBtn
          class="filetoggle"
          icon={refreshing() ? "…" : "⟳"}
          title="refresh the tree (root + expanded folders) — open popups are kept"
          onClick={() => void refreshTree()}
        />
        <IconBtn
          class="filetoggle"
          style="margin-left:auto"
          icon={ignoreMode() === "hide" ? "🙈" : ignoreMode() === "dim" ? "👁" : "✨"}
          title={`gitignored files: ${ignoreMode()} — click to cycle (dim → hidden → shown)`}
          onClick={cycleIgnoreMode}
        />
        <IconBtn
          class="filetoggle"
          icon={showHidden() ? "◉." : "○."}
          title={showHidden() ? "dotfiles shown — click to hide" : "dotfiles hidden — click to show"}
          onClick={toggleHidden}
        />
      </h3>
      <div class="filebox">
        <Show
          when={(kids().get("") ?? []).length > 0}
          fallback={<div class="muted" style="padding:6px">{err() || "empty workspace"}</div>}
        >
          <For each={(kids().get("") ?? []).filter(ignoreFilter)}>
            {(node) => row(node, 0)}
          </For>
        </Show>
      </div>
      <Show when={preview()}>
        {(pv) => (
          <Modal title={`🗂 ${pv().path}`} onClose={() => { hlRun++; setPreview(null); setMedia(null); }}>
            <Show
              when={media()}
              fallback={
                <>
                  <div class="filetoolbar">
                    <Show when={isMd(pv().path) && !pv().binary}>
                      <button class={viewMode() === "md" ? "on" : ""} onclick={() => setViewMode("md")} title="rendered markdown">👁 preview</button>
                    </Show>
                    <button class={viewMode() === "code" ? "on" : ""} onclick={() => { setViewMode("code"); if (!hlHtml()) startHighlighting({ path: pv().path, content: pv().content, truncated: pv().truncated }); }} title="syntax-highlighted source">{"</>"} code</button>
                    <Show when={isEditable(pv())}>
                      <button class={viewMode() === "edit" ? "on" : ""} onclick={() => setViewMode("edit")} title="edit and save back to the workspace">✎ edit</button>
                    </Show>
                  </div>
                  <Show
                    when={!pv().binary}
                    fallback={
                      <div class="mono" style="margin:0;color:var(--dim)">
                        (binary file — inspect it from the terminal)
                      </div>
                    }
                  >
                    <Show when={viewMode() === "edit"} fallback={
                      <Show when={viewMode() === "md" && isMd(pv().path)} fallback={
                        <CodePreview
                          path={pv().path}
                          content={pv().content}
                          html={hlHtml()}
                          pending={hlPending()}
                          truncated={!!pv().truncated}
                        />
                      }>
                        <div class="content mdpreview" innerHTML={renderMarkdown(pv().content)} />
                      </Show>
                    }>
                      <div class="fileeditor">
                        <textarea
                          class="mono"
                          value={editBuf()}
                          oninput={(e) => setEditBuf(e.currentTarget.value)}
                          spellcheck={false}
                        />
                        <div class="filerow-actions">
                          <span class="muted">{fmtK(editBuf().length)} bytes</span>
                          <button class="savebtn" disabled={saving() || editBuf() === pv().content} onclick={() => void saveFile()}>
                            {saving() ? "saving…" : "💾 save"}
                          </button>
                        </div>
                      </div>
                    </Show>
                  </Show>
                </>
              }
            >
              {/* media preview: stream raw bytes with native controls */}
              <div class="mediapreview">
                <Show when={media()!.kind === "image"} fallback={
                  <Show when={media()!.kind === "video"} fallback={
                    <audio controls src={`/api/agents/${props.agentId}/raw?path=${encodeURIComponent(media()!.path)}`} />
                  }>
                    <video controls src={`/api/agents/${props.agentId}/raw?path=${encodeURIComponent(media()!.path)}`} />
                  </Show>
                }>
                  <img src={`/api/agents/${props.agentId}/raw?path=${encodeURIComponent(media()!.path)}`} alt={media()!.path.split("/").pop()} />
                </Show>
                <div class="meta muted">{media()!.kind} preview</div>
              </div>
            </Show>
          </Modal>
        )}
      </Show>
    </>
  );
}

/* ---------- highlighted file preview body ---------- */

/**
 * Receives rendered shiki chunks as they stream in (`html` grows per chunk);
 * shows a lightweight loading hint until the first chunk lands.
 */
function CodePreview(props: { path: string; content: string; html: string; pending: boolean; truncated: boolean }) {
  return (
    <>
      <Show
        when={props.html}
        fallback={
          props.pending ? (
            <div class="muted" style="padding:8px;font-size:12px">
              ✨ highlighting {props.path.split("/").pop()}…
            </div>
          ) : (
            <pre class="mono" style="max-height:62vh;overflow:auto;white-space:pre-wrap;margin:0">
              {props.content}
            </pre>
          )
        }
      >
        {/* shiki emits its own <pre class="shiki"><code>…</code></pre>; content is shiki-generated HTML */}
        <div class="filepreview" innerHTML={props.html} />
      </Show>
      <Show when={props.truncated}>
        <div class="muted" style="padding-top:6px;font-size:11.5px">… truncated (first 100 KB)</div>
      </Show>
    </>
  );
}

/* ---------- settings / config editor ---------- */
/* ---------- first-run setup wizard ---------- */

type ProviderPreset = {
  key: string;
  label: string;
  url: string;
  /** pre-filled model suggestion — empty means "keep what's typed" */
  model: string;
  hint?: string;
};

/**
 * Known OpenAI-compatible providers, shared by the setup wizard and the
 * settings modal's quick-add. "custom" is a wizard-only pseudo preset that
 * marks the manual path without touching any field.
 */
const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "openrouter",
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1",
    model: "",
    hint: "400+ models behind one key — teapot sends app-attribution headers automatically",
  },
  {
    key: "orcarouter",
    label: "OrcaRouter",
    url: "https://api.orcarouter.ai/v1",
    model: "",
    hint: "zero-markup routing gateway — 'orcarouter/auto' grades each prompt and picks the model",
  },
  {
    key: "openai",
    label: "OpenAI",
    url: "https://api.openai.com/v1",
    model: "",
    hint: "your account's models — pick from the list once the endpoint answers",
  },
  {
    key: "opencode-go",
    label: "OpenCode Go",
    url: "https://opencode.ai/zen/go/v1",
    model: "",
    hint: "OpenCode's open-model subscription — teapot sends the required x-opencode-session header; choose a chat/completions model",
  },
  {
    key: "llamacpp",
    label: "llama.cpp server",
    url: "http://localhost:8080/v1",
    model: "",
    hint: "free & local — start it with: llama-server -m ./model.gguf  (any model name works)",
  },
];

/** the wizard shows this extra option for arbitrary OpenAI-compatible endpoints */
const CUSTOM_PRESET: ProviderPreset = {
  key: "custom",
  label: "Custom",
  url: "",
  model: "",
  hint: "any OpenAI-compatible /v1 endpoint — vLLM, LM Studio, llama.cpp, a company gateway… fill the fields below",
};

function SetupWizard(props: { onDone: () => void }) {
  const [preset, setPreset] = createSignal<ProviderPreset>(PROVIDER_PRESETS[0]);
  const [baseUrl, setBaseUrl] = createSignal(PROVIDER_PRESETS[0].url);
  const [apiKey, setApiKey] = createSignal("");
  const [model, setModel] = createSignal(PROVIDER_PRESETS[0].model);
  const [models, setModels] = createSignal<
    { id: string; contextLength?: number; pricing?: { prompt: number; completion: number }; modalities?: { input: string[]; output: string[] } }[]
  >([]);
  const [workspace, setWorkspace] = createSignal("~/teapot-workspace");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");

  const pick = (p: ProviderPreset) => {
    setPreset(p);
    // "custom" only marks the manual path — never clobbers typed values
    if (p.key === "custom") return;
    if (p.url) {
      setBaseUrl(p.url);
      if (p.model) setModel(p.model);
    }
  };

  /** live model discovery from whatever endpoint the operator is typing —
   *  same data the main UI's model switcher shows, just pre-config */
  createEffect(() => {
    const url = baseUrl().trim();
    const key = apiKey();
    if (!/^https?:\/\//.test(url)) {
      setModels([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await api(
          `/api/setup/models?baseUrl=${encodeURIComponent(url)}${key ? `&apiKey=${encodeURIComponent(key)}` : ""}`,
        );
        setModels(r.models ?? []);
      } catch {
        setModels([]); // endpoint unreachable / no auth yet — keep typing
      }
    }, 600);
    onCleanup(() => clearTimeout(t));
  });

  /** "ctx 1m · $3/M in · $15/M out" for a model id from the fetched list */
  const specOf = (id: string) => {
    const m = models().find((x) => x.id === id.trim());
    if (!m) return "";
    const parts: string[] = [];
    if (m.contextLength) parts.push(`ctx ${fmtK(m.contextLength)} tok`);
    const price = (p?: number) =>
      p === undefined ? "" : `$${p * 1e6 >= 10 ? Math.round(p * 1e6) : +(p * 1e6).toFixed(1)}/M`;
    if (m.pricing) {
      const pin = price(m.pricing.prompt);
      const pout = price(m.pricing.completion);
      if (pin && pout) parts.push(`${pin} in · ${pout} out`);
      else if (pin || pout) parts.push(price(m.pricing.prompt ?? m.pricing.completion));
    }
    return parts.join(" · ");
  };
  const modelSpec = () => specOf(model());
  /** the fetched catalogue narrowed by what is typed (empty query = all) */
  const filteredModels = () => {
    const q = model().trim().toLowerCase();
    if (!q) return models();
    return models().filter((m) => m.id.toLowerCase().includes(q));
  };

  const submit = async (e: Event) => {
    e.preventDefault(); setErr("");
    // #144: the model is the operator's choice, so it must be made explicitly
    // rather than pre-filled by a preset. Say so here instead of letting the
    // server's generic "baseUrl and model are required" come back after a round
    // trip.
    if (!model().trim()) {
      setErr(
        models().length
          ? "pick a model — choose one from the list, or type its id"
          : "pick a model — type its id (the endpoint has not listed any yet)",
      );
      return;
    }
    setBusy(true);
    try {
      await api("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: baseUrl(),
          apiKey: apiKey() || undefined,
          model: model(),
          workspace: workspace(),
          ...(password() ? { password: password() } : {}),
        }),
      });
      props.onDone();
    } catch (ex) {
      setErr((ex as Error).message); setBusy(false);
    }
  };

  return (
    <div class="overlay" style={{ background: "var(--bg-darkest)" }}>
      <div class="modal" style="max-width:560px">
        <div class="modal-head"><b>🫖 welcome to teapot</b></div>
        <p class="muted" style="margin:0 0 10px;font-size:13px">
          first run — pick an OpenAI-compatible provider and you're done.
          everything below can be changed later in ⚙ settings.
        </p>
        <form onsubmit={submit} style="display:flex;flex-direction:column;gap:12px">
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            {[...PROVIDER_PRESETS, CUSTOM_PRESET].map((p) => (
              <button
                type="button"
                class={"presetbtn" + (preset().key === p.key ? " active" : "")}
                title={p.hint || p.url}
                onclick={() => pick(p)}
              >{p.label}</button>
            ))}
          </div>
          <Show when={preset().hint}>
            <div class="muted" style="font-size:11.5px;margin-top:-6px">{preset().hint}</div>
          </Show>
          <label>base url
            <input
              type="text"
              class="w100 mono"
              list="wiz-preset-urls"
              value={baseUrl()}
              oninput={(e) => setBaseUrl(e.currentTarget.value)}
            />
            <datalist id="wiz-preset-urls">
              {PROVIDER_PRESETS.map((p) => <option value={p.url} />)}
            </datalist>
          </label>
          <label>api key <input type="password" class="w100" value={apiKey()} oninput={(e) => setApiKey(e.currentTarget.value)} placeholder="(local providers may not need one)" /></label>
          <label>model
            <input
              type="text"
              class="w100 mono"
              list="wiz-model-list"
              value={model()}
              oninput={(e) => setModel(e.currentTarget.value)}
              placeholder={preset().key === "llamacpp" ? "(any name — serves whichever gguf is loaded)" : "(pick from the list below, or type an id)"}
            />
            <datalist id="wiz-model-list">
              {models().map((m) => <option value={m.id} />)}
            </datalist>
          </label>
          {/* #144: with no pre-filled default the list has to be an obvious
              CHOICE, not just autocomplete fodder. Narrowed by what is typed, and
              capped so a 400-model endpoint cannot push the rest of the form off
              screen. */}
          <Show
            when={filteredModels().length > 0}
            fallback={
              <div class="muted" style="font-size:11.5px;margin-top:-8px">
                {models().length
                  ? "no model matches that — clear the field to see them all"
                  : "models appear here automatically once the endpoint answers GET /models"}
              </div>
            }
          >
            <div class="wizmodels">
              {filteredModels().slice(0, 40).map((m) => (
                <button
                  type="button"
                  class={"wizmodel" + (model() === m.id ? " active" : "")}
                  title={specOf(m.id) || m.id}
                  onclick={() => setModel(m.id)}
                >
                  <span class="mono">{m.id}</span>
                  <Show when={specOf(m.id)}><span class="muted">{specOf(m.id)}</span></Show>
                </button>
              ))}
            </div>
            <div class="muted" style="font-size:11.5px;margin-top:-6px">
              {filteredModels().length} model{filteredModels().length > 1 ? "s" : ""}
              <Show when={filteredModels().length > 40}> (showing the first 40 — keep typing to narrow)</Show>
              <Show when={modelSpec()}> · selected: <span style="color:var(--fg)">{modelSpec()}</span></Show>
            </div>
          </Show>
          <fieldset>
            <legend>first agent</legend>
            <label>workspace directory
              <input type="text" class="w100 mono" value={workspace()} oninput={(e) => setWorkspace(e.currentTarget.value)} />
            </label>
            <label style="margin-top:4px" title="asks for this password when opening the UI or API from another machine — plain-HTTP LAN traffic is NOT encrypted">protect the API with a password? <input type="password" class="w100" value={password()} oninput={(e) => setPassword(e.currentTarget.value)} placeholder="(optional — LAN traffic is still plain HTTP)" /></label>
          </fieldset>
          <Show when={err()}><span style="color:var(--err);font-size:13px">{err()}</span></Show>
          <button type="submit" disabled={busy()} style="background:var(--acc);border:none;border-radius:8px;color:#fff;padding:9px 14px;font-weight:600;cursor:pointer">
            {busy() ? "saving…" : "finish setup"}
          </button>
        </form>
      </div>
    </div>
  );
}

function ConfigModal(props: {
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
  /** theme state, owned by App because it paints `<html>` */
  theme: {
    themes: () => CustomTheme[];
    activeId: () => string;
    auto: () => boolean;
    setAuto: (v: boolean) => void;
    dark: () => string;
    setDark: (v: string) => void;
    light: () => string;
    setLight: (v: string) => void;
    setThemes: (v: CustomTheme[]) => void;
    setActive: (v: string) => void;
  };
}) {
  /**
   * #170: a provider row holds a LIST of keys, rotated round-robin by the server.
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
  // from "you just changed it" (#21)
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
  const [tasks, setTasks] = createSignal<any[]>((props.cfg.tasks ?? []).map((t: any) => ({ ...t })));
  // MCP servers (#67). The header text is kept separately as STRINGS: the config holds
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
  const [mcpStatus, setMcpStatus] = createSignal<
    Record<number, { kind: "testing" | "ok" | "err"; text: string }>
  >({});
  // live per-server state, refreshed when the section is opened
  const [mcpStates, setMcpStates] = createSignal<Record<string, any>>({});
  // per-server OAuth state, keyed by row index — fetched lazily, because the token
  // status changes independently of the server list
  const [mcpOAuth, setMcpOAuth] = createSignal<
    Record<number, { required?: boolean; authorized?: boolean; hasRefreshToken?: boolean; flow?: { phase: string; url?: string } }>
  >({});
  const refreshMcpStates = async () => {
    const r = (await api("/api/mcp").catch(() => null)) as { states?: any[] } | null;
    setMcpStates(Object.fromEntries((r?.states ?? []).map((s: any) => [s.name, s])));
  };
  const refreshMcpOAuth = async (i: number, name: string) => {
    if (!name) return;
    // "needs OAuth" is discovered by the server itself now: an unauthorized connect
    // leaves the state flagged, so there is no separate probe to trigger here.
    const r = (await api(`/api/mcp/oauth/status?name=${encodeURIComponent(name)}`).catch(
      () => null,
    )) as any;
    if (r && !r.error) setMcpOAuth((m) => ({ ...m, [i]: r }));
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
      body: JSON.stringify({ name: srv.name }),
    }).catch(() => null)) as
      | { ok?: boolean; url?: string; error?: string; alreadyAuthorized?: boolean }
      | null;
    if (r?.alreadyAuthorized) {
      setMcpStatus((m) => ({ ...m, [i]: { kind: "ok", text: "already authorized" } }));
      await refreshMcpOAuth(i, srv.name);
      await refreshMcpStates();
      return;
    }
    if (!r?.ok || !r.url) {
      setMcpStatus((m) => ({ ...m, [i]: { kind: "err", text: r?.error ?? "no response" } }));
      await refreshMcpOAuth(i, srv.name);
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
      setMcpOAuth((m) => ({ ...m, [i]: st }));
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
      if (m.name) void refreshMcpOAuth(i, m.name);
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
  type Section = "providers" | "runtime" | "appearance" | "mcp" | "tasks" | "archive" | "agents" | "update" | "help";
  const [section, setSection] = createSignal<Section>("providers");
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
    // where the explanations that used to sit permanently under the UI now live
    { key: "help", label: "❔ help", hint: "keyboard shortcuts and what each toggle does" },
  ];

  const agentIds = () => (props.cfg.agents ?? []).map((a: any) => a.id);

  // Theme state is owned by App (it paints `<html>`); these local names keep the appearance
  // panel readable without implying a second copy of the state.
  const customThemes = () => props.theme.themes();
  const fixedTheme = () => props.theme.activeId();
  const setFixedTheme = (v: string) => props.theme.setActive(v);
  const themeAuto = () => props.theme.auto();
  const setThemeAuto = (v: boolean) => props.theme.setAuto(v);
  const sysDarkTheme = () => props.theme.dark();
  const setSysDarkTheme = (v: string) => props.theme.setDark(v);
  const sysLightTheme = () => props.theme.light();
  const setSysLightTheme = (v: string) => props.theme.setLight(v);
  const setCustomThemes = (v: CustomTheme[]) => props.theme.setThemes(v);

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

  const save = async (e: Event) => {
    e.preventDefault(); setErr("");
    const providers = saveProviders();
    if (!providers) return;
    const cleanTasks = tasks()
      .filter((t) => t.id?.trim() || t.prompt?.trim())
      .map((t, i) => ({ id: t.id?.trim() || `task-${i + 1}`, agent: t.agent, schedule: t.schedule, prompt: t.prompt, ...(t.forked ? { forked: true } : {}) }));
    for (const t of cleanTasks) {
      if (!t.agent) { setErr(`task "${t.id}": agent is required`); return; }
      if (!t.schedule?.trim()) { setErr(`task "${t.id}": schedule is required`); return; }
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
      if (!name) { setErr("MCP: a server needs a name"); return; }
      if (seenMcp.has(name)) { setErr(`MCP: two servers are named "${name}"`); return; }
      seenMcp.add(name);
      if (transport === "stdio" ? !command : !url) {
        setErr(`MCP "${name}": ${transport === "stdio" ? "a command is" : "a url is"} required`);
        return;
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
        cleanMcp.map((m, i) => (m.name ? refreshMcpOAuth(i, m.name) : Promise.resolve())),
      );
      // one more pass after the connections settle
      setTimeout(() => {
        void refreshMcpStates();
        cleanMcp.forEach((m, i) => {
          if (m.name) void refreshMcpOAuth(i, m.name);
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
      const needing = mcpServers().filter(
        (m, i) =>
          savedNames.has(String(m.name ?? "").trim()) &&
          mcpOAuth()[i]?.required &&
          !mcpOAuth()[i]?.authorized,
      );
      const newlyNeeding = needing.filter((m) => !props.announcedOAuth.has(String(m.name ?? "")));
      const needsAction = newlyNeeding.length > 0;
      if (needsAction) {
        // remember it, so the NEXT save closes instead of interrupting again
        for (const m of newlyNeeding) props.announcedOAuth.add(String(m.name ?? ""));
        setSection("mcp");
        flashHint("a saved MCP server needs authorization — see 🔑 authorize");
      } else {
        props.onClose();
      }
    } catch (ex) { setErr((ex as Error).message); }
  };

  const numInput = (label: string, value: number, oninput: (v: number) => void, hint?: string) => (
    <label title={hint}>{label}
      <input type="number" min="0" value={value} oninput={(e) => oninput(Number(e.currentTarget.value))} />
    </label>
  );

  return (
    <Modal title="settings" onClose={props.onClose}>
      <form onsubmit={save} style="display:flex;flex-direction:column;gap:12px;min-height:0">
        {/* A MENU, not one long column. With several providers — each holding
            several keys (#170) — the stacked form was a wall of inputs whose extent
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
                  localStorage.setItem("teapot.theme.auto", e.currentTarget.checked ? "1" : "0");
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
                      localStorage.setItem("teapot.theme.dark", e.currentTarget.value);
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
                      localStorage.setItem("teapot.theme.light", e.currentTarget.value);
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
              <Show when={[...customThemes(), ...THEMES].some((t) => t.mode === group.mode)}>
                <div class="cfgsub" style="margin-bottom:var(--space-1)">{group.title}</div>
                <div class="themepick">
                  <For each={customThemes().filter((t) => t.mode === group.mode)}>
                    {(t) => (
                      <button
                        type="button"
                        class={"themecard" + (fixedTheme() === t.id ? " on" : "")}
                        title={`${t.label} (custom)${t.backgroundImage ? " · with a background image" : ""}`}
                        aria-pressed={fixedTheme() === t.id}
                        onclick={() => {
                          setFixedTheme(t.id);
                          localStorage.setItem("teapot.theme", t.id);
                        }}
                      >
                        <span class="themecard-preview"><ThemePreview palette={t.palette} /></span>
                        <span class="themecard-label">{t.label} ★</span>
                      </button>
                    )}
                  </For>
                  <For each={THEMES.filter((t) => t.mode === group.mode)}>
                    {(t) => (
                      <button
                        type="button"
                        class={"themecard" + (fixedTheme() === t.key ? " on" : "")}
                        title={`${t.label} (${t.mode})`}
                        aria-pressed={fixedTheme() === t.key}
                        onclick={() => {
                          setFixedTheme(t.key);
                          localStorage.setItem("teapot.theme", t.key);
                        }}
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
                  t.backgroundImage ? { ...t, backgroundImage: undefined, backgroundDim: undefined } : t,
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
              setFixedTheme(id);
              localStorage.setItem("teapot.theme", id);
            }}
          />
        </fieldset>

        <fieldset classList={{ hide: section() !== "runtime" }}>
          <legend>agent runtime</legend>
          <div class="cfggrid">
            {numInput("progress interval (min)", intervalMin(), (v) => setIntervalMin(v), "how often the harness asks for a progress report")}
            {numInput("progress min chars", minChars(), (v) => setMinChars(v), "progress prompts wait for this much real output")}
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
            {numInput("context window (k tok)", ctxWinK(), (v) => setCtxWinK(v), "model's real window — 0/blank hides the % gauge")}
            {numInput("max spawn depth", maxDepth(), (v) => setMaxDepth(v), "sub-agent nesting limit (0 = no spawning)")}
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
            short-context mode (#161)
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
                        oninput={(e) => upd({ url: e.currentTarget.value })}
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
                    <div class="cfgrow">
                      <input
                        placeholder="headers as JSON, e.g. {&quot;Authorization&quot;:&quot;Bearer …&quot;}"
                        value={mcpHeadersText()[i] ?? ""}
                        oninput={(e) => {
                          const t = e.currentTarget.value;
                          setMcpHeadersText((m) => ({ ...m, [i]: t }));
                          // parse eagerly so a typo is visible here, not as a 401 later
                          if (!t.trim()) upd({ headers: undefined });
                          else {
                            try {
                              upd({ headers: JSON.parse(t) });
                              setMcpHeaderErr((m) => ({ ...m, [i]: "" }));
                            } catch {
                              setMcpHeaderErr((m) => ({ ...m, [i]: "not valid JSON — not applied" }));
                            }
                          }
                        }}
                        title="static headers for every request — the local equivalent of a token store"
                      />
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
                            | { ok?: boolean; tools?: { name: string }[]; error?: string }
                            | null;
                          setMcpStatus((m) => ({
                            ...m,
                            [i]: r?.ok
                              ? { kind: "ok", text: `${r.tools?.length ?? 0} tools` }
                              : { kind: "err", text: r?.error ?? "no response" },
                          }));
                          // A failed test may be a MISSING GRANT rather than a wrong url.
                          // The status endpoint reports what the connect attempt found, so
                          // "authorize" appears without the operator diagnosing a 401.
                          if (!r?.ok) await refreshMcpOAuth(i, patch.name);
                        }}
                        title="connect now and list the tools — nothing is saved"
                      >test</button>
                      {/* OAuth: offer "authorize" when the 401 challenge said this
                          server wants a grant. Without this the operator sees only
                          "error" and has to know the difference between a bad header
                          and a missing grant. */}
                      <Show when={mcpOAuth()[i]?.required && !mcpOAuth()[i]?.authorized}>
                        <button
                          type="button"
                          class="archrestore"
                          onclick={() => void startMcpOAuth(i, srv())}
                          title="start the OAuth flow: a browser tab opens, and the tools appear when you finish"
                        >🔑 authorize</button>
                      </Show>
                      <Show when={mcpOAuth()[i]?.authorized}>
                        <span class="mcpstate connected" title="an OAuth access token is usable">
                          🔑 authorized
                        </span>
                        <button
                          type="button"
                          onclick={async () => {
                            await api("/api/mcp/oauth/disconnect", {
                              method: "POST",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({ name: srv().name }),
                            }).catch(() => {});
                            await refreshMcpOAuth(i, srv().name);
                            setMcpStatus((m) => ({ ...m, [i]: { kind: "ok", text: "disconnected" } }));
                          }}
                          title="forget the stored grant (the refresh token is deleted)"
                        >disconnect</button>
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
                      <div
                        class="mcpresult"
                        style={mcpStatus()[i]?.kind === "err" ? "color:var(--err)" : "color:var(--ok)"}
                      >{mcpStatus()[i]?.text}</div>
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
                  // Success — the server will restart. Wait until the NEW
                  // server actually answers, then reload. Comparing versions
                  // alone was not enough: during the handover the old process
                  // is still serving /api/version, so a reload fired too early
                  // landed on a port nobody was listening on (#35).
                  btn.textContent = "restarting…";
                  let reloaded = false;
                  for (let i = 0; i < 90 && !reloaded; i++) {
                    await new Promise((r) => setTimeout(r, 1000));
                    try {
                      const v = await api("/api/version");
                      if (v.version && v.version !== __APP_VERSION__) {
                        // New version is serving AND it answered — safe to reload
                        reloaded = true;
                        window.location.reload();
                      }
                    } catch {}
                  }
                  if (!reloaded) throw new Error("restart timeout — new server did not come up");
                } catch (ex) {
                  setErr((ex as Error).message);
                } finally {
                  (e.currentTarget as HTMLButtonElement).disabled = false;
                  (e.currentTarget as HTMLButtonElement).textContent = "update & restart";
                }
              }}
              style="background:var(--acc);border:none;border-radius:6px;color:#fff;padding:6px 14px;cursor:pointer"
            >
              update & restart
            </button>
            <span class="muted" style="margin-left:8px;font-size:12px">gracefully stops all agents, spawns new process, then reloads this page</span>
          </div>
        </fieldset>

        <fieldset classList={{ hide: section() !== "help" }}>
          <legend>help</legend>
          {/* Everything here used to sit permanently in the UI — a keyboard cheat-sheet under
              the composer and a sentence beside each toggle. Read once, then in the way
              forever. Gathered here it is found when someone actually asks. */}
          <div class="helpsec">
            <h4 class="cfgsub">keyboard</h4>
            <div class="helprow"><kbd>enter</kbd><span>send (shift+enter for a newline)</span></div>
            <div class="helprow"><kbd>↑</kbd><kbd>↓</kbd><span>move between sessions</span></div>
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
          <button type="submit" class="cfgsave">save settings</button>
        </div>
      </form>
    </Modal>
  );
}
