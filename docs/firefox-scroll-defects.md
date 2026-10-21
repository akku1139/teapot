# Firefox-specific scroll defects in teapot's feed

Two reported bugs reproduce **only in Firefox**. Both are Gecko behaviours that Chromium masks,
and both are documented here with the upstream evidence, because "it works in Chrome" is exactly
the reasoning that would have had us close these as unreproducible.

**Reported on Firefox Developer Edition 159.0b3.** That matters: these are not old bugs that a
release upgrade would fix. Gecko 159 is the current beta, so both behaviours are present in the
build that will ship next — and the upstream Gecko gaps below are still OPEN, so an upgrade is
not the answer either.

Confirmed against Bugzilla at the time of writing: **1940025** is `NEW` with no activity since
2025-02-11, and **1908582** is `NEW`. Neither is marked fixed, so nothing here is "wait for the
next release".

## 1. Typing into a multi-line composer pulls the timeline back

### Symptom

With the composer grown to 2+ lines, typing moves the feed. The scroll position returns to what
it was at the *un-grown* composer height. Chrome is unaffected.

### Cause: this is scroll anchoring, not the composer

When content above the viewport changes size, browsers adjust `scrollTop` to keep a chosen
"anchor" element visually still. That is **scroll anchoring**, and it is on by default.

- The composer is a **sibling** of `.feed`, not an ancestor: growing it shrinks the feed's
  viewport and moves the FLOOR (the maximum `scrollTop`), without touching `scrollTop`.
- Gecko recalculates the anchor and applies an adjustment; Chromium's choice of anchor and its
  recalculation are conservative enough here that nothing visible happens.

Critically, the adjustment arrives as an **ordinary `scroll` event**. To the feed's follow
policy it is indistinguishable from the reader dragging the timeline up — so follow was dropped.

### Why `overflow-anchor` on `.feed` is the correct fix, not a workaround

The CSS Scroll Anchoring spec lists **suppression triggers** — operations that cancel an
adjustment. A height/margin/padding change on "any element in the path from the anchor node to
the scrollable element" suppresses it (csswg-drafts `css-scroll-anchoring-1/Overview.bs`).

The composer is **not** on that path: it is not an ancestor of any row inside the scroller. So
the spec does not suppress the adjustment here, and Gecko's behaviour is within spec.

teapot already owns this responsibility:

- while **following**, `pinToTail()` puts the view at the tail;
- while **reading**, `firstVisibleRow()` + `scrollTop += delta` preserves the topmost row.

So the native mechanism can only fight the policy. `overflow-anchor: none` on `.feed` is the
sanctioned exclusion (MDN: "if a node doesn't seem to be an appropriate anchor, you can exclude
it using `overflow-anchor`"). The surveyed harnesses all make the same choice: fluxer sets
`overflow-anchor: none` on its scroller and content column, opencode and deepseek-harness toggle
it off while following.

### Second half of the fix: sample geometry on box changes too

Even with anchoring off, the policy compared a delivered viewport height against the previous
**sample**, and samples only advanced inside the scroll handler. Firefox can deliver the scroll
produced by a resize before the resize has been observed, so the comparison used PRE-resize
geometry, saw no change, and blamed the reader. `restoreAfterBoxChange()` now records
`scrollHeight`/`clientHeight` on every box change, so whichever fires first the comparison is
against current geometry.

## 2. Scrolling up through a loaded session creeps

### Symptom

In a long session, browsing upward drifts a few pixels per row, in the direction of travel.
Chrome does not drift.

### Cause: a `content-visibility` unskip is not compensated by Gecko

`.feed > .msg` carries `content-visibility: auto` with `contain-intrinsic-size: auto 140px`.
Rows outside the viewport are laid out as a **placeholder** of 140px until they approach the
viewport, then laid out for real.

MDN is explicit that a mismatch between placeholder and real size "might force a new layout".
When the unskipped row is **above** the reader, everything below shifts.

- **Chromium** keeps the reader's position stable across an unskip, and reports **no layout
  shift** for it at all — by design since M88 (`crbug 40733057`). That is why CLS metrics never
  flagged this and why the bug looked Firefox-only rather than "unskip is uncompensated".
- **Gecko** does not, and the gaps are tracked upstream and still **OPEN**:
  - Bugzilla **1940025** (`NEW`; last activity 2025-02-11) — "Navigating to URL with anchor
    scrolls to incorrect location in nodejs.org (with content-visibility: auto)"
  - Bugzilla **1908582** (`NEW`) — WPT `content-visibility-anchor-positioning-002` and `-003`
    failing
  - Bugzilla **1660384** is the implementation bug for the property itself.

  Both are unfixed in **159.0b3**, the beta build this was reported on, so this is not something
  a release upgrade will clear.

So this is not a teapot bug and not a spec violation we can point at — it is a known Gecko gap
in an otherwise shipped feature.

### Workaround

An unskip does **not** fire a `ResizeObserver`: the feed's own border box is unchanged, only the
rows inside it. It **does** change `scrollHeight`, which the scroll handler already classifies as
a `layout` cause.

So the row the reader is looking at is recorded (throttled, while parked) and re-applied when a
`layout`-cause delivery coincides with a height change:

```
cause === "layout" && !atTail && height changed  ->  resyncAfterUnskip(el, unskipAnchor)
```

which is `scrollTop += (row.top - anchor.top)` — the same correction the resize path uses. A
sub-pixel difference is ignored, because correcting rounding would add jitter rather than remove
it.

**Why not fix it in CSS.** The alternative is a larger or more accurate
`contain-intrinsic-size`, and that trades one problem for another: the rows vary by three orders
of magnitude (message median 105 chars, max 1186; tool_result median 279, max 8000), so any fixed
placeholder is wrong for most rows and the scrollbar jumps as they render. `auto` already
remembers each row's real size after its first layout; the residue is the first visit, which is
what the script compensates for.

**Why not drop `content-visibility`.** It is what keeps ~1,100 rows at ~11 nodes each from being
laid out and painted on open (#143, #179). The earlier attempt to tune it with a per-row
IntersectionObserver made the UI unusable — see the comment in `frontend/app.css`.

## Detecting the platform

The compensation is cheap and harmless where it is unnecessary (Chromium's delta is ~0, and the
`< 1px` guard skips it), so it is **not** gated on browser detection. Feature-sniffing Gecko is
fragile and a UA check would silently stop compensating the moment Firefox changed its string.

## Sources

- MDN, *Scroll anchoring overview* — mechanism, suppression triggers, `overflow-anchor` as the
  exclusion API, and the `about:config` switches for debugging it.
- W3C csswg-drafts, `css-scroll-anchoring-1/Overview.bs` — the normative list of suppression
  triggers quoted above.
- MDN, *`contain-intrinsic-size`* — "if there is a difference between the placeholder and
  calculated size this might force a new layout".
- MDN, *Scroll anchoring for web developers* (Chromium, 2017) — the original rationale.
- Bugzilla 1940025, 1908582, 1660384 — the open Gecko gaps.
- `crbug 40733057` — Chromium deliberately reports no layout shift for an unskip.
