/**
 * Row grouping for the chat feed.
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
 * split a run as soon as two different tools ran back to back.
 *
 * #75: extracted from App.tsx so the tests drive the code that runs.
 */

export interface RowLike {
  type: string;
  session?: string;
  branch?: string;
  data?: {
    /** the tool name, used to single out a skill load (#149) */
    name?: unknown;
    actor?: unknown;
    source?: unknown;
    pending?: unknown;
    cancelled?: unknown;
  };
}

/**
 * Which side of the conversation a row belongs to — a coarse 3-way bucket used as
 * a GROUPING key. (App.tsx has its own `authorOf` for display metadata; the two
 * are unrelated, hence the distinct name here.)
 *
 * Returns a STRING, not an object: a comparison of two `{name}` objects is a
 * reference comparison and is always false, which silently disabled grouping.
 */
function authorBucketOf(ev: RowLike): string {
  if (ev.type === "prompt" && ev.data?.source === "user") return "you";
  if (ev.type === "message") return "agent";
  return "harness";
}

/**
 * The grouping key for a row.
 *
 * Tool events all share the AGENT's key: keying by tool NAME split a run as soon as
 * two different tools ran back to back.
 *
 * `load_skill` is the exception (#149). It renders as an EXPANDED panel of prose
 * (the skill body), so a following row grouping under it reads as part of that
 * prose rather than as the next action — reported as "the bash after load_skill is
 * hanging under it". It gets its own key, which still groups the call with its
 * result (one visual unit) but not with an ordinary tool row after it.
 */
function actorKeyOf(ev: RowLike): string {
  const d = ev.data ?? {};
  if (ev.data?.actor) return `sub:${String(ev.data.actor)}`;
  if (ev.type === "tool_call" || ev.type === "tool_result") {
    const name = typeof d.name === "string" ? d.name : "";
    return name === "load_skill" ? "agent-skill" : "agent-tools";
  }
  if (ev.type === "prompt") return `src:${String(d.source ?? "user")}`;
  return `type:${ev.type}`;
}

/** Does `e` group with the row above it? A first row (no `prev`) never does. */
export function groupedWith(prev: RowLike | undefined, e: RowLike): boolean {
  return !!(
    prev &&
    !e.data?.pending &&
    !prev.data?.pending &&
    !e.data?.cancelled &&
    actorKeyOf(prev) === actorKeyOf(e) &&
    authorBucketOf(prev) === authorBucketOf(e) &&
    e.session === prev.session &&
    e.branch === prev.branch
  );
}
