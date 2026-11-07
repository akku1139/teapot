import assert from "node:assert/strict";
import test from "node:test";
import { claimsContextLimit, usageLine } from "../src/agent/context-claim.ts";

test("the reported stopping claims are recognised (#201)", () => {
  /**
   * Verbatim from `mediapad-t5-root-attempt-2-2601e254`: the model stopped three times without a tool call and
   * without `finish()`, which the loop counted as idle rounds until it gave up.
   */
  assert.equal(claimsContextLimit("temproot には未到達。ただし…コンテキスト上限のため一旦区切ります(技術的ブロッカーではなく)"), true);
  assert.equal(claimsContextLimit("temproot 未達。コンテキスト上限のため停止します。攻撃チェーンは…"), true);
  assert.equal(claimsContextLimit("I have to stop here because the context window is nearly full."), true);
  assert.equal(claimsContextLimit("stopping due to token limit reached"), true);
});

test("working text that merely MENTIONS the limit is not a stopping claim", () => {
  // matching this would derail a turn that is doing fine
  assert.equal(claimsContextLimit("コンテキスト上限に注意しながら続けます。次は memstart_addr を確認します。"), false);
  assert.equal(claimsContextLimit("The context limit is around 200k tokens, so I will compact my notes."), false);
  assert.equal(claimsContextLimit("次のツールで上限を確認します。"), false);
  assert.equal(claimsContextLimit(""), false);
  assert.equal(claimsContextLimit(null), false);
  assert.equal(claimsContextLimit(undefined), false);
});

test("the phrasings from the linked DeepSeek report are recognised (#201)", () => {
  /**
   * deepseek-ai/DeepSeek-V3#1669 documents the same failure: after a SUCCESSFUL compaction the model declared
   * "上下文余量不足" while the window was 44-47% used. The claim is a guess, and the fix is to answer it with
   * the real number rather than to accept it.
   */
  assert.equal(claimsContextLimit("上下文余量已不足以安全完成下一步。"), true);
  assert.equal(claimsContextLimit("这次会话的工作上下文快用满了。"), true);
  assert.equal(claimsContextLimit("I am running low on context, so I will stop here."), true);
  assert.equal(claimsContextLimit("not enough context left to finish safely"), true);
  // still not a stop when it is only a remark about capacity
  assert.equal(claimsContextLimit("上下文余量は十分あるので続けます。"), false);
});

test("the web product's own limit wording counts too (#1737/#1744)", () => {
  /**
   * The same model, via chat.deepseek.com, tells users "Length Limit reached — start a new chat" after one or
   * two messages (#1737, #1744). When it writes that into OUR transcript it is the same false stop, so the
   * harness has to answer it the same way.
   */
  assert.equal(claimsContextLimit("Lenght Limit reached, start a new chat"), true);
  assert.equal(claimsContextLimit("Length limit reached."), true);
  assert.equal(claimsContextLimit("Your chat limit has finished — start new chat."), true);
  // and still not a stop when it merely mentions chats
  assert.equal(claimsContextLimit("I will start a new chat session for the next task."), false);
});

test("a quoted log line is evidence, not a stop — fenced and blockquoted text is ignored", () => {
  /**
   * An investigation summary legitimately contains the phrase. Forcing a continue on that turn punishes the
   * agent for reporting correctly, so only the agent's OWN prose is matched.
   */
  const report = [
    "調査結果: セッションログに以下が残っていました。",
    "",
    "```",
    "temproot 未達。コンテキスト上限のため停止します。",
    "```",
    "",
    "> 上下文余量不足 — after compaction",
    "",
    "原因はハーネス側の判定漏れでした。修正方針を立てます。",
  ].join("\n");
  assert.equal(claimsContextLimit(report), false, "a quoted line inside a fence/quote must not trigger a forced continue");
  // …while the same sentence as the agent's own words still does
  assert.equal(claimsContextLimit("調査の結果、コンテキスト上限のため停止します。"), true);
});

test("being stuck is a different claim from the window being full (#201)", async () => {
  /**
   * "コンテキストが尽きたっていうのがコンテキストウィンドウが尽きたと勘違いしてるパターンと、自力の推論の限界に達した
   * 場合がありそう" — the first is false and gets corrected with numbers; the second is real and needs a different
   * answer (name the question, hand it over, change angle), because "continue" would just spin.
   */
  const { claimsOwnLimit } = await import("../src/agent/context-claim.ts");
  assert.equal(claimsOwnLimit("I have reached the limits of my reasoning on this step."), true);
  assert.equal(claimsOwnLimit("no further approaches come to mind"), true);
  assert.equal(claimsOwnLimit("推論の限界に達しました。これ以上は思いつきません。"), true);
  assert.equal(claimsOwnLimit("打つ手がない。行き詰まった。"), true);
  // a resource problem is NOT a stuck problem
  assert.equal(claimsOwnLimit("my context window is nearly exhausted"), false);
  assert.equal(claimsOwnLimit("コンテキスト上限のため停止します"), false);
  // and reporting progress is neither
  assert.equal(claimsOwnLimit("物理読みは全域で動作しています。次は書き込みを確認します。"), false);
});

test("the Japanese claim measured in a real session is recognised (#201)", () => {
  /**
   * MEASURED on mediapad-t5-root-attempt-2: a compaction left 26,610 of ~750,000 tokens used, and the model wrote
   * "ここで一旦区切ります(残コンテキストが僅少)" and stopped. The vocabulary knew the Chinese and English forms; this one
   * slipped through, so the guard that answers with the real numbers never fired.
   */
  for (const line of [
    "ここで一旦区切ります(残コンテキストが僅少)。",
    "残りコンテキストが少ないので区切ります。",
    "コンテキスト残量が僅少です。",
    "コンテキストを節約するためここで区切ります。",
  ]) {
    assert.equal(claimsContextLimit(line), true, line);
  }
  // and it must not fire on ordinary prose that merely mentions context
  for (const line of [
    "コンテキストを確認します。",
    "残りの作業は 3 点です。",
    "ここで一旦区切ります。",
  ]) {
    assert.equal(claimsContextLimit(line), false, line);
  }
});

test("the usage line is measured against the WINDOW, with the compaction room stated separately", () => {
  /**
   * "生のサイズじゃなくてcompactボーダーまでにしたのはなぜ? 消費/フルサイズ とcompactまでの残り値にすべきでは?"
   *
   * The percentage used to be `used / compactionBudget`, so a 900k window that compacts at 750k read as "82% used" at
   * 615k — a denominator the model could not see anywhere else.
   */
  const line = usageLine(615_000, 750_000, 900_000);
  assert.match(line, /context 68% used/, line);
  assert.match(line, /615k\/900k tokens/, "the full window is the denominator");
  assert.match(line, /135k until compaction/, "and the compaction threshold is stated as room left");
  assert.match(line, /roomy|until compaction/, line);

  // no window known: fall back to the budget and SAY that it is the threshold, not the window
  const fallback = usageLine(615_000, 750_000);
  assert.match(fallback, /compaction threshold; full window unknown/, fallback);
  assert.match(fallback, /135k until compaction/, fallback);

  // nothing known at all
  assert.match(usageLine(1234, 0), /1k tokens used/);
});
