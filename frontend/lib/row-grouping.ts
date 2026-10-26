
export interface RowLike {
  type: string;
  session?: string;
  branch?: string;
  data?: {
    name?: unknown;
    actor?: unknown;
    source?: unknown;
    pending?: unknown;
    cancelled?: unknown;
    [other: string]: unknown;
  };
}

function authorBucketOf(ev: RowLike): string {
  if (ev.type === "prompt" && ev.data?.source === "user") return "you";
  if (ev.type === "message") return "agent";
  return "harness";
}

function actorKeyOf(ev: RowLike): string {
  const d = ev.data ?? {};
  if (ev.data?.actor) return `sub:${String(ev.data.actor)}`;
  if (ev.type === "tool_call" || ev.type === "tool_result") {
    const name = typeof d.name === "string" ? d.name : "";
    return name === "load_skill" ? "agent-skill" : `tool:${name}`;
  }
  if (ev.type === "prompt") return `src:${String(d.source ?? "user")}`;
  return `type:${ev.type}`;
}

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
