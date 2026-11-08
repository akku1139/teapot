/**
 * Is this turn's text JUST an acknowledgement?
 *
 * The system prompt used to end with "…end the turn right after the call (a short "reported." is fine)", so models filed
 * a report and answered "reported." — and some answer "報告済み。" or "了解" without calling the tool at all. The loop
 * answers a filed report (a report is not a stopping point), but a bare acknowledgement is invisible to it: with no goal
 * set, or with auto-continue off, the round simply ends and the work stops mid-task.
 *
 * MEASURED on the operator's own sessions: `report_progress` → "reported." → `round complete`, and the Japanese variant
 * "報告済み。" with no tool call at all.
 *
 * Deliberately narrow: a SHORT single-line message that is nothing but an acknowledgement. "done — the tests pass, next
 * I'll fix the scroll" is a real report (it names work), and treating it as an ack would nudge a working model.
 */
const ACK = new RegExp(
  "^(" +
    [
      // English
      "reported",
      "report(ed)? (filed|sent|done)",
      "noted",
      "ack",
      "acknowledged",
      "done",
      "ok",
      "okay",
      "sure",
      "understood",
      "got it",
      // Japanese
      "報告済み",
      "報告しました",
      "報告おわり",
      "報告終わり",
      "了解",
      "了解です",
      "承知",
      "承知しました",
      "完了しました",
      "完了",
      "対応しました",
      "進捗を報告しました",
    ].join("|") +
    ")([.。!！…\\s]*)$",
  "i",
);

/** Characters of real content beyond which this is a report, not an acknowledgement. */
const ACK_MAX_CHARS = 24;

export function isBareAcknowledgement(text: string | null | undefined): boolean {
  const raw = String(text ?? "");
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (t.length > ACK_MAX_CHARS) return false;
  if (/\n/.test(raw.trim())) return false;
  return ACK.test(t);
}
