/**
 * Reserving a row's REAL height so `content-visibility` cannot move the scroll position.
 *
 * The mechanism, and why it is not optional: `content-visibility: auto` lays a row out only
 * when it is near the viewport, using `contain-intrinsic-size` as a placeholder meanwhile.
 * When the row is finally laid out, any difference between placeholder and reality shifts
 * everything above it. Rows here differ by three orders of magnitude (measured: message
 * median 105 chars / max 1186; tool_result median 279 / max 8000), so a single guess is
 * always wrong somewhere — which is the Firefox report. Chromium does not report it as CLS
 * (crbug 40733057, by design since M88), which is why it looked like a Firefox-only bug.
 *
 * The fix is Alex Russell's: once a row HAS been laid out, its height is known, so write it
 * back as the placeholder. `frontend/feed-reserve.ts` does that; these tests drive it with
 * stub observers, because happy-dom implements neither observer nor layout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reserveRowSizes } from "../frontend/feed-reserve.ts";

/** a fake element: just enough for the module (style, box, dataset) */
function fakeRow(height: number, width = 400) {
  const style = new Map<string, string>();
  const el = {
    style: {
      setProperty: (k: string, v: string) => style.set(k, v),
      getPropertyValue: (k: string) => style.get(k) ?? "",
    },
    getBoundingClientRect: () => ({ width, height }),
    offsetWidth: width,
    offsetHeight: height,
    __style: style,
  };
  return el as unknown as HTMLElement & { __style: Map<string, string> };
}

/** a container shaped like `.feed`: querySelectorAll("[data-eid]") returns the rows */
function fakeRoot(rows: HTMLElement[]) {
  return { querySelectorAll: () => rows } as unknown as HTMLElement;
}

/** drive one observer flush synchronously */
function flush() {
  const cbs = (globalThis as unknown as { __obs: (() => void)[] }).__obs;
  for (const cb of cbs.splice(0)) cb();
}

test("a laid-out row gets its real height reserved (#143)", () => {
  (globalThis as unknown as { __obs: (() => void)[] }).__obs = [];
  const el = fakeRow(212);
  reserveRowSizes(fakeRoot([el]));
  // the visible rows are measured immediately: a row that has never been laid out reports a
  // zero box, and reserving 0 would collapse it on its next skip
  assert.equal(
    el.__style.get("contain-intrinsic-size"),
    "400px 212px",
    "the measured box must be written back as the placeholder",
  );
});

test("a zero-height row is NOT reserved — reserving 0 would collapse it (#143)", () => {
  (globalThis as unknown as { __obs: (() => void)[] }).__obs = [];
  const el = fakeRow(0);
  reserveRowSizes(fakeRoot([el]));
  assert.equal(
    el.__style.get("contain-intrinsic-size"),
    undefined,
    "an unmeasured row must keep the stylesheet's guess, not be reserved as 0",
  );
});

test("a row that changes height later is RE-reserved (#143)", () => {
  // the case that makes a one-shot measurement useless: a `<details>` opening, a tool result
  // arriving, an image loading. The reservation has to follow, or the NEXT revisit shifts.
  (globalThis as unknown as { __obs: (() => void)[] }).__obs = [];
  let h = 100;
  const style = new Map<string, string>();
  const el = {
    style: { setProperty: (k: string, v: string) => style.set(k, v), getPropertyValue: (k: string) => style.get(k) ?? "" },
    getBoundingClientRect: () => ({ width: 400, height: h }),
    offsetWidth: 400,
    get offsetHeight() {
      return h;
    },
  } as unknown as HTMLElement;
  // capture the ResizeObserver callback so the growth can be simulated
  let roCb: ((e: unknown[]) => void) | null = null;
  const RealRO = globalThis.ResizeObserver;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(cb: (e: unknown[]) => void) {
      roCb = cb;
    }
    observe() {}
    disconnect() {}
  };
  try {
    reserveRowSizes(fakeRoot([el]));
    assert.equal(style.get("contain-intrinsic-size"), "400px 100px");
    // PRECONDITION: the growth really reaches the observer, or the assertion below is vacuous
    // bind to a const: TS narrows a `let` assigned inside a closure to `never` afterwards
    const cb = roCb as unknown as (e: unknown[]) => void;
    assert.ok(cb, "the module must observe rows with a ResizeObserver");
    h = 260;
    cb([{ target: el }]);
    assert.equal(
      style.get("contain-intrinsic-size"),
      "400px 260px",
      "a row that grew must have its new height reserved",
    );
    // and an unchanged re-measure must NOT rewrite the style (sub-pixel churn)
    const before = style.get("contain-intrinsic-size");
    cb([{ target: el }]);
    assert.equal(style.get("contain-intrinsic-size"), before);
  } finally {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RealRO;
  }
});

test("disconnect stops the observers, and is safe to call twice (#143)", () => {
  (globalThis as unknown as { __obs: (() => void)[] }).__obs = [];
  let disconnected = 0;
  const RealRO = globalThis.ResizeObserver;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {
      disconnected++;
    }
  };
  try {
    const r = reserveRowSizes(fakeRoot([fakeRow(100)]));
    r.disconnect();
    assert.equal(disconnected, 1);
    r.disconnect();
    assert.equal(disconnected, 1, "a second disconnect must be a no-op");
  } finally {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RealRO;
  }
  void flush;
});
