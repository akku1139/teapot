/**
 * Does a `finish(goalComplete=false)` summary name a CONCRETE blocker?
 *
 * #200: "progress reportをしたあとにfinish(goalComplete=false)をしがち" — and per the operator, also without a
 * progress report, with the context window fine (auto-compaction is on), time left and nothing actually in the
 * way. The harness knows those facts, so a claim of being blocked can be checked instead of trusted.
 *
 * MEASURED over the sessions on this machine: of 118 `finish(goalComplete=false)` calls, 13 came within a few
 * events of a progress report and 8 of those named no blocker at all.
 *
 * This is deliberately a VOCABULARY, not a model: it looks for the words people use when something refused to
 * work. A miss costs one polite question ("what failed?"), which is why a broad list is the right shape — the
 * refusal is bounded to one per round, so a phrasing this misses cannot trap the agent.
 */
const BLOCKER_WORDS = [
  // english
  "fail", "error", "cannot", "can't", "unable", "not possible", "impossible", "block", "missing",
  "deni", "timeout", "timed out", "unreachable", "no access", "refus", "reject", "crash",
  "not found", "unsupported", "regression", "won't work", "does not work", "doesn't work",
  // japanese
  "失敗", "できません", "できない", "できず", "不可能", "無理", "未達", "未到達", "特定でき", "取れません",
  "取れない", "通らない", "エラー", "拒否", "権限", "見つから", "落ちる", "落ちた", "停止した",
  // chinese
  "失败", "无法", "错误", "未能", "不能",
];

export function namesBlocker(summary: string | null | undefined): boolean {
  const s = String(summary ?? "").toLowerCase();
  if (!s.trim()) return false;
  return BLOCKER_WORDS.some((w) => s.includes(w));
}
