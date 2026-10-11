/**
 * Recognise a compaction-summarizer request from the messages it carries.
 *
 * The shape changed, so detection had to change with it. The summarizer used to be
 * identifiable by its FIRST message (a bespoke "You compress a coding agent's
 * conversation…" system prompt). It now REPLAYS the conversation's own system
 * prompt plus the shadowed region and appends its directive as the LAST message —
 * that is what makes the call a genuine prefix extension of the last routed request,
 * so the provider's KV cache is reused instead of invalidated at the first token.
 *
 * So `messages[0]` is now indistinguishable from an ordinary turn, and any test that
 * still looks there silently stops recognising the summarizer: it answers as though
 * the request were a normal turn, the compaction looks like it never happened, and
 * the failure reads as a compaction bug rather than a detection bug. That already
 * happened once (the update-mode reword), which is why this lives in one place.
 */
import type { ChatMessage } from "../src/agent/llm.ts";

/** the opening sentence of the trailing directive (see COMPACT_INSTRUCTION) */
const SUMMARIZER_MARKER = "You compress a coding agent's conversation";

/** Is this request the compaction summarizer? */
export function isSummarizerRequest(messages: readonly ChatMessage[] | unknown): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1] as ChatMessage | undefined;
  return String(last?.content ?? "").includes(SUMMARIZER_MARKER);
}

/** The directive text, for a test that needs to assert something about it. */
export function summarizerInstruction(messages: readonly ChatMessage[] | unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  return String((messages[messages.length - 1] as ChatMessage | undefined)?.content ?? "");
}
