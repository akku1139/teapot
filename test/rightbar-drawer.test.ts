/**
 * The details panel is a STATIC COLUMN on a wide screen, but on a narrow one
 * (≤1100px) `.rightbar` turns into a fixed drawer that slides in over the
 * content — see the `@media (max-width: 1100px)` block in app.css.
 *
 * In that floating mode the panel had no way out:
 *
 *  1. the ONLY toggle was the ▤ button in the channel header, which the drawer
 *     (position:fixed, z-index:5, up to 92vw wide) covers completely — so
 *     opening it trapped you behind it;
 *  2. there was no backdrop, so no click-outside dismissal;
 *  3. Escape appeared to work, but only by accident: the keydown handler
 *     handled the running-agent interrupt FIRST, so while an agent was working
 *     Escape stopped the AGENT and left the drawer open — and on an idle agent
 *     it closed a drawer the operator could not see how to reopen.
 *
 * happy-dom does no layout, so the visible outcome is pinned as two contracts:
 * the markup must carry a close affordance that lives INSIDE the drawer, and
 * the Escape branch must be reachable before the interrupt branch. The
 * end-to-end behaviour is exercised in scripts/smoke-web.mjs, which renders the
 * real bundle and drives the drawer open and shut.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

/** the body of the `@media (max-width: 1100px)` block, braces balanced */
function narrowBlock(): string {
  const start = css.indexOf("@media (max-width: 1100px)");
  assert.notEqual(start, -1, "app.css must keep the narrow-screen media query");
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error("unterminated @media (max-width: 1100px) block");
}

/** body of the first rule whose selector list mentions `token` */
function ruleBody(token: string): string {
  let i = 0;
  for (;;) {
    const open = css.indexOf("{", i);
    if (open === -1) throw new Error(`no rule mentioning ${token}`);
    const prevClose = css.lastIndexOf("}", open);
    const selStart = prevClose === -1 ? 0 : prevClose + 1;
    let depth = 0;
    let close = -1;
    for (let j = open; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) { close = j; break; }
      }
    }
    if (close === -1) throw new Error("unterminated rule");
    if (css.slice(selStart, open).includes(token)) return css.slice(open + 1, close);
    i = close + 1;
  }
}

/* ---------- 1: the drawer carries its own close button ---------- */

test("the drawer has a close button of its own (#50)", () => {
  assert.ok(
    /class=\{"rightbarhead"/.test(app),
    "the panel needs a header row that hosts the ✕ button",
  );
  // the ✕ lives in the drawer's OWN header row, not the channel header the
  // drawer slides over and hides
  assert.ok(
    /class=\{"rightbarhead"[\s\S]{0,300}?icon="✕"[\s\S]{0,200}?close details panel/i.test(app),
    "the ✕ must sit inside the panel, where it is reachable once the drawer covers the header (#50)",
  );
  assert.ok(
    /class=\{"rightbarhead" \+ \(showRight\(\) \? " open" : ""\)\}/.test(app),
    "the header slides in WITH the drawer — a pinned ✕ over a hidden panel is worse than none",
  );
});

test("the close header only shows on a narrow screen (#50)", () => {
  // a static column has no need for a ✕ row — showing one on a wide screen
  // would add a dead control above the session card.
  assert.match(
    ruleBody(".rightbarhead"),
    /display:\s*none/,
    "the ✕ row must be hidden by default (wide screens keep the ▤ toggle)",
  );
  const narrow = narrowBlock();
  assert.match(
    narrow,
    /\.rightbarhead\s*\{[^}]*display:\s*flex/,
    "the ✕ row must appear inside the narrow media query (#50)",
  );
});

test("the ✕ row and the panel are stacked, never overlapped (#50)", () => {
  const narrow = narrowBlock();
  // THE regression this guards: a literal height in one rule and a literal
  // offset in another. They are separate numbers, so resizing the row (or a
  // font/zoom change altering its height) silently slides the panel's first
  // row under the ✕ bar — or opens a gap above it.
  assert.match(
    narrow,
    /\.rightbarhead\s*\{[^}]*--rightbarhead-h:/,
    "the header must declare its own height (#50)",
  );
  assert.match(
    narrow,
    /\.rightbar\s*\{[^}]*top:\s*var\(--rightbarhead-h/,
    "the panel must be offset by the header's height, not a second literal (#50)",
  );
  // and the header must actually be the height it declares
  assert.match(
    narrow,
    /\.rightbarhead\s*\{[^}]*height:\s*var\(--rightbarhead-h\)/,
    "a declared height nobody applies would leave the two boxes misaligned (#50)",
  );
});

/**
 * The ✕ row is a SIBLING of <aside class="rightbar">, not a descendant: the
 * panel is `overflow-y: auto`, so a close button inside it would scroll out of
 * reach — re-creating the bug one scroll away. A sticky child would have been
 * the in-panel alternative, but .rightbar carries tuned scroll-restore logic
 * (rightbarTop) and sticking a child into that container risks it.
 *
 * The cost of a sibling is that the drawer becomes TWO fixed boxes, which only
 * still reads as one drawer if they share an edge and a width. That is a CSS
 * invariant, so it is pinned here rather than left to visual inspection.
 */
test("the ✕ row and the panel share one edge — they read as a single drawer (#50)", () => {
  const narrow = narrowBlock();
  // NOTE: this selector must match ONLY the standalone drawer rule. `\.rightbar\s*\{`
  // also matches `.layout.right-hidden .rightbar { display: block }` earlier in
  // the block, which declares none of the properties below — the comparison
  // would fail on correct code. Require the line to start with `.rightbar`.
  const panel = narrow.match(/^\s*\.rightbar\s*\{[^}]*\}/m)?.[0] ?? "";
  assert.notEqual(panel, "", "the narrow standalone .rightbar rule must exist (#50)");
  const head = narrow.match(/^\s*\.rightbarhead\s*\{[^}]*\}/m)?.[0] ?? "";
  assert.notEqual(head, "", "the narrow .rightbarhead rule must exist (#50)");
  for (const decl of [/right:\s*0/, /width:\s*min\(420px,\s*92vw\)/, /position:\s*fixed/]) {
    assert.match(head, decl, `.rightbarhead must also set ${decl} so it lines up with the panel (#50)`);
    assert.match(panel, decl, `.rightbar must set ${decl} (#50)`);
  }
  // the header sits flush to the panel's top: its own `top` must be 0
  assert.match(
    head,
    /top:\s*0/,
    "a header offset from the top would open a gap above the drawer (#50)",
  );
});

/* ---------- 2: click outside dismisses the drawer ---------- */

test("a click outside the drawer closes it (#50)", () => {
  assert.ok(
    /class="rightbarbackdrop"/.test(app),
    "a click-outside layer is needed — the drawer covers the ▤ toggle (#50)",
  );
  // setRight, not a bare setShowRight: dismissing the drawer must also drop the
  // persisted "panel open" flag, or the next load re-opens the sheet that was
  // just dismissed — the same trap the ✕ and Escape paths avoid.
  assert.ok(
    /class="rightbarbackdrop"[^>]*onclick=\{\(\) => setRight\(false\)\}/.test(app),
    "the backdrop must close the panel",
  );
  assert.ok(
    /<Show when=\{isNarrow\(\) && showRight\(\)\}>/.test(app),
    "the backdrop must not exist while the drawer is closed — the drawer stays in the DOM " +
      "translated off-screen, and a full-screen layer would block the whole UI (#50)",
  );
});

test("the backdrop sits under the drawer and over the content (#50)", () => {
  assert.match(
    ruleBody(".rightbarbackdrop"),
    /z-index:\s*4/,
    "below .rightbar's z-index:5, otherwise it swallows the drawer's own clicks",
  );
  assert.match(
    narrowBlock(),
    /\.rightbar\s*\{[^}]*z-index:\s*5/,
    "the drawer must stay above its own backdrop (#50)",
  );
  assert.match(
    narrowBlock(),
    /\.rightbarhead\s*\{[^}]*z-index:\s*6/,
    "the ✕ row sits above both, so it stays clickable (#50)",
  );
  assert.match(
    ruleBody(".rightbarbackdrop"),
    /display:\s*none/,
    "a click-catcher around a static column would swallow every click in the app",
  );
  assert.match(
    narrowBlock(),
    /\.rightbarbackdrop\s*\{\s*display:\s*block/,
    "…so the narrow media query is what turns it on (#50)",
  );
});

/* ---------- 3: Escape reaches the drawer before the interrupt ---------- */

test("Escape closes the drawer before it can stop a running agent (#50)", () => {
  // Target the keydown handler's OWN Escape branch, not the earlier `typing`
  // one (which fires when the caret is in a field and merely blurs it).
  const start = app.indexOf('if (e.key === "Escape") {', app.indexOf('if (typing)'));
  assert.notEqual(start, -1, "the global keydown Escape branch must exist");
  const end = app.indexOf('if (showNew() || showCfg()) return;', start);
  const handler = app.slice(start, end === -1 ? start + 1400 : end);
  const drawerIdx = handler.search(/isNarrow\(\) && showRight\(\)/);
  // anchor on the actual REQUEST, not the "/stop" substring — a comment
  // mentioning the endpoint would otherwise satisfy this and hide a real
  // ordering regression behind it
  const stopIdx = handler.indexOf('api(`/api/agents/${s.id}/stop`');
  assert.ok(drawerIdx !== -1, "Escape must close the drawer");
  assert.ok(stopIdx !== -1, "the running-agent interrupt must still exist");
  assert.ok(
    drawerIdx < stopIdx,
    "THE regression: the drawer close must come BEFORE the /stop branch, or Escape " +
      "interrupts the agent and leaves the panel stuck open (#50)",
  );
});

/* ---------- 4: wide screens are untouched ---------- */

test("the backdrop is not rendered on a wide screen (#50)", () => {
  // the Show gate is asserted above; this pins the PREDICATE itself, which the
  // CSS media query and the JS must agree on
  assert.ok(
    /const isNarrow = \(\) => window\.innerWidth <= NARROW_PX;/.test(app),
    "narrow mode needs one predicate shared by every drawer-only branch (#50)",
  );
  assert.ok(
    /const NARROW_PX = 1100;/.test(app),
    "NARROW_PX must match the `@media (max-width: 1100px)` breakpoint in app.css (#50)",
  );
});
