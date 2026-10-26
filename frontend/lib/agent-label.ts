export type LabelSource = {
  id: string;
  sessionTitle?: string;
};

export const agentLabel = (a: LabelSource | undefined | null): string =>
  a ? a.sessionTitle?.trim() || a.id : "";

export const agentLabelWithId = (a: LabelSource | undefined | null, extra?: string): string => {
  if (!a) return "";
  const label = agentLabel(a);
  const tail = extra ? ` — ${extra}` : "";
  return label === a.id ? `${label}${tail}` : `${label} — ${a.id}${tail}`;
};
