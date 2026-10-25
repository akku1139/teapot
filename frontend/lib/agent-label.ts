/**
 * What an agent or session is CALLED on screen.
 *
 * Three places name the same thing — the left panel row, the header title, and `document.title` —
 * and they disagreed: the panel prefixed the session title ("オーディオの問題は…"), while the header
 * and the tab showed the raw id (`tyb2-9`), which is a slug the operator never typed. Reported as
 * "`<title>` と上部バーのチャットタイトルが左パネルのタイトルじゃなくて、チャットのslugになってる".
 *
 * One function, so a fourth place cannot pick a different rule.
 */
export type LabelSource = {
  id: string;
  /** the session's first usable prompt line, when the server has computed one */
  sessionTitle?: string;
};

/** The human name, falling back to the id — which is what a session with no prompt yet has. */
export const agentLabel = (a: LabelSource | undefined | null): string =>
  a ? a.sessionTitle?.trim() || a.id : "";

/**
 * The same name, qualified with the id only when they differ.
 *
 * Used where an operator has to be able to MATCH the row to its id (the tooltip, the tab title):
 * repeating the id when it is already the label is noise, and hiding it when the label replaced it
 * is ambiguous between two sessions of one agent.
 */
export const agentLabelWithId = (a: LabelSource | undefined | null, extra?: string): string => {
  if (!a) return "";
  const label = agentLabel(a);
  const tail = extra ? ` — ${extra}` : "";
  return label === a.id ? `${label}${tail}` : `${label} — ${a.id}${tail}`;
};
