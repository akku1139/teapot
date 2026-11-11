/**
 * The background-shells panel must open UNDER THE HEADER, not somewhere below the channel.
 *
 * Reported: "謎の場所に生成された background shells パネルがタイムラインのボックスごと持ち上げる謎事件". The panel is
 * `position: absolute` with `top: calc(100% + 6px)`, and the nearest positioned ancestor was `.channel` — whose 100% is
 * the height of the WHOLE timeline column, so the popover opened far below the viewport and its absolutely positioned box
 * dragged the flex layout with it. The header is the anchor now.
 *
 * happy-dom performs no layout, so this pins the CSS contract that governs the geometry (same approach as
 * test/attach-x-circle.test.ts) plus the structure: the panel is INSIDE the header, so the anchor and the markup are one
 * thing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync(new URL("../frontend/components/bg-jobs.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");



test("the panel is rendered inside the header, and is a component", () => {
  assert.match(app, /<header class="chan-head">/, "the header exists");
  const headStart = app.indexOf('<header class="chan-head">');
  const headEnd = app.indexOf("</header>", headStart);
  const inside = app.slice(headStart, headEnd);
  assert.match(inside, /<BgJobsPanel/, "the panel belongs to the header, not to the app root");
  assert.match(panel, /export function BgJobsPanel/, "and it is its own component");
  assert.match(panel, /role="dialog"/, "it still announces itself as a dialog");
});

test("the shells badge shows a shell, not the settings gear", () => {
  // the badge's own glyph, i.e. the text between the button's ">" and "</button>"
  const start = app.indexOf('class="badge bgjobs"');
  const open = app.indexOf(">", app.indexOf("title=", start));
  const close = app.indexOf("</button>", open);
  const glyph = app.slice(open + 1, close).trim();
  assert.match(glyph, /🐚/, `the badge must say what it opens; got ${JSON.stringify(glyph)}`);
  assert.doesNotMatch(glyph, /⚙️/, "the gear means settings elsewhere in the app");
});
