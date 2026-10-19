/**
 * #137 — "the terminal prompt is white and invisible in the light theme."
 *
 * ## Cause
 *
 * Every theme DOES define the terminal palette:
 *
 *     [data-theme="light"] { --term-bg: #ffffff; --term-fg: #24272f; … }
 *
 * and `themeColors()` reads those variables. But it is called ONCE, in xterm's
 * constructor, and xterm CACHES the palette it is given. So switching theme
 * updated the CSS variables — repainting every other surface — while each open
 * terminal kept the palette it was born with: light grey text on a background
 * that had become white.
 *
 * Two fixes, because there are two ways to reach the bug:
 *
 *  1. `retintTerminal()` on the REUSE path in `ensureSession()` — this is the path
 *     taken when the panel is closed and reopened, which is when a user would
 *     first notice it had "fixed itself".
 *  2. a `createEffect` that re-themes terminals ALREADY OPEN — without this the
 *     user changes theme and sees nothing happen at all until they remount.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const _app = readSource(path.join(here, "..", "frontend", "App.tsx"));

