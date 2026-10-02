/**
 * Sidebar tree layout — the pure part, extracted so it can be unit-tested.
 *
 * The sidebar interleaves three hierarchies and the ORDER they are emitted in
 * is the whole UX. Extracting this keeps the rule testable without a DOM
 * (happy-dom does no layout) and without pulling solid-js into `node --test`,
 * matching the split already used by live-buffer.ts and timeline-order.ts.
 *
 * Two group levels exist:
 *   - WORKSPACE (#18): a header wherever the working directory changes, so
 *     unrelated projects stop interleaving in one undifferentiated list;
 *   - CHAT: each TOP-LEVEL chat is its own group, so two chats that happen to
 *     share a directory stay independently collapsible.
 *
 * #58 — the CHAT level is emitted ONLY when the directory holds more than one
 * top-level chat. Emitted unconditionally, the common case (one chat per
 * project) rendered three rows saying the same thing — the directory header,
 * the chat header restating it, then the chat itself. Dropping the redundant
 * level is safe precisely because the workspace header is already keyed on
 * the directory, which in the solo case IS that chat's group.
 */

export interface TreeAgent {
  id: string;
  parent?: string;
  workspace: string;
  workspaceMissing?: boolean;
}

export interface TreeRow<T extends TreeAgent = TreeAgent> {
  a: T;
  depth: number;
}

/** A sidebar row: either a header or a chat. */
export interface SidebarRow<T extends TreeAgent = TreeAgent> {
  a: T;
  depth: number;
  /** the working directory this header names */
  wsHeader?: string;
  /** the `chat:<id>` group this header collapses */
  chatHeader?: string;
  /** a HEADER row: renders its caret + label, never the chat itself */
  headerOnly?: boolean;
  wsCollapsedGroup?: boolean;
  chatCollapsedGroup?: boolean;
}

/**
 * Flatten the agent forest into display order: each agent followed by its
 * sub-agents, newest sub first (a freshly spawned agent is what you want to
 * see), with collapsed subtrees omitted entirely.
 */
export function treeRowsOf<T extends TreeAgent>(
  agents: readonly T[],
  collapsedSubs: ReadonlySet<string> = new Set(),
  hideGhosts = false,
): TreeRow<T>[] {
  const list = hideGhosts ? agents.filter((a) => !a.workspaceMissing) : agents;
  const byParent = new Map<string, T[]>();
  const roots: T[] = [];
  for (const a of list) {
    const isSub = a.parent && list.some((p) => p.id === a.parent);
    if (isSub) {
      // newest sub first — a freshly spawned agent is what you want to see
      if (!byParent.has(a.parent!)) byParent.set(a.parent!, []);
      byParent.get(a.parent!)!.unshift(a);
    } else roots.push(a);
  }
  const rows: TreeRow<T>[] = [];
  const walk = (nodes: T[], depth: number) => {
    for (const a of nodes) {
      rows.push({ a, depth });
      const kids = byParent.get(a.id);
      if (kids?.length && !collapsedSubs.has(a.id)) walk(kids, depth + 1);
    }
  };
  walk(roots, 0);
  return rows;
}

/** The directory an agent belongs to; a sub-agent inherits its parent's. */
export function workspaceOf(agents: readonly TreeAgent[], id: string, seen = new Set<string>()): string {
  const a = agents.find((x) => x.id === id);
  if (!a) return "";
  if (!a.parent) return a.workspace || "";
  if (seen.has(id)) return a.workspace || ""; // cycle guard
  seen.add(id);
  return workspaceOf(agents, a.parent, seen) || a.workspace || "";
}

/** The group a chat collapses under — resolved to its TOP-LEVEL ancestor. */
export function chatGroupKeyOf(agents: readonly TreeAgent[], a: TreeAgent): string {
  let id = a.id;
  const seen = new Set<string>();
  for (;;) {
    const cur = agents.find((x) => x.id === id);
    if (!cur?.parent || seen.has(id)) break;
    seen.add(id);
    id = cur.parent;
  }
  return `chat:${id || a.id}`;
}

/**
 * How many TOP-LEVEL chats sit in each workspace.
 *
 * Sub-agents are excluded: one hangs under its parent's group, and counting it
 * would make a directory holding a single chat look like it held several —
 * which under #58 would wrongly keep the redundant chat header alive.
 */
export function wsChatCountsOf(agents: readonly TreeAgent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of agents) {
    if (a.parent) continue; // a sub-agent is part of its parent's group
    const ws = workspaceOf(agents, a.id);
    if (!ws) continue;
    counts.set(ws, (counts.get(ws) ?? 0) + 1);
  }
  return counts;
}

/**
 * Annotate the tree with its group headers, dropping collapsed members.
 *
 * `collapsed` holds the persisted collapse keys: `ws:<dir>` for a directory
 * and `chat:<id>` for a single top-level chat.
 */
export function sidebarRowsOf<T extends TreeAgent>(
  agents: readonly T[],
  rows: readonly TreeRow<T>[],
  collapsed: ReadonlySet<string> = new Set(),
): SidebarRow<T>[] {
  const counts = wsChatCountsOf(agents);
  const out: SidebarRow<T>[] = [];
  let lastWs: string | null = null;
  let lastEmittedChat: string | null = null;
  for (const r of rows) {
    const ws = workspaceOf(agents, r.a.id);
    const gkey = chatGroupKeyOf(agents, r.a);
    // A chat with no working directory has nothing to group by, so it gets no
    // header at all rather than one labelled with the empty string.
    if (!ws) {
      out.push({ a: r.a, depth: r.depth });
      continue;
    }
    // workspace header — emitted when the DIRECTORY changes
    if (ws !== lastWs) {
      lastWs = ws;
      lastEmittedChat = null;
      const solo = !r.a.parent && (counts.get(ws) ?? 0) <= 1;
      // A solo chat was collapsible through its own `chat:<id>` key before
      // #58, and that state is still on disk. Its header is gone now, so
      // honour it here — without this a chat the operator had deliberately
      // hidden would be stuck visible with no control left to reopen it.
      const wsOff = collapsed.has(`ws:${ws}`) || (solo && collapsed.has(gkey));
      out.push({ a: r.a, depth: 0, headerOnly: true, wsHeader: ws, wsCollapsedGroup: wsOff });
    }
    // EVERY row in the directory is subject to the directory's collapse, not
    // just the first one after its header. Checking only while emitting the
    // header let the remaining chats in a collapsed directory stay on screen
    // beneath it — the header said "collapsed" and the chats were still there.
    if (collapsed.has(`ws:${ws}`)) continue;
    // chat header — only for a top-level chat that is NOT alone in its
    // directory (#58). With a single chat the workspace header already
    // carries the caret, the name and the collapse toggle, so a second header
    // restating it is pure height.
    if (!r.a.parent) {
      if ((counts.get(ws) ?? 0) > 1 && gkey !== lastEmittedChat) {
        lastEmittedChat = gkey;
        out.push({
          a: r.a,
          depth: 0,
          headerOnly: true,
          chatHeader: gkey,
          chatCollapsedGroup: collapsed.has(gkey),
        });
      }
    }
    // A collapsed chat hides its own row AND every sub-agent under it: they
    // all resolve to the same top-level group key, so this covers the subtree.
    if (collapsed.has(gkey)) continue;
    out.push({ a: r.a, depth: r.depth });
  }
  return out;
}
