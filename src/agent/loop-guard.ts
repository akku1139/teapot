/**
 * Is the model stuck repeating itself?
 *
 * "DeepSeekが `  ********` を一生吐いたりするので無駄にトークン食って困る" (#209). A degenerate stream is not just ugly — it
 * burns the context budget and the operator's money, and nothing downstream notices because every chunk is a valid
 * token.
 *
 * The rule is deliberately crude and deliberately LOUD: a unit of 1–12 characters repeated at least 40 times in a
 * row at the end of the output. Legitimate text contains short runs of `-`, `=`, `*` and spaces (a markdown rule is
 * a dozen characters; a code fence is three), so the threshold has to be far above them — 40 repetitions of a
 * multi-character unit is not something a model writes on purpose.
 */
export function isDegenerateRepeat(text: string | null | undefined, minRepeats = 40): boolean {
  const t = String(text ?? "");
  if (t.length < minRepeats) return false;
  // only the tail matters, and it keeps the check O(1) per chunk
  const tail = t.slice(-Math.min(t.length, minRepeats * 12 + 24));
  for (let unit = 1; unit <= 12; unit++) {
    // how many times does the last `unit` characters repeat backwards without a break?
    let repeats = 1;
    for (let i = tail.length - unit * 2; i >= 0; i -= unit) {
      if (tail.slice(i, i + unit) !== tail.slice(i + unit, i + unit * 2)) break;
      repeats++;
      if (repeats >= minRepeats) return true;
    }
  }
  return false;
}
