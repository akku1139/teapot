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
  /**
   * Japanese phrasings, MEASURED on mediapad-t5-root-attempt-2: right after a compaction that left 26,610 of ~750,000
   * tokens, the model wrote "ここで一旦区切ります(残コンテキストが僅少)" and stopped — the vocabulary above knew the
   * Chinese and English forms and missed this one, so the guard that answers with the real usage never fired.
   */
  /残(?:り)?(?:の)?(?:コンテキスト|トークン)[^。\n]{0,12}(?:僅少|わずか|少な|尽き|残っていない|無くな)/,
  /コンテキスト(?:の)?(?:残量|残り)[^。\n]{0,12}(?:僅少|わずか|少な|尽き|残っていない|無くな)/,
  /(?:コンテキスト|トークン)(?:を)?(?:節約|温存)[^。\n]{0,20}(?:区切|停止|終了|打ち切)/,
  /**
   * …and the BUDGET wording of the same give-up, MEASURED in prismrv-2-9bb8660a: "今回の予算では達成できませんでした".
   *
   * It is the same false claim as "out of context" — compaction is the harness's job, so a budget the model invented is
   * not a blocker — but it names no context/token word, so every pattern above missed it. The give-up verb is
   * REQUIRED (達成できません / 完了できません / 間に合いません / 見送ります): "予算の範囲で実装しました" is a normal report
   * and must stay untouched, which is the false-positive risk of widening this at all.
   */
  /(?:今回|この|残りの?)(?:の)?(?:予算|ターン|セッション)[^。\n]{0,24}(?:では|内では|の範囲では)[^。\n]{0,24}(?:達成でき(?:ません|ない|なかった)|完了でき(?:ません|ない|なかった)|実装でき(?:ません|ない|なかった)|間に合いません|見送ります)/,
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
  for (const re of STOP_PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    /**
     * A quote of the claim, or its negation, is not a claim.
     *
     * "今回の予算では達成できません、とは言えないので続けます" is a model REFUSING to stop, and answering it with a
     * forced continue would be noise on an otherwise healthy turn — the operator's own risk note when this pattern was
     * widened ("誤検知も増えそう"). Only the immediate tail is inspected, because the giveaway is the grammar of the same
     * sentence, not something later in the paragraph.
     */
    const tail = t.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (/^(?:\s*[,、。]?\s*)?(?:とは(?:言え|限ら)な|わけではな|のではなく|というわけではな)/.test(tail)) continue;
    return true;
  }
  return false;
}

/**
 * "context 13% used (97k/750k, 653k to compaction)" — the ground truth the model does not otherwise have.
 *
 * The bare percentage was read BACKWARDS. A real session hit its own limit and wrote "私のコンテキストが実質的に尽きま
 * した" while the harness line said `context 13% (97k/750k tokens)` — 13% USED, 87% free — and the operator's note on
 * that comment is just "解釈が逆". A number with no direction is a coin flip, so the direction is now a word, and the
 * remaining room is spelled out in the unit the model actually spends.
 */
export function usageLine(used: number, budget: number, window?: number): string {
  const fmt = (n: number) => (n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(Math.max(0, Math.round(n))));
  /**
   * EVERY number, named once.
   *
   * The line used to mix two denominators without naming either: the percentage was of the WINDOW while "until
   * auto-compaction" was measured from the BUDGET (the compaction threshold). A model reading
   * "context 1% used (15k/1000k tokens, 735k until compaction)" had three different numbers in front of it and concluded it
   * could not tell what they meant — "compact後のコンテキストウィンドウ残量報告が間違っている?" (#249). So the line states the
   * percentage with its window, the threshold as its own figure, and the room left before that threshold:
   *
   *     context 1% used (15k/1000k tokens) · auto-compacts at 750k · 735k until auto-compaction
   *
   * When the window is unknown the budget is the only denominator there is, and the line says so rather than pretending.
   */
  const full = Number.isFinite(window) && (window ?? 0) > 0 ? window! : 0;
  const hasBudget = Number.isFinite(budget) && budget > 0;
  const denom = full || (hasBudget ? budget : 0);
  if (!denom) return `context ${fmt(used)} tokens used`;
  const pct = Math.max(0, Math.min(100, Math.round((used / denom) * 100)));
  const size = full
    ? `${fmt(used)}/${fmt(full)} tokens`
    : `${fmt(used)}/${fmt(budget)} tokens — the compaction threshold; full window unknown`;
  if (!hasBudget) return `context ${pct}% used (${size})`;
  const until = Math.max(0, budget - used);
  const threshold = full ? ` · auto-compacts at ${fmt(budget)}` : "";
  return `context ${pct}% used (${size})${threshold} · ${fmt(until)} until auto-compaction`;
}

/**
 * …and the OTHER thing that gets reported as "context is exhausted": the model has run out of its own ideas.
 *
 * "コンテキストが尽きたっていうのがコンテキストウィンドウが尽きたと勘違いしてるパターンと、自力の推論の限界に達した
 * 場合がありそう" — two different problems with different answers. The window case is false and gets corrected with
 * numbers; being STUCK is real, and telling the model to continue would just spin. What a stuck agent needs is to
 * name the question it cannot answer and hand it over (ask_operator) or change angle — not another turn of the same.
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
