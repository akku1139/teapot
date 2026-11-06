"""#217: is the timeline really hidden when the composer is maximized, and is the wallpaper really visible?

happy-dom does no layout and no paint, so this has to be a real engine: maximize the composer, screenshot the content
column, then force the feed back to `visible` (the pre-fix behaviour) and screenshot again. If the two images differ
inside the column, the rule is doing something; the computed `visibility` says which way.
"""

import base64
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from marionette import Firefox  # noqa: E402

PNG = base64.b64encode(
    bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000004000000040806000000"
        "8d6f1d9b0000001649444154789c6360606060640000060004018d1006"
        "4e0000000049454e44ae426082"
    )
).decode()

THEME = {
    "id": "probe", "label": "probe", "mode": "dark", "surfaceAlpha": 0.82, "backgroundDim": 0.9,
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


def shot(f):
    r = f.command("WebDriver:TakeScreenshot", {"full": False})
    return base64.b64decode(r["value"] if isinstance(r, dict) else r)


def main():
    url = sys.argv[1]
    from PIL import Image, ImageChops, ImageStat

    with Firefox() as f:
        f.navigate(url)
        f.wait_for("document.readyState === 'complete'", timeout=30)
        f.js(SEED)
        f.navigate(url)
        f.wait_for("document.querySelector('.feed .msg') !== null", timeout=40)
        f.wait_for("document.documentElement.dataset.bgImage === 'on'", timeout=20)
        f.js("document.querySelector('.maxbtn').click(); return true")
        f.wait_for("document.querySelector('.composer.maximized') !== null", timeout=10)
        f.wait_for("document.querySelector('.feed') !== null")

        info = f.js(
            """
            const feed = document.querySelector('.feed');
            const comp = document.querySelector('.composer.maximized');
            const before = getComputedStyle(comp, '::before');
            const box = feed.getBoundingClientRect();
            return {
              feedVisibility: getComputedStyle(feed).visibility,
              feedHeight: box.height,
              rows: feed.querySelectorAll('[data-eid]').length,
              compBg: getComputedStyle(comp).backgroundColor,
              beforeBg: before.backgroundColor,
              colRect: [box.left, box.top, box.width, box.height],
            };
            """
        )
        print("computed:", json.dumps(info))
        a = Image.open(io.BytesIO(shot(f)))
        f.js("document.querySelector('.feed').style.visibility = 'visible'; return true")
        f.wait_for("getComputedStyle(document.querySelector('.feed')).visibility === 'visible'", timeout=5)
        b = Image.open(io.BytesIO(shot(f)))
        f.js("document.querySelector('.feed').style.visibility = ''; return true")

    print(f"shot {a.size}")
    if a.size != b.size:
        print("FAIL: screenshots differ in size")
        return 1
    left, top, width, height = [int(v) for v in info["colRect"]]
    box = (max(0, left), max(0, top), min(a.size[0], left + width), min(a.size[1], top + height))
    diff = ImageChops.difference(a.crop(box).convert("RGB"), b.crop(box).convert("RGB"))
    stat = ImageStat.Stat(diff)
    mean = sum(stat.mean) / len(stat.mean)
    print(f"content column {box} mean |A-B| = {mean:.2f}/255")
    a.crop(box).save("/tmp/tp-fx217/max-hidden.png")
    b.crop(box).save("/tmp/tp-fx217/max-visible.png")
    ok = True
    if info["feedVisibility"] != "hidden":
        print(f"FAIL: .feed visibility is {info['feedVisibility']!r}, expected 'hidden'")
        ok = False
    if info["rows"] == 0:
        print("FAIL: no rows in the feed — the probe is vacuous")
        ok = False
    if mean < 1.0:
        print("FAIL: hiding the feed changed nothing on screen — the rule is inert")
        ok = False
    if info["beforeBg"] in ("rgba(0, 0, 0, 0)", "transparent"):
        print("WARN: the maximized backdrop paints nothing — the wallpaper would show, but so would the timeline")
    print("OK" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
