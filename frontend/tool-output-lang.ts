/**
 * Which grammar, if any, a tool's OUTPUT should be highlighted with.
 *
 * "ツールエリアのshikiが効いてない" was reported with a `set_todo` card whose JSON argument block came
 * out as `<pre class="mono toolbody">`. The ARGUMENTS were already highlighted (`argsBlock` passes
 * `lang="json"`); the OUTPUT beside them was not, because `resultBlock` calls `codeBlock(out(), max)`
 * with no language at all. In a tool whose output is JSON — most MCP tools, and any tool returning a
 * serialised object — that is half the card rendering as plain text, which reads as "highlighting
 * does not work here".
 *
 * Guessing is worse than nothing: marking every output `json` would feed shell output, stack traces
 * and prose through a JSON grammar, where the tokenizer produces confident nonsense. So this only
 * says "json" when the text actually PARSES as JSON, and `null` otherwise — the caller then renders
 * the plain fallback it always did.
 *
 * Pure and dependency-free so it is unit-testable under `node --test`.
 */
export function outputLang(text: string): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  /**
   * Only the shapes a whole JSON VALUE can start with. This is a cheap gate, not the test: the
   * `JSON.parse` below decides. Without it, every bash output starting with `[` (a glob, a prompt)
   * would pay a parse attempt on each render.
   */
  const first = t[0];
  if (first !== "{" && first !== "[" && first !== '"') return undefined;
  // a truncated result (the caller caps at `max`) cannot parse, and highlighting a half-object as
  // JSON is the confident-nonsense case again — so only whole values are accepted
  try {
    const v: unknown = JSON.parse(t);
    // a bare string/number/true/null is technically JSON but carries no structure to colour
    return v !== null && typeof v === "object" ? "json" : undefined;
  } catch {
    return undefined;
  }
}
