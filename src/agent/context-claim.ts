/**
 * Does this assistant message claim the CONTEXT WINDOW is why it stopped?
 *
 * Measured in `mediapad-t5-root-attempt-2-2601e254`: three times the model ended a turn with prose —
 * "コンテキスト上限のため一旦区切ります" / "コンテキスト上限のため停止します" — with no tool call and no
 * `finish()`. The loop treats that as an idle round, counts it against `maxConsecutiveIdleRounds`, and stops.
 *
 * The claim is also FALSE in this harness: compaction is the harness's job and it runs automatically, so
 * "out of context" is not a blocker the model is entitled to stop for. Recognising the claim is what lets the
 * loop answer it (compact, then say so) instead of accepting it.
 *
 * Deliberately narrow: it must catch the STOPPING claim, not any mention of the topic. "コンテキスト上限に
 * 注意しながら続けます" is not a reason given for stopping, and matching it would derail a working turn.
 */
/**
 * Phrasings measured in this project and in the report it links
 * (deepseek-ai/DeepSeek-V3#1669: "上下文余量不足" / "上下文快用满了" after a compaction that had left the window
 * at 44-47% used).
 */
const STOP_PATTERNS = [
  /コンテキスト(?:の)?上限[^。\n]{0,20}(?:停止|区切|終了|中断|打ち切)/,
  /コンテキスト(?:の)?上限のため/,
  /トークン(?:数)?(?:の)?上限[^。\n]{0,20}(?:停止|区切|終了|中断|打ち切)/,
  // the same claim in the languages the model actually writes in
  /上下文[^。\n]{0,20}(?:余量|余裕)[^。\n]{0,20}(?:不足|不够|快满|用满)/,
  /上下文[^。\n]{0,10}(?:快|即将|要)?(?:用满|耗尽|不足)/,
  /(?:token|上下文)[^。\n]{0,12}(?:预算|额度)[^。\n]{0,12}(?:不足|耗尽)/,
  /(?:context|token)s?[\s-]*(?:window|limit)[^.\n]{0,40}(?:stop|halt|end|paus|abort)/i,
  // the reasoning-side phrasing measured in akku1139/teapot#201's follow-up report
  /context (?:is |was )?(?:nearly |almost )?(?:exhausted|full|gone|out)/i,
  /out of context (?:to|for)/i,
  /can'?t reliably continue/i,
  /context[- ]blocked/i,
  // deepseek-ai/DeepSeek-V3#1737 / #1744: the web product's own wording, reproduced by the model
  /le?ngth\s*limit[^.\n]{0,20}(?:reached|exceeded|hit)/i,
  /(?:your )?chat limit (?:has )?(?:finished|been reached|reached)/i,
  /(?:limit|full|exhausted|reached)[^.\n]{0,40}start (?:a )?new chat/i,
  /(?:running (?:low on|out of) context|not enough context (?:left|remaining)|context (?:is )?(?:almost )?(?:full|exhausted)|out of context (?:space|budget))/i,
  /(?:stop|halt|end|paus|abort)[a-z]*\s+(?:here|now)?\s*(?:because|due to)[^.\n]{0,40}(?:context|token)/i,
  /stopping (?:here )?(?:because|due to)[^.\n]{0,40}(?:context|token)/i,
];

/**
 * Strip what the agent is REPORTING from what it is SAYING.
 *
 * A turn that summarises an investigation legitimately quotes a log line — "コンテキスト上限のため停止します"
 * inside a fenced block or a `>` quote is evidence, not a reason to stop. Matching it would force a continue on
 * a model that is doing exactly the right thing, which is why the quoted forms are removed before matching.
 */
function withoutQuotedBlocks(text: string): string {
  const kept: string[] = [];
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

export function claimsContextLimit(text: string | null | undefined): boolean {
  const raw = String(text ?? "");
  if (!raw.trim()) return false;
  const t = withoutQuotedBlocks(raw);
  if (!t.trim()) return false;
  return STOP_PATTERNS.some((re) => re.test(t));
}

/** "68k/200k tokens (34%)" — the ground truth the model does not otherwise have */
export function usageLine(used: number, budget: number): string {
  const fmt = (n: number) => (n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(Math.max(0, Math.round(n))));
  if (!Number.isFinite(budget) || budget <= 0) return `context ${fmt(used)} tokens used`;
  const pct = Math.max(0, Math.min(100, Math.round((used / budget) * 100)));
  return `context ${pct}% (${fmt(used)}/${fmt(budget)} tokens)`;
}

/**
 * …and the OTHER thing that gets reported as "context is exhausted": the model has run out of its own ideas.
 *
 * "コンテキストが尽きたっていうのがコンテキストウィンドウが尽きたと勘違いしてるパターンと、自力の推論の限界に達した
 * 場合がありそう" — two different problems with different answers. The window case is false and gets corrected with
 * numbers; being STUCK is real, and telling the model to continue would just spin. What a stuck agent needs is to
 * name the question it cannot answer and hand it over (ask_user) or change angle — not another turn of the same.
 */
const OWN_LIMIT_PATTERNS = [
  /(?:reasoning|analysis|own) (?:limit|limits|capacity)s?\b/i,
  /reached (?:the )?limits? of my (?:reasoning|analysis|understanding)/i,
  /can'?t (?:reason|figure|work) (?:this |it )?out (?:any (?:further|longer))?/i,
  /no (?:further|more) (?:ideas|approaches|options|progress)/i,
  /(?:推論|思考|自力)[^。\n]{0,12}(?:限界|行き詰|手詰)/,
  /(?:打つ手|手立て|これ以上)[^。\n]{0,10}(?:ない|尽きた|思いつかない)/,
  /行き詰ま(?:った|り)/,
  /(?:无法再|想不出|推理到极限)/,
];

export function claimsOwnLimit(text: string | null | undefined): boolean {
  const raw = String(text ?? "");
  if (!raw.trim()) return false;
  const t = withoutQuotedBlocks(raw);
  if (!t.trim()) return false;
  return OWN_LIMIT_PATTERNS.some((re) => re.test(t));
}
