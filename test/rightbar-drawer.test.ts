import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

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

function baseRuleBody(token: string): string {
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
    const before = css.slice(0, open);
    const mediaDepth = (before.match(/\{/g)?.length ?? 0) - (before.match(/\}/g)?.length ?? 0);
    const sel = css.slice(selStart, open).replace(/\/\*[\s\S]*?\*\//g, "");
    if (sel.includes(token) && mediaDepth === 0) return css.slice(open + 1, close);
    i = close + 1;
  }
}

test("the ✕ row is STICKY — the panel scrolls, the close button must not (#50)", () => {
  const narrow = narrowBlock();
  assert.match(
    narrow,
    /\.rightbar \.rightbarhead\s*\{[^}]*position:\s*sticky/,
    "the ✕ row must be sticky inside the scrolling panel (#50)",
  );
  assert.match(
    narrow,
    /\.rightbar \.rightbarhead\s*\{[^}]*top:\s*0/,
    "sticky with no top offset pins to the wrong edge (#50)",
  );
  const base = baseRuleBody(".rightbarhead");
  assert.match(
    base,
    /background:\s*var\(--bg-dark\)/,
    "a sticky row without a background shows the panel's text through the ✕ (#50)",
  );
  assert.match(
    base,
    /border-bottom:\s*1px solid var\(--line\)/,
    "content scrolling under a bare row reads as broken (#50)",
  );
  assert.match(
    base,
    /margin:\s*0;/,
    "no negative margin on the row — it cannot move a sticky box, and it left a 14px gap (#50)",
  );
  const narrow2 = narrowBlock();
  assert.match(
    narrow2,
    /\.rightbar:has\(\.rightbarhead\)\s*\{[^}]*padding-top:\s*0/,
    "the PANEL must drop its top padding so the sticky row is flush with the top edge (#50)",
  );
});

test("the close row only shows on a narrow screen (#50)", () => {
  assert.match(
    baseRuleBody(".rightbarhead"),
    /display:\s*none/,
    "the ✕ row must be hidden by default (wide screens keep the ▤ toggle)",
  );
  assert.match(
    narrowBlock(),
    /\.rightbar \.rightbarhead\s*\{[^}]*position:\s*sticky/,
    "the narrow media query is what makes it a real, visible row (#50)",
  );
});

test("the drawer is ONE fixed box again (#50)", () => {
  const narrow = narrowBlock();
  assert.match(
    narrow,
    /\.rightbar\s*\{[^}]*position:\s*fixed[^}]*top:\s*0/,
    "the panel must be flush to the top of the screen (#50)",
  );
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    !/--rightbarhead-h\s*:/.test(cssNoComments),
    "the two-box height coupling must be gone now that the ✕ is inside the panel (#50)",
  );
  assert.match(
    narrow,
    /\.rightbar \.rightbarhead\s*\{[^}]*position:\s*sticky[^}]*\}/,
    "…replaced by a sticky child of that one box (#50)",
  );
});

test("the panel's first heading keeps margin-top:0 (#50)", () => {
  assert.match(
    baseRuleBody(".rightbar h3:first-of-type"),
    /margin-top:\s*0/,
    "the first section heading must stay flush (#50)",
  );
  assert.ok(
    !/\.rightbar h3:first-child/.test(css),
    ":first-child stops matching once the ✕ row is the panel's first child (#50)",
  );
});

test("the close row is VISIBLE on a narrow screen, not merely present (#50)", () => {
  const narrow = narrowBlock();
  const row = narrow.match(/^\s*\.rightbar \.rightbarhead\s*\{[^}]*\}/m)?.[0] ?? "";
  assert.notEqual(row, "", "the narrow .rightbarhead rule must exist (#50)");
  assert.match(
    row,
    /display:\s*flex/,
    "the narrow query must set display:flex — the base rule is display:none, so " +
      "without this the close button renders invisible (#50)",
  );
  assert.match(
    ruleBody(".rightbarhead"),
    /display:\s*none/,
    "…and the base rule must still hide it on a wide screen (#50)",
  );
});

test("narrow-only rules out-specify their base counterparts (#50)", () => {
  const narrow = narrowBlock();
  assert.match(
    narrow,
    /\.rightbar \.rightbarhead\s*\{/,
    "the narrow ✕ rule must be scoped (.rightbar .rightbarhead) to outrank the base rule (#50)",
  );
  assert.match(
    narrow,
    /\.layout \.rightbarbackdrop\s*\{/,
    "the narrow backdrop rule must be scoped (.layout .rightbarbackdrop) to outrank the base rule (#50)",
  );
  assert.ok(
    !/^\s*\.rightbarhead\s*\{/m.test(narrow),
    "a bare .rightbarhead in the media query loses the cascade after minification (#50)",
  );
  assert.ok(
    !/^\s*\.rightbarbackdrop\s*\{/m.test(narrow),
    "a bare .rightbarbackdrop in the media query loses the cascade after minification (#50)",
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
    /\.rightbarhead\s*\{[^}]*z-index:\s*1/,
    "the sticky ✕ row must out-stack the content that scrolls under it (#50)",
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
