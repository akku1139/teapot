/**
 * Timeline rendering of the goal / completion-audit lifecycle.
 *
 * #41: "finish → audit reject → continue is hard to follow on the timeline."
 *
 * The audit emits four distinct `goal` events (status → audit-started → audit
 * → status), but the renderer collapsed every one of them into
 *
 *     🎯 goal <event>: <d.text ?? "">
 *
 * so `audit-started` and `audit` rendered as bare labels with an EMPTY body —
 * the verification contract and the verdict/feedback were dropped entirely.
 * Worse, `marked done` is logged before the audit that may reject it, so the
 * timeline read as if the goal had completed when it had not.
 *
 * Pure and dependency-free so it is unit-testable under `node --test`.
 */

export type AuditPhase = "status" | "audit-started" | "audit" | "audit-failed" | "other";

export interface GoalEventData {
  event?: string;
  status?: string;
  verify?: string;
  verdict?: string;
  feedback?: string;
  detail?: string;
  text?: string;
}

export function auditPhase(d: GoalEventData): AuditPhase {
  const e = d.event;
  if (e === "status" || e === "audit-started" || e === "audit" || e === "audit-failed") return e;
  return "other";
}

/** Is this goal event part of the finish→audit lifecycle worth calling out? */
export function isAuditLifecycle(d: GoalEventData): boolean {
  return auditPhase(d) !== "other";
}

export interface GoalLine {
  /** short label for the divider row */
  label: string;
  /**
   * The detail body — may be EMPTY when there is genuinely nothing to show.
   *
   * #41 required every branch to carry a non-empty detail, because the old
   * template produced a bare "🎯 goal audit:" with nothing after it. #51 is the
   * exception that proves the rule: a verdict the auditor gave NO reason for
   * must render as a label alone, because a card reading "(no detail)" is the
   * absence of a finding dressed up as one. `hasCard` says which case this is,
   * so a consumer never has to guess from an empty string.
   */
  detail: string;
  /** "ok" | "warn" | "err" | "" — drives the accent colour */
  tone: "ok" | "warn" | "err" | "";
  /** render the body as markdown rather than plain text */
  markdown: boolean;
  /** true when `detail` is real content that deserves its own card */
  hasCard: boolean;
}

/**
 * True when this text is one of the harness's own "the model said nothing
 * useful" placeholders rather than real feedback.
 *
 * The harness stored the literal "(no detail)" when the auditor returned no
 * usable text, and the UI then drew it as a card as if it were the auditor's
 * finding. The report called that card ちょっと気持ち悪い — and rightly: it is a
 * card whose entire content is the absence of content. Anything that is empty,
 * or one of these placeholders, renders as no card at all (#51).
 */
export function isPlaceholderDetail(s: string): boolean {
  const t = s.trim().toLowerCase();
  return t === "" || t === "(no detail)" || t === "no detail" || t === "(none)" || t === "(empty)";
}

/**
 * The detail to render, or "" when it would only be a placeholder.
 *
 * Exported so the renderer and this module agree on one rule — the bug was two
 * places each deciding independently what "no detail" meant.
 */
export function cardDetail(raw: string, fallback: string): string {
  const t = String(raw ?? "").trim();
  if (!isPlaceholderDetail(t)) return t;
  return isPlaceholderDetail(fallback) ? "" : fallback;
}

/**
 * Turn one `goal` event into a labelled, COLOURED line that says what actually
 * happened. Every branch carries a non-empty detail, which is the bug this
 * fixes: the old template produced `🎯 goal audit:` with nothing after it.
 */
export function goalLine(d: GoalEventData): GoalLine {
  switch (auditPhase(d)) {
    case "audit-started":
      return {
        label: "🔍 completion audit started",
        detail: String(d.verify ?? "").trim() || "checking the verification contract…",
        tone: "",
        markdown: false,
        hasCard: true,
      };
    case "audit": {
      const verdictHasReason = !isPlaceholderDetail(String(d.feedback ?? ""));
      return d.verdict === "approved"
        ? {
            label: "✅ audit: approved",
            // an empty verdict body is a LABEL, not a card (#51): the auditor
            // approved without giving a reason, and "(no detail)" as a card
            // looked like a finding when it was the absence of one
            detail: cardDetail(d.feedback ?? "", ""),
            tone: "ok",
            markdown: true,
            hasCard: verdictHasReason,
          }
        : {
            label: "⚠ audit: changes required",
            detail: cardDetail(d.feedback ?? "", ""),
            tone: "warn",
            markdown: true,
            hasCard: verdictHasReason,
          };
    }
    case "audit-failed":
      return {
        label: "🔍 audit unavailable — finish accepted",
        detail: String(d.detail ?? "").trim() || "the auditor could not be reached",
        tone: "err",
        markdown: false,
        hasCard: true,
      };
    case "status": {
      const s = String(d.status ?? "").trim();
      // a status event with no status value is still a status event — never
      // fall through to a bare label (#41)
      if (!s)
        return {
          label: "🎯 goal status updated",
          detail: String(d.text ?? "").trim() || "no status recorded",
          tone: "",
          markdown: false,
          hasCard: true,
        };
      // "done" is logged BEFORE the audit runs, so it must not read as final
      if (s === "done")
        return {
          label: "🏁 finish claimed — pending audit",
          detail: "the agent called finish(goalComplete=true); the verification contract is now being audited",
          tone: "",
          markdown: false,
          hasCard: true,
        };
      if (s === "active")
        return {
          label: "▶ goal reopened",
          detail: "the audit rejected the finish — work continues on the same goal",
          tone: "warn",
          markdown: false,
          hasCard: true,
        };
      return {
        label: `🎯 goal ${s || "updated"}`,
        detail: String(d.text ?? "").trim(),
        tone: "",
        markdown: false,
        hasCard: true,
      };
    }
    default: {
      const what = String(d.text ?? "").trim();
      const name = String(d.event ?? "").trim();
      return {
        label: name ? `🎯 goal ${name}` : "🎯 goal updated",
        // #41: never render a bare label with nothing after it — that was the
        // exact shape of the reported bug. An unknown event with no text still
        // gets a body, but it must SAY something rather than read as a verdict
        // that was never delivered (#51).
        detail: what || `the "${name || "goal"}" event carried no further detail`,
        tone: "",
        markdown: false,
        hasCard: true,
      };
    }
  }
}