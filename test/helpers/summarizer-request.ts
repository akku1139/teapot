import type { ChatMessage } from "../../src/agent/llm.ts";

const SUMMARIZER_MARKER = "You compress a coding agent's conversation";

export function isSummarizerRequest(messages: readonly ChatMessage[] | unknown): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1] as ChatMessage | undefined;
  return String(last?.content ?? "").includes(SUMMARIZER_MARKER);
}

export function summarizerInstruction(messages: readonly ChatMessage[] | unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  return String((messages[messages.length - 1] as ChatMessage | undefined)?.content ?? "");
}
