/**
 * Keep the operator's hard rules alive across a compaction.
 *
 * ## Why this is not just another summary section
 *
 * A compaction summary is generated text: everything in it was re-derived by a model from the
 * conversation it was shown. That is fine for facts, because facts can be re-checked against the
 * code. A RULE cannot — "never install this into Wine", "do not clone repositories to study them"
 * were each stated once, obeyed silently for dozens of turns, and are not repeated anywhere the
 * next pass could find them. When the summary drops one, nothing downstream notices; the agent
 * just starts doing it.
 *
 * So the rules get a section with a SHAPE the code can check (`MUST` / `MUST NOT` / `SHOULD` at the
 * start of each line), extracted on the way out and RE-INSERTED on the way in if a pass lost them.
 * The summarizer is still the thing that decides what the rules ARE; this module only makes sure
 * that once known they cannot disappear.
 *
 * ## Why the shape matters more than the wording
 *
 * A free-form section lets a model merge three rules into one sentence, which is how a `MUST NOT`
 * turns into a `SHOULD avoid` and then into nothing. A fixed keyword per line keeps each rule a
 * separate, checkable item. `should` is included deliberately — the operator asked for it — but it
 * is ranked below the musts so a squeeze drops the weakest first.
 */

/** one parsed rule */
export interface Rule {
  /** `MUST`, `MUST NOT` or `SHOULD` */
  level: "MUST" | "MUST NOT" | "SHOULD";
  /** the rule text without its keyword */
  text: string;
  /** the original line, so re-insertion preserves the model's own wording */
  line: string;
}

export const RULES_HEADING = "## Hard constraints";

/** the levels, strongest first — the order a squeeze must respect */
const LEVELS = ["MUST NOT", "MUST", "SHOULD"] as const;

/**
 * Parse the `## Hard constraints` section out of a summary.
 *
 * Tolerant on purpose: the summarizer is asked for a shape, not guaranteed to produce it. A line
 * that does not start with a keyword is ignored rather than guessed at, because inventing a rule
 * from prose is worse than losing one — a wrong rule is obeyed.
 */
export function extractRules(summary: string): Rule[] {
  const lines = summary.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === RULES_HEADING.toLowerCase());
  if (start < 0) return [];
  const out: Rule[] = [];
  const seen = new Set<string>();
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    // a new `##` heading ends the section
    if (/^#{1,6}\s/.test(raw.trim())) break;
    const line = raw.replace(/^\s*[-*+]\s*/, "").trim();
    if (!line) continue;
    // longest keyword first, or `MUST NOT` parses as `MUST` + "NOT …"
    const m = /^(MUST NOT|MUST|SHOULD)\b[:\s]*(.*)$/i.exec(line);
    if (!m) continue;
    const level = m[1]!.toUpperCase().replace(/\s+/g, " ") as Rule["level"];
    const text = m[2]!.trim();
    if (!text) continue;
    // de-duplicate on the normalised text: two paraphrases of one rule is one rule
    const key = text.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ level, text, line });
  }
  return out;
}

/** the section body for a set of rules, in strongest-first order */
export function renderRules(rules: readonly Rule[]): string {
  const rank = (r: Rule) => LEVELS.indexOf(r.level);
  return [...rules]
    .sort((a, b) => rank(a) - rank(b))
    .map((r) => `- ${r.level} ${r.text}`)
    .join("\n");
}

/**
 * Re-insert rules a compaction pass dropped.
 *
 * `before` is what was known going in, `after` is the section the new summary produced. Anything in
 * `before` whose text is not present in `after` is appended (strongest first) so a pass can add
 * rules and reword them, but can never lose one. Returns the summary with the section rewritten.
 *
 * Rewriting rather than appending is what makes this idempotent: running it twice on the same
 * summary produces the same summary, which matters because the update path compacts repeatedly.
 */
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
    // no section at all — append one rather than silently keeping nothing
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

/**
 * The rules as a line the summarizer is asked to keep, for the UPDATE path.
 *
 * Passed as part of the prior checkpoint so a pass that is told "preserve what is still true" can
 * see the rules explicitly instead of having to find them in prose.
 */
export function rulesForPrompt(rules: readonly Rule[]): string {
  if (!rules.length) return "";
  return `${RULES_HEADING}\n${renderRules(rules)}`;
}
