/**
 * Row grouping for the chat feed.
 *
 * #75 — this lived inline inside `MessageRow` in App.tsx, so the tests for it
 * re-implemented the predicate locally and asserted against THEIR OWN copy.
 * A replica passes by construction: deleting the real #49 fix left all four
 * behavioural tests green, because the local mirror still had the fix in it.
 *
 * Extracted so the rule is testable against the code that actually runs. The
 * component now calls `groupedWith()`.
 *
 * The rule: consecutive rows from the same ACTOR group together, so a run of
 * tool calls reads as one block. Three things must NOT group:
 *
 *  - a PENDING (queued) message, because its cancel affordance lives inside the
 *    msg-head and that head only renders when `!grouped` (#49) — so a queued
 *    message following a sent prompt lost its ✕ and could not be withdrawn;
 *  - a CANCELLED row, for the same reason;
 *  - rows from a different session or branch, which are not adjacent in time.
 *
 * The actor for tool events is THE AGENT, not the tool: keying by tool name
 * broke grouping as soon as two different tools ran back to back.
 */

export interface RowLike {
  type: string;
  session?: string;
  branch?: string;
  data?: {
    actor?: unknown;
    source?: unknown;
    pending?: unknown;
    cancelled?: unknown;
  };
}

/** Which side of the conversation a row belongs to. */
export function authorOf(ev: RowLike): { name: string } {
  if (ev.type === "prompt" && ev.data?.source === "user") return { name: "you" };
  if (ev.type === "message") return { name: "agent" };
  return { name: "harness" };
}

/** The grouping key for a row. Tool events all belong to the agent. */
export function actorKeyOf(ev: RowLike): string {
  const d = ev.data ?? {};
  if (ev.data?.actor) return `sub:${String(ev.data.actor)}`;
  if (ev.type === "tool_call" || ev.type === "tool_result") return "agent-tools";
  if (ev.type === "prompt") return `src:${String(d.source ?? "user")}`;
  return `type:${ev.type}`;
}

/**
 * Does `e` group with the row above it?
 *
 * `prev` undefined means it is the first row, which never groups.
 */
export function groupedWith(prev: RowLike | undefined, e: RowLike): boolean {
  return !!(
    prev &&
    !e.data?.pending &&
    !prev.data?.pending &&
    !e.data?.cancelled &&
    actorKeyOf(prev) === actorKeyOf(e) &&
    authorOf(prev).name === authorOf(e).name &&
    e.session === prev.session &&
    e.branch === prev.branch
  );
}
