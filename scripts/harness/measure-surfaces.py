"""
Measure the painted alpha of the teapot surfaces in a REAL engine, with a backed theme applied.

Why this exists: two reported bugs are about the EFFECTIVE opacity of a surface over a background
image — "ツール外側(ステータス行とかがある)の透明感が下がりすぎてしまっている" and
"ask_userのプロンプト欄が背景透過されてない". happy-dom does no layout and no `color-mix`
resolution, so it reports the written value, not what the operator sees. This seeds a custom theme
(with an image, so `data-bg-image` is on) into localStorage, reloads, and reads computed styles.

Usage:
    python3 scripts/harness/measure-surfaces.py http://127.0.0.1:7831/

Exit 1 if any probe selector is missing — a renamed selector must not report nothing and pass.
"""

import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from marionette import Firefox  # noqa: E402

PROBES = [
    ("panel-left", ".sidebar"),
    ("panel-right", ".rightbar"),
    ("chan-head", ".chan-head"),
    ("tool-outer", ".feed .embed"),
    ("tool-inner", ".feed .toolbody"),
    ("tool-nested", ".feed .toolbody .toolbody"),
    ("composer", ".composer form"),
    ("askuser-input", ".qfree input"),
    ("inline-code", ".feed .msg code"),
    ("copy-btn", ".feed .msg button"),
]

# A 4x4 PNG is enough: the rules key on `backgroundImage` being present, not on its pixels.
PNG = base64.b64encode(
    bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000004000000040806000000"
        "8d6f1d9b0000001649444154789c6360606060640000060004018d1006"
        "4e0000000049454e44ae426082"
    )
).decode()

THEME = {
    "id": "probe",
    "label": "probe",
    "mode": "dark",
    "surfaceAlpha": 0.82,
    "backgroundDim": 0.9,
    "backgroundImage": "data:image/png;base64," + PNG,
    "palette": {
        "bgDarkest": "#1a1c22", "bgDark": "#232630", "bgMid": "#2b2e39", "bgLight": "#343845",
        "fg": "#e6e8ee", "dim": "#9aa1b1", "line": "#3a3f4d", "acc": "#6aa8ff",
        "ok": "#3ba55d", "warn": "#e0a33e", "err": "#ed4245", "tool": "#9b7bff",
        "termBg": "#14161b", "termFg": "#d6d9e0",
    },
}

SEED = """
localStorage.setItem("teapot.customThemes", %s);
localStorage.setItem("teapot.theme", "probe");
localStorage.setItem("teapot.theme.auto", "0");
return true;
""" % json.dumps(json.dumps([THEME]))

MEASURE = r"""
const sel = arguments[0];
const el = document.querySelector(sel);
if (!el) return null;
const cs = getComputedStyle(el);
return { bg: cs.backgroundColor, alpha: cs.opacity };
"""


def alpha_of(bg):
    if not bg or bg == "transparent":
        return 0.0
    if bg.startswith("rgba"):
        return float(bg[bg.index("(") + 1:bg.rindex(")")].split(",")[3])
    if bg.startswith("color("):
        return float(bg[bg.rindex("/") + 1:bg.rindex(")")]) if "/" in bg else 1.0
    return 1.0


def main():
    url = sys.argv[1]
    with Firefox() as f:
        f.navigate(url)
        f.wait_for("document.readyState === 'complete'", timeout=30)
        f.js(SEED)
        f.navigate(url)
        f.wait_for("document.querySelector('.sidebar') !== null", timeout=40)
        f.wait_for("document.querySelector('.feed .embed') !== null", timeout=40)
        flag = f.js("return document.documentElement.dataset.bgImage || '(none)'")
        print(f"data-bg-image = {flag}")

        rows, missing = [], []
        for label, sel in PROBES:
            r = f.js(MEASURE, [sel])
            if not r:
                missing.append((label, sel))
                continue
            rows.append((label, sel, alpha_of(r["bg"]), r["bg"]))

    for label, sel, a, bg in rows:
        print(f"{label:15s} {sel:24s} alpha={a:.3f}  {bg}")
    for label, sel in missing:
        print(f"{label:15s} {sel:24s} MISSING")
    if flag != "on":
        print("WARNING: the theme's background image did not apply — alpha numbers are the no-image case")
    sys.exit(1 if missing else 0)


if __name__ == "__main__":
    main()
