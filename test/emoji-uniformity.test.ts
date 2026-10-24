import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

/**
 * Emoji that are TEXT-BY-DEFAULT need U+FE0F to render as emoji.
 *
 * Reported: "設定を開くボタンは '⚙' で、絵文字じゃないっぽいんだけど、設定ないのruntimeは '⚙️' で
 * 絵文字になってる". `⚙` and `⚙️` are DIFFERENT strings — U+2699 alone, and U+2699 U+FE0F — so grep
 * and sed miss one while the other renders. A browser with an emoji font shows the VS16 form in
 * colour; the bare one falls back to the monochrome text glyph, so the SAME icon looked different in
 * two places.
 *
 * This is not about taste: the same character with and without VS16 is an inconsistency no reviewer
 * can see in a diff and no type checker can catch.
 *
 * Only TEXT-default characters are checked. Emoji-by-default ones (🎯 ✅ ⚠…) already render as
 * emoji and adding VS16 there would be noise.
 */
const TEXT_DEFAULT = new Set(
  "⚙☕✈✂✉✏✒⚓⚡⛅⛎⛔⛪⛲⛳⛵⛺⛽❓❗❔❕➕➖➗⭐⭕⬅⬆⬇⬛⬜🌐🍽🎖🎗🎞🎟🎤🎧🎬🎰🎳🕐🕑🔍🔎🔒🔓🔔🔕🔖🔗🔨🔩🔪🔫🔮🔰🔱🔲🔳🕵🗺🗻🗼🗽🗾☺♥♦♠",
);
const VS16 = "\ufe0f";

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("every text-default emoji carries VS16, so one icon cannot render two ways (#ui)", async () => {
  /**
   * BOTH trees. The first version walked only `frontend/`, so a server-authored string surfaced in
   * the UI escaped it: `"use 🔑 authorize in ⚙ settings"` in `mcp-registry.ts` was bare while every
   * button showed `⚙️`. Text the operator reads can come from either side.
   */
  const root = path.join(import.meta.dirname, "..");
  const files = [...(await walk(path.join(root, "frontend"))), ...(await walk(path.join(root, "src")))];
  const bare: string[] = [];
  let seen = 0;
  for (const f of files) {
    const src = await readFile(f, "utf8");
    for (let i = 0; i < src.length; i++) {
      const ch = src[i]!;
      if (!TEXT_DEFAULT.has(ch)) continue;
      seen++;
      if (src[i + 1] !== VS16) {
        const line = src.slice(0, i).split("\n").length;
        bare.push(`${path.relative(process.cwd(), f)}:${line} "${ch}"`);
      }
    }
  }
  assert.ok(seen > 0, "precondition: the frontend uses text-default emoji at all");
  assert.deepEqual(
    bare,
    [],
    "these render as monochrome text glyphs in some environments while their VS16 twin renders " +
      "as emoji — add U+FE0F so the same icon cannot look like two different things",
  );
});
