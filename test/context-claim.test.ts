import assert from "node:assert/strict";
import test from "node:test";
import { claimsContextLimit } from "../src/agent/context-claim.ts";

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
