
export type AuditPhase = "status" | "audit-started" | "audit" | "audit-failed" | "other";

export interface GoalEventData {
  event?: string;
  status?: string;
  by?: string;
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

export function isAuditLifecycle(d: GoalEventData): boolean {
  return auditPhase(d) !== "other";
}

export interface GoalLine {
  label: string;
  detail: string;
  tone: "ok" | "warn" | "err" | "";
  markdown: boolean;
  hasCard: boolean;
}

export function isPlaceholderDetail(s: string): boolean {
  const t = s.trim().toLowerCase();
  return t === "" || t === "(no detail)" || t === "no detail" || t === "(none)" || t === "(empty)";
}

export function cardDetail(raw: string, fallback: string): string {
  const t = String(raw ?? "").trim();
  if (!isPlaceholderDetail(t)) return t;
  return isPlaceholderDetail(fallback) ? "" : fallback;
}

export function goalLine(d: GoalEventData): GoalLine {
  switch (auditPhase(d)) {
    case "audit-started":
      return {
        label: "🔍️ completion audit started",
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
        label: "🔍️ audit unavailable — finish accepted",
        detail: String(d.detail ?? "").trim() || "the auditor could not be reached",
        tone: "err",
        markdown: false,
        hasCard: true,
      };
    case "status": {
      const s = String(d.status ?? "").trim();
      if (!s)
        return {
          label: "🎯 goal status updated",
          detail: String(d.text ?? "").trim() || "no status recorded",
          tone: "",
          markdown: true,
          hasCard: true,
        };
      if (s === "done") {
        const by = String(d.by ?? "").trim();
        if (by === "operator")
          return {
            label: "🏁 goal marked done",
            detail: "you marked this goal done — no audit runs for a manual completion",
            tone: "",
            markdown: false,
            hasCard: true,
          };
        return {
          label: "🏁 finish claimed — pending audit",
          detail: "the agent called finish(goalComplete=true); the verification contract is now being audited",
          tone: "",
          markdown: false,
          hasCard: true,
        };
      }
      if (s === "active") {
        const by = String(d.by ?? "").trim();
        if (by === "auditor") {
          return {
            label: "▶ goal reopened",
            detail: "the audit rejected the finish — work continues on the same goal",
            tone: "warn",
            markdown: false,
            hasCard: true,
          };
        }
        return {
          label: "▶ goal resumed",
          detail: "marked active again — auto-continue picks the goal up from the next turn",
          tone: "",
          markdown: false,
          hasCard: true,
        };
      }
      return {
        label: `🎯 goal ${s || "updated"}`,
        detail: String(d.text ?? "").trim() || `the goal is now ${s}`,
        tone: "",
        markdown: true,
        hasCard: true,
      };
    }
    default: {
      const what = String(d.text ?? "").trim();
      const name = String(d.event ?? "").trim();
      return {
        label: name ? `🎯 goal ${name}` : "🎯 goal updated",
        detail: what || `the "${name || "goal"}" event carried no further detail`,
        tone: "",
        markdown: true,
        hasCard: true,
      };
    }
  }
}
