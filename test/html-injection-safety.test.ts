import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { hastToHtml } from "shiki/core";
import { renderMarkdown } from "../frontend/md.js";

const PAYLOADS = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "<svg onload=alert(1)>",
  "<div onclick=alert(1)>hi</div>",
  "<iframe src=javascript:alert(1)>",
  "<style>body{display:none}</style>",
  "<a href=javascript:alert(1)>t</a>",
  "[click](javascript:alert(1))",
  "![i](javascript:alert(1))",
  "[a](vbscript:msgbox(1))",
  "<!--<script>alert(1)</script>-->",
  "<math><mtext></mtext><script>alert(1)</script></math>",
  "<a href='x' onmouseover='alert(1)'>t</a>",
  "<form><button formaction=javascript:alert(1)>go</button></form>",
  "<details open ontoggle=alert(1)>",
];

function liveNodes(html: string): { total: number; kinds: string[] } {
  const w = new Window();
  const d = w.document.createElement("div");
  d.innerHTML = html;
  const kinds: string[] = [];
  kinds.push(...[...d.querySelectorAll("script")].map(() => "script"));
  kinds.push(...[...d.querySelectorAll("style")].map(() => "style"));
  kinds.push(...[...d.querySelectorAll("iframe,object,embed")].map((e) => e.tagName.toLowerCase()));
  for (const el of d.querySelectorAll("*")) {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name)) kinds.push(`on${a.name}`);
      const v = (a.value ?? "").trim().toLowerCase();
      if ((a.name === "href" || a.name === "src" || a.name === "formaction") &&
          /^(javascript|vbscript|data:text\/html)/.test(v))
        kinds.push(`${a.name}=${v.split(":")[0]}`);
    }
  }
  return { total: kinds.length, kinds };
}

test("markdown output constructs no live nodes (#security)", () => {
  for (const p of PAYLOADS) {
    const { total, kinds } = liveNodes(renderMarkdown(p));
    assert.equal(total, 0, `payload ${JSON.stringify(p)} produced live nodes: ${kinds.join(", ")}`);
  }
});

test("shiki's html escapes source text rather than emitting it (#security)", () => {
  const SOURCE = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const html = hastToHtml({
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        properties: {},
        children: [
          { type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: SOURCE }] },
        ],
      },
    ],
  });
  const { total, kinds } = liveNodes(html);
  assert.equal(total, 0, `shiki output produced live nodes: ${kinds.join(", ")} (#security)`);
});

