
export interface Rule {
  level: "MUST" | "MUST NOT" | "SHOULD";
  text: string;
  line: string;
}

export const RULES_HEADING = "## Hard constraints";

const LEVELS = ["MUST NOT", "MUST", "SHOULD"] as const;

export function extractRules(summary: string): Rule[] {
  const lines = summary.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === RULES_HEADING.toLowerCase());
  if (start < 0) return [];
  const out: Rule[] = [];
  const seen = new Set<string>();
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^#{1,6}\s/.test(raw.trim())) break;
    const line = raw.replace(/^\s*[-*+]\s*/, "").trim();
    if (!line) continue;
    const m = /^(MUST NOT|MUST|SHOULD)\b[:\s]*(.*)$/i.exec(line);
    if (!m) continue;
    const level = m[1]!.toUpperCase().replace(/\s+/g, " ") as Rule["level"];
    const text = m[2]!.trim();
    if (!text) continue;
    const key = text.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ level, text, line });
  }
  return out;
}

export function renderRules(rules: readonly Rule[]): string {
  const rank = (r: Rule) => LEVELS.indexOf(r.level);
  return [...rules]
    .sort((a, b) => rank(a) - rank(b))
    .map((r) => `- ${r.level} ${r.text}`)
    .join("\n");
}

export function enforceRules(summary: string, before: readonly Rule[]): { summary: string; restored: Rule[] } {
  const after = extractRules(summary);
  const present = new Set(
    after.map((r) => r.text.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim()),
  );
  const restored = before.filter((r) => {
    const key = r.text.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
    return !present.has(key);
  });
  const merged = [...after, ...restored];
  const body = renderRules(merged);
  const section = body ? `${RULES_HEADING}\n${body}` : RULES_HEADING;

  const lines = summary.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === RULES_HEADING.toLowerCase());
  if (start < 0) {
    return { summary: `${summary.trimEnd()}\n\n${section}`, restored };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!.trim())) {
      end = i;
      break;
    }
  }
  return {
    summary: [...lines.slice(0, start), ...section.split("\n"), "", ...lines.slice(end)].join("\n"),
    restored,
  };
}

export function rulesForPrompt(rules: readonly Rule[]): string {
  if (!rules.length) return "";
  return `${RULES_HEADING}\n${renderRules(rules)}`;
}
