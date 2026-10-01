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
  /** the detail body — may be empty for a bare status flip */
  detail: string;
  /** "ok" | "warn" | "err" | "" — drives the accent colour */
  tone: "ok" | "warn" | "err" | "";
  /** render the body as markdown rather than plain text */
  markdown: boolean;
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
      };
    case "audit":
      return d.verdict === "approved"
        ? {
            label: "✅ audit: approved",
            detail: String(d.feedback ?? "").trim() || "(no detail)",
            tone: "ok",
            markdown: true,
          }
        : {
            label: "⚠ audit: changes required",
            detail: String(d.feedback ?? "").trim() || "(no detail)",
            tone: "warn",
            markdown: true,
          };
    case "audit-failed":
      return {
        label: "🔍 audit unavailable — finish accepted",
        detail: String(d.detail ?? "").trim() || "the auditor could not be reached",
        tone: "err",
        markdown: false,
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
        };
      // "done" is logged BEFORE the audit runs, so it must not read as final
      if (s === "done")
        return {
          label: "🏁 finish claimed — pending audit",
          detail: "the agent called finish(goalComplete=true); the verification contract is now being audited",
          tone: "",
          markdown: false,
        };
      if (s === "active")
        return {
          label: "▶ goal reopened",
          detail: "the audit rejected the finish — work continues on the same goal",
          tone: "warn",
          markdown: false,
        };
      return { label: `🎯 goal ${s || "updated"}`, detail: String(d.text ?? "").trim(), tone: "", markdown: false };
    }
    default: {
      const what = String(d.text ?? "").trim();
      const name = String(d.event ?? "").trim();
      return {
        label: name ? `🎯 goal ${name}` : "🎯 goal updated",
        // never render a bare label with nothing after it (#41) — that was the
        // exact shape of the reported bug
        detail: what || "no detail recorded",
        tone: "",
        markdown: false,
      };
    }
  }
}