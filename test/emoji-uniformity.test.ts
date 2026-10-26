import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

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
