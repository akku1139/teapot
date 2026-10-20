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

/* ---------- #177: the reservation must not cost CPU per frame ---------- */

test("an observer callback does NOT re-scan the whole feed (#177)", () => {
  // Reported: the frontend pegged a CPU core after v0.29.38.
  //
  // `adoptAll()` used to run on EVERY IntersectionObserver and ResizeObserver callback —
  // that is, on every scroll frame and every resize — and it was a `querySelectorAll` over
  // every row plus a Set membership test for each. On a long feed the result can only change
  // when the DOM changes, so a full query per frame bought nothing and cost O(rows).
  //
  // The invariant: pumping the observers must not scan the feed.
  (globalThis as unknown as { __obs: (() => void)[] }).__obs = [];
  let scans = 0;
  const rows = [fakeRow(100), fakeRow(120)];
  const root = {
    querySelectorAll: () => {
      scans++;
      return rows;
    },
  } as unknown as HTMLElement;
  const roCbs: ((e: unknown[]) => void)[] = [];
  const RealRO = globalThis.ResizeObserver;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(cb: (e: unknown[]) => void) {
      roCbs.push(cb);
    }
    observe() {}
    disconnect() {}
  };
  try {
    reserveRowSizes(root);
    // PRECONDITION: the initial adoption really scanned, or "0 further scans" is vacuous
    assert.ok(scans >= 1, `the initial adoption must scan the feed at least once; got ${scans}`);
    const afterMount = scans;
    // now pump both observers several times, as a scroll would
    for (let frame = 0; frame < 10; frame++) {
      for (const cb of roCbs) cb(rows.map((el) => ({ target: el, contentRect: { width: 400, height: 100 } })));
    }
    assert.equal(
      scans,
      afterMount,
      `observers re-scanned the feed ${scans - afterMount} time(s) for 10 frames — that is a ` +
        `full DOM query per frame, which is what burned the CPU (#177)`,
    );
  } finally {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RealRO;
  }
});

test("a fractional rect is ROUNDED, so both observers speak the same units (#177)", () => {
  // IntersectionObserver reports a fractional `boundingClientRect` (137.6) while
  // ResizeObserver's `offsetHeight` is always an integer. If the reservation stored the
  // fractional value, the row would carry `contain-intrinsic-size: 400.4px 137.6px` — and a
  // fractional placeholder is itself a source of sub-pixel drift: the row's real height is
  // an integer, so every visit differs by a fraction and the scroll nudges.
  //
  // This asserts the CONTRACT (the written value is integral), which is what makes the two
  // sources comparable. It is deliberately not a "cannot oscillate" test: the 1px
  // hysteresis already absorbs that, so such a test would pass on the unfixed code too.
  (globalThis as unknown as { __obs: (() => void)[] }).__obs = [];
  const els = [fakeRow(137.6, 400.4), fakeRow(212.5, 640.5)];
  reserveRowSizes(fakeRoot(els));
  assert.equal(
    els[0]!.__style.get("contain-intrinsic-size"),
    "400px 138px",
    "a fractional box must be rounded, not written through",
  );
  assert.equal(els[1]!.__style.get("contain-intrinsic-size"), "641px 213px");
});

test("dispose() releases every observer, so a re-arm cannot leak (#177)", () => {
  // The CPU burn came from the WIRING, not this module: App.tsx re-ran the effect on every
  // `chatEvents()` change and registered its cleanup from inside a requestAnimationFrame
  // callback, where Solid's Owner is already null — so `onCleanup` silently did nothing and
  // each render left a full set of observers alive.
  //
  // The module's half of that contract is that `disconnect()` really does release everything
  // it created. If it ever stopped, the (now correctly-registered) cleanup would be a no-op
  // and the leak would come back the moment anything re-armed it.
  (globalThis as unknown as { __obs: (() => void)[] }).__obs = [];
  const row = fakeRow(100);
  const asked: DOMRect = { width: 400, height: 100 } as DOMRect;
  let ioDisconnects = 0;
  let roDisconnects = 0;
  let moDisconnects = 0;
  let roObserved = 0;
  const RealIO = globalThis.IntersectionObserver;
  const RealRO = globalThis.ResizeObserver;
  const RealMO = globalThis.MutationObserver;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    constructor(_cb: (e: unknown[]) => void) {}
    observe() {}
    unobserve() {}
    disconnect() {
      ioDisconnects++;
    }
  };
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(_cb: (e: unknown[]) => void) {}
    observe() {
      roObserved++;
    }
    disconnect() {
      roDisconnects++;
    }
  };
  (globalThis as unknown as { MutationObserver: unknown }).MutationObserver = class {
    constructor(_cb: () => void) {}
    observe() {}
    disconnect() {
      moDisconnects++;
    }
  };
  try {
    const r = reserveRowSizes(fakeRoot([row]));
    // PRECONDITION: both row observers were really handed the row
    assert.equal(roObserved, 1, "the ResizeObserver must have been given the row");
    r.disconnect();
    assert.equal(ioDisconnects, 1, "the IntersectionObserver must be released");
    assert.equal(roDisconnects, 1, "the ResizeObserver must be released");
    assert.equal(moDisconnects, 1, "the MutationObserver must be released — it holds the feed");
  } finally {
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = RealIO;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RealRO;
    (globalThis as unknown as { MutationObserver: unknown }).MutationObserver = RealMO;
  }
  void asked;
});

test("adoption measures all rows BEFORE writing any, not read/write per row (#178)", () => {
  // Reported: "開いただけで重すぎてまともに操作できない" on v0.29.40.
  //
  // At mount this module adopted every row in the feed and, for each one, did
  // `getBoundingClientRect()` (forces layout) and then `el.style.setProperty(...)` (dirties
  // style). Read → write → read → write, once per row. On a real session that is ~16,600
  // forced reflows in one task — layout thrashing — which is why opening the UI froze it.
  //
  // Batching is the fix: all reads, then all writes, so the browser flushes layout once.
  // The invariant is the ORDER, so record the interleaving.
  (globalThis as unknown as { __obs: (() => void)[] }).__obs = [];
  const ops: string[] = [];
  const rows = Array.from({ length: 20 }, (_, i) => {
    const style = new Map<string, string>();
    return {
      style: {
        setProperty: (k: string, v: string) => {
          ops.push("write");
          style.set(k, v);
        },
        getPropertyValue: (k: string) => style.get(k) ?? "",
      },
      getBoundingClientRect: () => {
        ops.push("read");
        return { width: 400, height: 100 + i };
      },
      offsetWidth: 400,
      offsetHeight: 100 + i,
      __style: style,
    } as unknown as HTMLElement;
  });
  reserveRowSizes(fakeRoot(rows));

  // PRECONDITION: every row was really measured and reserved, or the order proves nothing
  assert.equal(ops.filter((o) => o === "read").length, rows.length, "every row must be measured once");
  assert.equal(ops.filter((o) => o === "write").length, rows.length, "every row must be reserved once");

  // the last read must come before the first write: no interleaving anywhere
  const lastRead = ops.lastIndexOf("read");
  const firstWrite = ops.indexOf("write");
  assert.ok(
    lastRead < firstWrite,
    `reads and writes interleaved (last read at ${lastRead}, first write at ${firstWrite}) — ` +
      `each pair forces a reflow, so ${rows.length} rows means ${rows.length} layout flushes (#178)`,
  );
});
