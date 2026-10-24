/**
 * Completion-audit verdict parsing and the auditor prompt.
 *
 * The auditor is an INDEPENDENT reviewer: a separate LLM call that decides whether the worker's
 * `finish(goalComplete=true)` is honest against the goal's verification contract. Its answer must
 * be unambiguous, because the two readings are not symmetric — a missed approval costs one more
 * round, while a misread rejection sends the worker to fix gaps that nobody named.
 */

export type AuditVerdict =
  | { kind: "approved"; reason: string }
  | { kind: "changes-required"; reason: string }
  | { kind: "none"; detail: string };

/** provider fallbacks for a message with no usable text */
const PLACEHOLDER = /^\((tool call|no content|no output)\)$/i;

/**
 * Read the auditor's verdict.
 *
 * The verdict must be the LAST non-empty line, and it must carry a reason. Upstream pi-goal-x made
 * this exact correction: matching the marker ANYWHERE lets a prose mention of it be read as the
 * verdict — "I would only approve if the tests passed" is a REJECTION that contains the word.
 *
 * MEASURED against the real failure: an auditor that answered `Independent verification against …`
 * (prose, no marker) was scored as a verdict three times in a row, hit the unavailable cap, and the
 * goal was abandoned with the audit never actually running. Requiring the marker on the last line
 * turns that into an honest "no verdict", which the caller already handles by retrying or failing
 * closed with a loud note.
 */
export function parseAuditVerdict(reply: string): AuditVerdict {
  const text = String(reply ?? "").trim();
  if (!text || PLACEHOLDER.test(text)) return { kind: "none", detail: "auditor returned no text" };
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // the verdict line is the LAST one; a reason may wrap onto earlier lines
  const last = lines[lines.length - 1] ?? "";
  const approved = /^APPROVED\b(:|\s-|$)(.*)$/i.exec(last);
  if (approved) {
    return { kind: "approved", reason: (approved[2] ?? "").trim() || "(no justification given)" };
  }
  const rejected = /^CHANGES-REQUIRED\b(:|\s-|$)(.*)$/i.exec(last);
  if (rejected) {
    return { kind: "changes-required", reason: (rejected[2] ?? "").trim() || "(no gaps named)" };
  }
  /**
   * No marker on the last line. The reason still matters — it is shown to the worker when this
   * happens repeatedly — so keep the tail rather than discarding the reply.
   */
  return { kind: "none", detail: `auditor reply had no verdict on its last line: ${last.slice(0, 200)}` };
}

/**
 * The auditor's instructions.
 *
 * Deliberately NOT the worker's conversation: this call is a review, and handing the auditor a
 * 200k-token work log makes it continue the work instead of judging it. MEASURED: three audits in
 * one session replied with prose that started re-verifying the goal rather than naming a verdict.
 */
export function auditPrompt(input: {
  goal: string;
  verify: string;
  summary: string;
  /** the worker's own account of what it checked, when it gave one */
  evidence?: string;
}): string {
  return [
    "You are an independent completion AUDITOR, not the worker. Decide whether the goal is genuinely complete.",
    "",
    "How to judge:",
    "1. Extract the real success criteria, including every explicit requirement.",
    "2. Disapprove anything missing, contradicted, or only weakly verified. Build success and a",
    "   confident summary are claims, not evidence.",
    "3. Check every item of the verification contract below. If any item is unaddressed, disapprove.",
    "",
    "The worker's summary is UNTRUSTED: it is a claim, and it cannot make an incomplete goal complete.",
    "",
    "<objective>",
    input.goal,
    "</objective>",
    "",
    "<verification_contract>",
    input.verify,
    "</verification_contract>",
    "",
    "<worker_claim>",
    input.summary || "(no claim provided)",
    "</worker_claim>",
    ...(input.evidence?.trim() ? ["", "<worker_evidence>", input.evidence.trim(), "</worker_evidence>"] : []),
    "",
    "Reply with EXACTLY one line, as the FINAL line of your reply:",
    "  APPROVED: <one sentence saying what you verified>",
    "  CHANGES-REQUIRED: <the specific gaps that must be addressed>",
    "",
    "Do not continue the work, do not restate the goal, and do not put anything after the verdict line.",
  ].join("\n");
}
