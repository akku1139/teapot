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
  /**
   * The key that is ACTUALLY holding this directory collapsed, when it is not
   * the header's own `ws:<dir>` key.
   *
   * A solo chat used to have its own `chat:<id>` header, so a collapse from
   * before #58 is persisted under that key while the header is now the
   * directory's. The row must report it so the click handler can clear it —
   * otherwise the chat stays hidden and the caret keeps pointing "open", with
   * no control anywhere that can bring it back.
   */
  collapsedVia?: string;
}

/**
 * Flatten the agent forest into display order: each agent followed by its
 * sub-agents, newest sub first (a freshly spawned agent is what you want to
 * see), with collapsed subtrees omitted entirely.
 */
/**
 * Flatten the agent forest into display order: each agent followed by its
 * sub-agents, newest sub first (a freshly spawned agent is what you want to
 * see), with collapsed subtrees omitted entirely.
 *
 * `collapsed` holds agent ids whose SUBTREE is hidden. A top-level chat's row
 * is collapsible too — it is a group in its own right, because its sub-agents
 * hang beneath it — so the caller passes the chat group keys as well and both
 * kinds of collapse end up here, in one place.
 */
export function treeRowsOf<T extends TreeAgent>(
  agents: readonly T[],
  collapsedSubs: ReadonlySet<string> = new Set(),
  hideGhosts = false,
  collapsedChats: ReadonlySet<string> = new Set(),
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
      // A collapsed TOP-LEVEL chat still contributes its OWN row (so the caret
      // on it can bring the chat back) but NOT its sub-agents, which are what
      // the collapse actually hides. Dropping the row too is what strands a
      // chat: with the `chat:<id>` header gone, nothing else on screen controls
      // it and the stored key is never cleared.
      const chatOff = depth === 0 && collapsedChats.has(chatGroupKeyOf(list, a));
      if (chatOff) {
        rows.push({ a, depth });
        continue;
      }
      rows.push({ a, depth });
      const kids = byParent.get(a.id);
      if (kids?.length && !collapsedSubs.has(a.id)) walk(kids, depth + 1);
    }
  };
  // #62: a workspace header is only meaningful if a directory's chats are
  // CONTIGUOUS. Roots arrive in whatever order the server sent them, so a chat
  // created later (teapot-7) landed after another project's group and split
  // /p/teapot into two sections under the same header — the sidebar read as
  // three projects where there were two, and the count badge then contradicted
  // the rows beneath it.
  //
  // So group the roots by directory first. Directories keep first-seen order,
  // so the sidebar stays stable and predictable (sorting by name would reshuffle
  // everything whenever a project was added), and each group's chats keep their
  // own relative order.
  const groupKeys: string[] = [];
  const groups = new Map<string, T[]>();
  for (const a of roots) {
    const ws = workspaceOf(list, a.id);
    const g = groups.get(ws);
    if (g) g.push(a);
    else {
      groups.set(ws, [a]);
      groupKeys.push(ws);
    }
  }
  for (const ws of groupKeys) walk(groups.get(ws)!, 0);
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
  const out: SidebarRow<T>[] = [];
  let lastWs: string | null = null;
  for (const r of rows) {
    const ws = workspaceOf(agents, r.a.id);
    // A chat with no working directory has nothing to group by, so it gets no
    // header at all rather than one labelled with the empty string.
    if (!ws) {
      out.push({ a: r.a, depth: r.depth });
      continue;
    }
    // ONE header level: the working directory (#18).
    //
    // There used to be a second level — a `chat:<id>` header per top-level chat
    // — so a directory holding six chats rendered thirteen rows:
    //
    //     ▾ TEAPOT
    //       ▾ teapot
    //         teapot          <- same name again
    //
    // The chat level existed to make each top-level chat independently
    // collapsible, and that ability does not need its own row: a top-level chat
    // IS an agent row, and its sub-agents already hang beneath it. So the row
    // itself carries the collapse caret, exactly as a sub-agent's does, and
    // `chat:<id>` remains the group key so an old collapse still applies.
    if (ws !== lastWs) {
      lastWs = ws;
      out.push({
        a: r.a,
        depth: 0,
        headerOnly: true,
        wsHeader: ws,
        wsCollapsedGroup: collapsed.has(`ws:${ws}`),
      });
    }
    if (collapsed.has(`ws:${ws}`)) continue;
    // A collapsed CHAT keeps a row. With the `chat:<id>` header gone, that row
    // carries the caret — so hiding the row too would leave the chat
    // permanently unreachable: no header to click, no row to click, and the
    // stored key is never cleared. This is the strand-a-chat bug, and the
    // header used to be what prevented it.
    //
    // The row is marked so the UI can show it as collapsed (▸, dimmed) rather
    // than as a normal chat, and its sub-agents stay hidden.
    if (collapsed.has(chatGroupKeyOf(agents, r.a))) {
      out.push({ a: r.a, depth: r.depth, chatCollapsedGroup: true });
      continue;
    }
    out.push({ a: r.a, depth: r.depth });
  }
  return out;
}
