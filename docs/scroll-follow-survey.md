# Scroll-follow: what five production UIs actually do

Surveyed while rewriting teapot's feed scroll policy for the third time. All sources read via
`gh api` raw content; no clones.

## The problem, stated properly

"Should the viewport follow the tail?" is not one question, because **four different things
move the viewport** and only one of them is the reader:

1. the reader scrolls / drags the scrollbar / pans on touch
2. the app writes `scrollTop` to follow the tail (the resulting event arrives later)
3. content above shrinks and the browser **clamps** `scrollTop` to the new floor
4. the viewport shrinks (the composer growing), so the floor moves without `scrollTop` moving

Cases 2–4 look identical to "the reader scrolled up" if you only compare positions. Every
earlier teapot fix compared positions and then widened a slack constant until the symptom was
hidden — which is why it kept coming back under a new name.

## What the five do

| | at-bottom test | who moved it | growth while following | growth while reading |
|---|---|---|---|---|
| **use-stick-to-bottom** | `scrollHeight - 1 - clientHeight - scrollTop <= 70` | `escapedFromLock` state; direction sets/clears it; wheel-up escapes on the input event | rAF spring toward the floor (damping 0.7 / stiffness 0.05) | nothing; relies on native scroll anchoring |
| **Fluxer** (Discord clone) | `scrollHeight - offsetHeight - scrollTop <= 8`, hysteresis to 64 while pinned, `&& !hasMoreAfter` | **height change ⇒ layout** (`pinnedToEnd = true`), else a changed `scrollTop` is the reader; explicit programmatic flag | `scrollTo(MAX_SAFE_INTEGER)`, `flushSync` before paint | per-message anchor restore (`anchorFindTopVisible` / `anchorFixScrollPosition`), `overflow-anchor: none` |
| **opencode** | `scrollHeight - clientHeight - scrollTop < 10`, plus a `canScroll` re-pin | "auto mark" = `{top, time}`, valid 1500 ms and within 2 px; geometry checked BEFORE attribution | ResizeObserver on content, scroll in the delivery (before paint) | nothing except the `canScroll` re-pin; `overflow-anchor` = `auto` while scrolled up, `none` while following |
| **deepseek-harness** | `abs(floor - top) <= 25` where `floor = scrollHeight - clientHeight` | **observed-top ledger**: `movedByReader = abs(top - min(ledger, floor)) > 0.5` | ResizeObserver → `followTail()` | semantic anchor (turn/row) restore; a pending unsampled reader gesture wins over a resize |
| **open-webui** | `scrollHeight - scrollTop <= clientHeight + 50` | **none at all** — recomputed on every scroll | rAF-coalesced `autoScrollToBottom()` per chunk, two-rAF re-scroll | n/a (no attribution, so it cannot tell) |

## The two mechanisms worth taking

**The observed-top ledger** (deepseek-harness, `use-scroll-follow.ts`). Record where each
programmatic write put `scrollTop`. Classify a delivery by whether it matches
`min(ledger, floor)`:

```ts
movedByReader = Math.abs(metrics.top - Math.min(this.observation.top, metrics.floor)) > 0.5
```

The `min(ledger, floor)` is the whole trick:
- our own late-delivered write lands exactly on `ledger` → not the reader
- a shrink clamp lands exactly on the **new** floor, which is `min(ledger, floor)` → not the reader

**Height-change attribution** (Fluxer, `ScrollManager.ts`). The reader cannot change
`scrollHeight`, so a delivery that follows a height change carries no evidence about intent:

```ts
const heightChanged = state.offsetHeight !== this.cacheOffsetHeight ||
                      state.scrollHeight !== this.cacheScrollHeight;
const pinnedToEnd = (heightChanged && this.pinIsAtBottom) || this.pinIsScrollingProgrammatically
  ? true : pinState.isPinned;
```

## What teapot does now

`frontend/scroll-policy.ts` implements both, plus a **third** case none of the five had to
handle because none of them owns a composer that resizes the same column: a **viewport** change
is layout too. That is the literal cause of "入力欄が2行以上に拡大するとちょっと上にスクロールする".

```
classifyScroll(now, ledger, lastHeight, lastViewport) -> "reader" | "programmatic" | "layout"
```

Order matters and is the fix:
1. viewport or height changed ⇒ `layout` (cases 3 and 4)
2. position equals `min(ledger, floor)` ⇒ `programmatic` (case 2)
3. otherwise ⇒ `reader` (case 1)

`nextFollowing()` only lets `reader` turn following OFF, and arriving at the tail always turns
it back ON whoever caused it. `shouldPin()` adds fluxer's hysteresis (`STICKY_PX = 64` vs an
`AT_TAIL_PX = 24` acquire range) so a streaming bubble that overshoots for one frame does not
unpin itself.

Deliberately **not** taken:
- `overflow-anchor` juggling: teapot's feed has `content-visibility: auto` rows and a
  row-identity anchor restore that already covers the reading case, so a second anchoring
  mechanism would fight it.
- per-round animation (spring/easing) toward the floor: teapot writes once per layout change
  and the browser clamps, which is cheaper and has no duration to get wrong.
- any sentinel/IntersectionObserver: **none of the five use one.**
