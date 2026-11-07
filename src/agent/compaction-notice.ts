/**
 * The message that replaces a compacted history — built by ONE function, for BOTH paths.
 *
 * Two things made this file necessary.
 *
 * **The divergence.** A compaction writes a notice as `messages[0]`. A restart rebuilds that same notice from the log's
 * `compaction` event. When the two builders are separate, they drift: the runtime one gained a "the window is roomy
 * again" line and the restored one did not, so the oldest message in the conversation changed after a restart. Every
 * request's bytes are the provider's prefix-cache key, so a notice that changes at the FRONT of the conversation
 * invalidates the cache for the whole session — the operator spotted this immediately ("場合によってはprefix cacheが
 * 破壊されるので結構な問題になるんだけど").
 *
 * **The owner.** The line is a FACT about a moment in time (how much of the window was in use right after that
 * compaction). Recomputing it at restore time would be a second owner of that fact and would also change the bytes on
 * every restore. So it is written into the `compaction` event when it happens and read back verbatim; an older log
 * without it simply gets the notice it always had, and nothing is rewritten.
 */
export interface CompactionNoticeInput {
  summarized: number;
  summary: string;
  /** the usage line recorded WITH the compaction, if this build wrote one */
  contextLine?: string;
}

export function compactionNotice(input: CompactionNoticeInput): string {
  const base =
    `[harness] Context was compacted: ${input.summarized} earlier messages were summarized. ` +
    "AGENTS.md is embedded in your system prompt; memory.md, todo.md and decisions.md are NOT — " +
    "call read_memory / get_todo / get_decisions if you need them.\n\n" +
    `## Summary of earlier conversation\n${input.summary}`;
  const line = (input.contextLine ?? "").trim();
  return line ? `${base}\n\n${line} — the window is roomy again, not nearly exhausted.` : base;
}
