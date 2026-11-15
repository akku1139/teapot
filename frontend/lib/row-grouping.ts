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

/**
 * A wrapper tool is not an identity.
 *
 * `run_tool` and `search_tools` are the same tool name on every call, so grouping on `data.name` alone merged a run of cards
 * that invoked DIFFERENT MCP tools into one visual run — reported as "search_tool, run_tool 由来のツールカードがツール名によらず
 * 連続している". The thing the operator is reading is the tool the card NAMES, so that is what the key has to be.
 */
function wrappedToolOf(d: Record<string, unknown>): string {
  const args = (d.args ?? {}) as Record<string, unknown>;
  if (typeof args.tool_id === "string") return args.tool_id;
  if (typeof args.tool === "string") return args.tool;
  if (typeof args.name === "string") return args.name;
  return "";
}

function actorKeyOf(ev: RowLike): string {
  const d = ev.data ?? {};
  if (ev.data?.actor) return `sub:${String(ev.data.actor)}`;
  if (ev.type === "tool_call" || ev.type === "tool_result") {
    const name = typeof d.name === "string" ? d.name : "";
    if (name === "load_skill") return "agent-skill";
    /**
     * A wrapper's own name says nothing about what the row is: key on the tool it invoked (and, for `search_tools`, on the
     * query, since two searches of different words are two different subjects).
     */
    if (name === "run_tool" || name === "search_tools") {
      const inner = wrappedToolOf(d as Record<string, unknown>);
      const q = typeof (d as Record<string, unknown>).args === "object"
        ? String(((d as Record<string, unknown>).args as Record<string, unknown>).query ?? "")
        : "";
      return `tool:${name}:${inner || q || "(none)"}`;
    }
    return `tool:${name}`;
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
