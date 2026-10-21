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

The composer is **not** on that path: it is not an ancestor of any row inside the scroller.
That reading means the spec does not suppress the adjustment here — so Gecko's behaviour is
**not a conformance bug**, which is the point. (Stated as a reading of the normative text, not a
citation: the spec does not discuss a sibling resizing the scroller's own box.)

teapot already owns this responsibility:

- while **following**, `pinToTail()` puts the view at the tail;
- while **reading**, `firstVisibleRow()` + `scrollTop += delta` preserves the topmost row.

So the native mechanism can only fight the policy. `overflow-anchor: none` on `.feed` is the
sanctioned exclusion (MDN: "if a node doesn't seem to be an appropriate anchor, you can exclude
it using `overflow-anchor`"). The surveyed harnesses all make the same choice: fluxer sets
`overflow-anchor: none` on its scroller and content column, opencode and deepseek-harness toggle
it off while following.

**Verified in Gecko's source, not just in the spec.** `layout/generic/ScrollAnchorContainer.cpp`
bails out of anchor selection when the scroll frame carries the property:

```cpp
const nsStyleDisplay& disp = *Frame()->StyleDisplay();
// Don't select a scroll anchor if the scroll frame has `overflow-anchor:
// none`.
if (disp.mOverflowAnchor != mozilla::StyleOverflowAnchor::Auto) {
  return false;
}
```

That is `CanMaintainAnchor()`, i.e. the first gate before any adjustment work. So the CSS fix is
not a "maybe it helps" — Gecko has an explicit, first-class off switch, and we are using it for
the purpose it exists. Blink honours the same property.

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

- **Chromium deliberately compensates, and the source proves it.** This is not inference: Blink
  carries a dedicated flag for exactly this case in
  `third_party/blink/renderer/core/layout/scroll_anchor.h`:

  ```cpp
  // This is set to true if the last anchor we have selected is a
  // 'content-visibility: auto' element that did not yet have a layout after
  // becoming visible.
  bool anchor_is_cv_auto_without_layout_ = false;
  ```

  set in `scroll_anchor.cc` right after the anchor is chosen:

  ```cpp
  anchor_is_cv_auto_without_layout_ =
      DisplayLockUtilities::IsAutoWithoutLayout(*anchor_object);
  ```

  and then **consulted when computing the adjustment** (`scroll_anchor.cc`, `ComputeAdjustment`):

  ```cpp
  if (anchor_is_cv_auto_without_layout_) {
    // See the effect delta would have on the anchor rect.
    // If the anchor is now off-screen (in block direction) then make sure it's
    // just at the edge.
    anchor_rect.Move(-PhysicalOffset(delta));
    ...
      delta.set_y(delta.y() + anchor_rect.Bottom().ToInt());
  }
  ```

  `IsAutoWithoutLayout` (`display_lock_utilities.cc`) is
  `!context->IsLocked() && context->IsAuto() && !context->HadLifecycleUpdateSinceLastUnlock()` —
  i.e. "this is a `content-visibility: auto` box that has not been laid out since it unlocked".

  So Blink names the situation in a comment, tracks it through anchor selection, and
  special-cases the scroll adjustment for it. This is the mechanical reason the bug is
  Firefox-only, and it is why the workaround belongs in our code: we are reproducing a
  deliberate engine behaviour that only one engine implements.

  (The `crbug 40733057` reference in `frontend/app.css` — "no layout shift for an unskip" — could
  not be re-verified when this was written, because both Google issue trackers require
  authentication. It is consistent with the code above and is left in place, but the code is the
  evidence, not the bug number.)

- **Gecko has no equivalent, verified by reading its side.** MEASURED against
  `mozilla-firefox/firefox` @ `main`:

  ```
  $ gh search code "content-visibility|DisplayLock" \
      --repo mozilla-firefox/firefox layout/generic/ScrollAnchorContainer.cpp
  (no matches)
  ```

  `layout/generic/ScrollAnchorContainer.cpp` — Gecko's whole scroll-anchoring implementation —
  contains **no reference to `content-visibility`, `DisplayLock`, or any display-lock utility**.
  Its adjustment path (`ApplyAdjustments`) computes the anchor's movement and applies it; there
  is no branch that asks whether the anchor was a not-yet-laid-out `content-visibility: auto`
  box. So a placeholder being replaced by a real layout is, to Gecko, just content moving —
  and it compensates by exactly the amount of the mismatch, which is the drift.

  Blink's equivalent branch exists because someone wrote it on purpose for this case; Gecko
  simply never got one. That is the asymmetry, in source.

  **And Gecko's own test expectations admit it.** Its WPT metadata — checked into
  `mozilla-firefox/firefox` — marks the off-screen case as a known failure:

  ```
  testing/web-platform/meta/layout-instability/content-visibility-auto-offscreen.html.ini
  [content-visibility-auto-offscreen.html]
    [off-screen content-visibility:auto]
      expected: FAIL

  testing/web-platform/meta/layout-instability/content-visibility-auto-resize.html.ini
  [content-visibility-auto-resize.html]
    [off-screen content-visibility:auto]
      expected: FAIL
  ```

  An `expected: FAIL` in that tree is the engine team's own record that the behaviour is wrong
  and unimplemented. So this is not "our app misusing the feature" and not something to wait
  out: it is a documented Gecko gap, in Gecko's repository, for the exact scenario the operator
  hit.

  For completeness, both engines otherwise agree in shape: Gecko has
  `ScrollAnchorContainer::SuppressAdjustments()` called from `RestyleManager.cpp` for
  style/anchor-node changes, and its `ApplyAdjustments()` bails on the same kinds of conditions
  Blink does (`mAnchorNodeIsDirty`, pending restoration, script-driven animation, zero scroll
  position). The divergence is narrow and specific: the `content-visibility: auto` unskip.
- **Gecko** does not, and the gaps are tracked upstream and still **OPEN**:
  - Bugzilla **1940025** (`NEW`; last activity 2025-02-11) — "Navigating to URL with anchor
    scrolls to incorrect location in nodejs.org (with content-visibility: auto)"
  - Bugzilla **1908582** (`NEW`) — WPT `content-visibility-anchor-positioning-002` and `-003`
    failing. **These are about CSS *anchor positioning* (`anchor-name`, `position: absolute`),
    which is a DIFFERENT feature from scroll anchoring** — the titles are
    "hidden never anchors" / "auto still anchors even if the anchor and positioned element are
    both skipped". They are evidence that Gecko's content-visibility has open anchor-related
    gaps, not evidence about the scroll-anchoring interaction this document is about. Read them
    as context, not as proof.
  - Bugzilla **1660384** is the implementation bug for the property itself.

  Both are unfixed in **159.0b3**, the beta build this was reported on, so this is not something
  a release upgrade will clear.

  **No upstream test covers `auto` unskip, which is why the asymmetry survives.**
  MEASURED by listing the WPT tree: `css/css-scroll-anchoring/` holds 93 tests and exactly one
  mentions `content-visibility` — `content-visibility-hidden-in-size-container.html`, whose
  assertion is about *`: hidden`* being added or locked inside a size container. **Nothing tests
  `: auto` unskipping.** The `content-visibility-anchor-positioning-*` files in
  `css-contain/` all exercise CSS *anchor positioning* (`anchor-name`, `position: absolute`),
  a different feature again.

  So neither engine can fail a shared test here. Chromium's handling exists because a Blink
  engineer wrote it deliberately (the `anchor_is_cv_auto_without_layout_` flag above), not
  because a test forced it — and Gecko simply never implemented the equivalent. That is the
  mechanical reason one engine does what users expect and the other does not.

  The css-contain-2 spec is silent on it too — searching the normative text for
  "scroll position" / "scroll anchoring" / "preserve" turns up nothing about unskip — so
  preserving the reader's position is **implementation-defined**, not a conformance
  requirement. That is why the fix is a workaround in our code rather than a bug we can point
  at.

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

Primary — **engine source, read directly** (`gh api`, no clones):

- `chromium/chromium` @ `main`, `third_party/blink/renderer/core/layout/scroll_anchor.h` — the
  `anchor_is_cv_auto_without_layout_` flag and its explanatory comment.
- `chromium/chromium` @ `main`, `.../layout/scroll_anchor.cc` — where the flag is set
  (`IsAutoWithoutLayout`) and where `ComputeAdjustment` branches on it.
- `chromium/chromium` @ `main`, `.../core/display_lock/display_lock_utilities.cc` —
  `IsAutoWithoutLayout` (`!IsLocked && IsAuto && !HadLifecycleUpdateSinceLastUnlock`).
- `mozilla-firefox/firefox` @ `main`, `layout/generic/ScrollAnchorContainer.cpp` — no
  `content-visibility` / display-lock reference anywhere; `CanMaintainAnchor()` honouring
  `overflow-anchor: none`; `ApplyAdjustments()` and its bail conditions.
- `mozilla-firefox/firefox` @ `main`,
  `testing/web-platform/meta/layout-instability/content-visibility-auto-{offscreen,resize}.html.ini`
  — the checked-in `expected: FAIL` for off-screen `content-visibility: auto`.

Specification and vendor documentation:

- W3C csswg-drafts, `css-scroll-anchoring-1/Overview.bs` — the normative list of suppression
  triggers, and the exclusion API.
- W3C csswg-drafts, `css-contain-2/Overview.bs` — silent on scroll position across an unskip,
  i.e. implementation-defined.
- MDN, *Scroll anchoring overview* — mechanism, `overflow-anchor`, and the `about:config`
  switches for debugging it.
- MDN, *`contain-intrinsic-size`* — "if there is a difference between the placeholder and
  calculated size this might force a new layout".

Bug trackers:

- Bugzilla 1940025, 1908582, 1660384 — the open Gecko gaps.
- `crbug 40733057` — cited in `frontend/app.css`. **Could not be re-verified**: both
  `issuetracker.google.com` and `bugs.chromium.org` require authentication. Left as a pointer
  only; the Blink source above is the evidence.

Test coverage: WPT `css/css-scroll-anchoring/` (93 tests) contains exactly one `content-visibility`
test and it covers `: hidden`, not `: auto` unskip — which is why no shared test forces either
engine to agree here.
