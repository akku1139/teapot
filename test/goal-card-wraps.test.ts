import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Window } from "happy-dom";
import { renderMarkdown } from "../frontend/md.js";
import { goalLine } from "../frontend/lib/goal-timeline.ts";
import { cssRuleBody } from "./helpers/css.ts";

test("the plain-text detail still keeps its newlines (#111)", () => {
  const detail = "first requirement\nsecond requirement\nthird requirement";
  const fenced = renderMarkdown("```\n" + detail + "\n```").replace(/<[^>]+>/g, "");
  assert.ok(
    fenced.includes("first requirement\nsecond requirement"),
    `the fence must preserve line breaks; got ${JSON.stringify(fenced)} (#111)`,
  );
});

test("a goal card's contract is multi-line and reaches a <pre> (#111)", () => {
  const contract =
    "src/agent/agent.ts must fail without the fix; src/server/api.ts must return 400; verified by reverting each and observing the suite go red";
  const line = goalLine({ event: "audit-started", verify: contract } as never);
  assert.equal(line.hasCard, true, "the contract renders as a card (#111)");
  assert.equal(line.markdown, false, "and as plain text, hence fenced (#111)");
  assert.equal(
    line.detail,
    contract,
    "the whole contract reaches the card, not a summary (#111)",
  );

  const html = renderMarkdown("```\n" + line.detail + "\n```");
  const w = new Window();
  const d = w.document.createElement("div");
  d.className = "card content";
  d.innerHTML = html;
  const pre = d.querySelector("pre");
  assert.ok(pre, "so a <pre> is what scrolls (#111)");
  assert.ok(
    (pre!.textContent ?? "").length > 120,
    "and it holds the whole contract, not a summary (#111)",
  );
});

test("the shipped CSS has the wrapping rule (#111)", () => {
  const dir = new URL("../public/assets/", import.meta.url);
  let name: string | undefined;
  try {
    name = readdirSync(dir).find((f) => f.endsWith(".css"));
  } catch {
    return; 
  }
  if (!name) return;
  const built = readFileSync(new URL(name, dir), "utf8");
  const body = cssRuleBody(built, ".content pre>code") ?? "";
  assert.ok(body, `the SHIPPED css must carry the goal-card code rule (#111); ${name}`);
  assert.match(
    body,
    /white-space:\s*pre-wrap/,
    `the SHIPPED css must wrap goal-card code (#111); ${name}`,
  );
});
