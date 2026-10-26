
export type AuditVerdict =
  | { kind: "approved"; reason: string }
  | { kind: "changes-required"; reason: string }
  | { kind: "none"; detail: string };

const PLACEHOLDER = /^\((tool call|no content|no output)\)$/i;

export function parseAuditVerdict(reply: string): AuditVerdict {
  const text = String(reply ?? "").trim();
  if (!text || PLACEHOLDER.test(text)) return { kind: "none", detail: "auditor returned no text" };
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  const approved = /^APPROVED\b(:|\s-|$)(.*)$/i.exec(last);
  if (approved) {
    return { kind: "approved", reason: (approved[2] ?? "").trim() || "(no justification given)" };
  }
  const rejected = /^CHANGES-REQUIRED\b(:|\s-|$)(.*)$/i.exec(last);
  if (rejected) {
    return { kind: "changes-required", reason: (rejected[2] ?? "").trim() || "(no gaps named)" };
  }
  return { kind: "none", detail: `auditor reply had no verdict on its last line: ${last.slice(0, 200)}` };
}

export function auditPrompt(input: {
  goal: string;
  verify: string;
  summary: string;
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
