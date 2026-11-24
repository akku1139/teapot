/**
 * Text that is a SENTINEL, not something the model said.
 *
 * `sanitize()` fills an empty assistant `content` with `"(tool call)"` / `"(no content)"` so the wire carries a string where
 * the API requires one. Those are wire values. When one reaches the timeline it renders as a message the model never wrote —
 * reported as "thinkingエリアに `(tool call)` が出る" on three different models, all of which call a tool with no prose.
 *
 * Older logs also hold rows saved before the server stopped persisting them, so the check lives where the text is DISPLAYED
 * rather than only where it is written.
 */
const SENTINELS = new Set(["(tool call)", "(no content)"]);

export function isSentinelText(text: unknown): boolean {
  return SENTINELS.has(String(text ?? "").trim());
}
