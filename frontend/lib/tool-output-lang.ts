export function outputLang(text: string): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const first = t[0];
  if (first !== "{" && first !== "[" && first !== '"') return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return v !== null && typeof v === "object" ? "json" : undefined;
  } catch {
    return undefined;
  }
}

export function formatToolOutput(text: string): string {
  if (outputLang(text) !== "json") return text;
  try {
    const value: unknown = JSON.parse(text.trim());
    const pretty = JSON.stringify(value, null, 1);
    return text.trim().split("\n").length > 1 ? text : pretty;
  } catch {
    return text;
  }
}
