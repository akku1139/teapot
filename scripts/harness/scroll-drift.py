#!/usr/bin/env python3
"""
Measure whether a scroll container drifts while rows above it change size.

Built for the teapot timeline scroll bug, but it takes any URL or generated page, so it is the
tool for any "the viewport moves on its own" report. It answers a question happy-dom cannot: the
unit and smoke harnesses do NO layout, so every element there measures 0x0 and drifting scroll
containers cannot exist.

## What it does

Pins the container to the tail, walks UP in equal steps, and after each step measures a marker
row's position *in content coordinates*:

    markerTop - containerTop + scrollTop

If that number changes between steps, the viewport drifted: the reader moved by N px and saw the
content shift by something else. It is representation-independent — absolute scrollTop and the
container's own height may both change, and the sum still has to be constant.

## What it measured, and one number that was WRONG

A first measurement compared `scrollHeight` on a freshly-built page against the same page after
scrolling through it, and reported `content-visibility` as 33% over (47100 estimated vs 35100
real). That comparison is invalid: the 35100 figure came from a state where the rows had not been
laid out, so it was not "the real height", it was "the height right after toggling the attribute".

The honest measurement is the drift itself, and it came back STABLE (0px over 20 steps) with
`content-visibility` both on and off. So this tool does not currently reproduce the operator's
report, and `content-visibility` is not confirmed as its cause.

The detector is verified against a POSITIVE CONTROL (grow a row above the marker with
`overflow-anchor: none`, and the marker must move): it reports -1420px there. A measurement tool
without a positive control proves nothing, which is exactly how the bad number got believed.

## Usage

    python3 scripts/harness/scroll-drift.py --rows 300 --tall-every 20
    python3 scripts/harness/scroll-drift.py --url http://127.0.0.1:7931/index.html --selector ".feed > .msg"

Exit status is 0 when no drift is measured, 1 when it is — so it can gate a change.
"""
from __future__ import annotations

import argparse
import http.server
import json
import os
import socketserver
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from marionette import Firefox  # noqa: E402

PAGE = """<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; font: 14px system-ui; }
.feed { height: 80vh; overflow-y: auto; }
.msg { padding: 8px; border-bottom: 1px solid #ddd; }
/* the configuration under test */
html[data-cv="on"] .feed > .msg { content-visibility: auto; contain-intrinsic-size: auto 140px; }
</style></head><body>
<div class="feed" id="feed"></div>
<script>
const ROWS = %(rows)d, TALL_EVERY = %(tall_every)d;
let html = "";
for (let i = 0; i < ROWS; i++) {
  // a realistic mix: mostly small rows, a few enormous tool-output ones
  const tall = TALL_EVERY > 0 && i %% TALL_EVERY === 0 ? 1800 : 40;
  html += '<div class="msg"><b>row ' + i + '</b><div style="height:' + tall + 'px"></div></div>';
}
const feed = document.getElementById("feed");
feed.innerHTML = html;
window.__cv = (on) => { document.documentElement.dataset.cv = on ? "on" : "off"; };
window.__total = () => feed.scrollHeight;
</script></body></html>
"""

MARKER = """
const feed = document.querySelector(%(selector)s);
if (!feed) return null;
const rows = [...feed.querySelectorAll(%(row)s)];
if (!rows.length) return null;
const marker = rows[Math.min(%(marker)d, rows.length - 1)];
const base = marker.getBoundingClientRect().top - feed.getBoundingClientRect().top + feed.scrollTop;
const out = [];
for (let i = 0; i < %(steps)d; i++) {
  feed.scrollTop = Math.max(0, feed.scrollTop - %(step)d);
  document.body.offsetHeight;                     // force layout before measuring
  const now = marker.getBoundingClientRect().top - feed.getBoundingClientRect().top + feed.scrollTop;
  out.push(Math.round((now - base) * 10) / 10);
}
return out;
"""


def serve(rows: int, tall_every: int) -> tuple[str, socketserver.TCPServer]:
    """a throwaway HTTP server on an ephemeral port, so a file:// origin cannot skew anything"""
    page = (PAGE % {"rows": rows, "tall_every": tall_every}).encode()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)

    httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}/", httpd


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", help="measure an existing page instead of generating one")
    ap.add_argument("--selector", default=".feed", help="the scrolling container (default .feed)")
    ap.add_argument("--row", default=".msg", help="the row selector inside it (default .msg)")
    ap.add_argument("--rows", type=int, default=300, help="generated rows")
    ap.add_argument("--tall-every", type=int, default=20,
                    help="make every Nth generated row 1800px tall (0 = uniform)")
    ap.add_argument("--steps", type=int, default=20, help="how many scroll-up steps to measure")
    ap.add_argument("--step", type=int, default=300, help="pixels per step")
    ap.add_argument("--marker", type=int, default=-1, help="row index to track (default: near the tail)")
    ap.add_argument("--cv", choices=("on", "off", "both"), default="both",
                    help="test content-visibility on, off, or both (generated pages only)")
    args = ap.parse_args()

    httpd = None
    if args.url:
        url = args.url
    else:
        url, httpd = serve(args.rows, args.tall_every)

    marker = args.marker if args.marker >= 0 else max(0, args.rows - 10)
    worst_overall = 0.0
    failed = False
    try:
        with Firefox() as f:
            f.navigate(url)
            # wait for the page's own DOM, not a fixed sleep
            if not f.wait_for(f"return document.querySelectorAll({json.dumps(args.row)}).length"):
                print(f"ERROR: no rows matched {args.row!r} at {url}", file=sys.stderr)
                return 2

            modes = ["on", "off"] if (args.cv == "both" and not args.url) else [args.cv if args.cv != "both" else "on"]
            for mode in modes:
                if not args.url:
                    # start from a clean tail for each mode
                    f.js(f"window.__cv({str(mode == 'on').lower()});"
                         f"const e=document.querySelector({json.dumps(args.selector)});"
                         f"e.scrollTop=0; document.body.offsetHeight;")
                f.js(f"const e=document.querySelector({json.dumps(args.selector)});"
                     f"e.scrollTop=e.scrollHeight; document.body.offsetHeight;")
                # The tail must be reached WITHOUT having laid out the rows above it — that is
                # the real condition, and pre-laying-out everything hides the drift entirely
                # (measured: it reads 0 and looks like a pass). Only the pin below runs first.
                drift = f.js(MARKER % {
                    "selector": json.dumps(args.selector),
                    "row": json.dumps(args.row),
                    "marker": marker,
                    "steps": args.steps,
                    "step": args.step,
                })
                if not drift:
                    print(f"ERROR: could not measure at {url}", file=sys.stderr)
                    return 2
                worst = max(abs(d) for d in drift)
                worst_overall = max(worst_overall, worst)
                moved = sum(1 for d in drift if abs(d) > 1)
                label = "generated/cv=" + mode if not args.url else args.url
                verdict = "DRIFT" if worst > 1 else "stable"
                print(f"{label}: worst {worst}px over {moved}/{len(drift)} steps — {verdict}")
                if worst > 1:
                    failed = True
                    print(f"  per-step: {drift}")
    finally:
        if httpd:
            httpd.shutdown()
            httpd.server_close()

    print("RESULT:", "DRIFT MEASURED" if failed else "no drift")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
