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
  // #81: the ghost filter used to drop ghost sessions outright, BEFORE the
  // parent-presence check below. A ghost PARENT with a live CHILD therefore
  // orphaned that child: it became a root, and the directory grouping then put
  // it under the ghost's directory as a separate group at the BOTTOM of the
  // list, separated from everything it belongs with. That is the reported
  // "a session that has sub-agents shows none of them".
  //
  // So a ghost is only dropped when nothing visible hangs under it. A ghost that
  // still has live descendants stays in the list as the anchor they need — it is
  // exactly the structure 👻 is meant to hide, but hiding the parent hides the
  // children too.
  const list = hideGhosts
    ? agents.filter((a) => {
        if (!a.workspaceMissing) return true;
        // keep a ghost if anything NOT hidden descends from it
        const stack = [a.id];
        const seenIds = new Set<string>();
        while (stack.length) {
          const id = stack.pop()!;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          for (const c of agents) if (c.parent === id && !seenIds.has(c.id)) stack.push(c.id);
        }
        // if every descendant is also a ghost, this ghost can go safely
        for (const id of seenIds) {
          const d = agents.find((x) => x.id === id);
          if (d && !d.workspaceMissing) return true; // a live descendant needs this anchor
        }
        return false;
      })
    : agents;
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
      //
      // #81: this used to `continue`, which emitted the row here AND skipped the
      // recursion — while sidebarRowsOf ALSO emits the row. So the chat appeared
      // once (fine) but nothing marked it collapsed and, more importantly, the
      // recursion into its children was skipped for a reason that had nothing to
      // do with them. The row is emitted once, here, and the collapse simply
      // stops DESCENDING — the sub-agents stay in the tree, hidden under their
      // parent by sidebarRowsOf, which is what the 🧩 count has always implied.
      const chatOff = depth === 0 && collapsedChats.has(chatGroupKeyOf(list, a));
      rows.push({ a, depth });
      if (chatOff) continue;
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
    // #81: an orphaned sub-agent (parent not in `list`) is handled in the
    // dedicated pass below, which can resolve a workspace for it. Grouping it
    // here as well would emit it twice.
    if (a.parent) continue;
    const ws = workspaceOf(list, a.id);
    const g = groups.get(ws);
    if (g) g.push(a);
    else {
      groups.set(ws, [a]);
      groupKeys.push(ws);
    }
  }
  // #81: a sub-agent whose parent is NOT in `list` is treated as a ROOT, and
  // the grouping above then emits it BEFORE any header — so it rendered as a
  // bare row outside its project, with nothing above it. Two real ways that
  // happens: 👻 (hideGhosts) filters the list BEFORE the parent-presence check,
  // and removing a parent deletes it without reparenting its children.
  //
  // The 🧩 badge counts against `agents()`, not this list, so an orphan was
  // counted but not displayed — the badge and the tree disagreed, which is the
  // reported symptom: a session that HAS sub-agents showing none of them.
  //
  // So an orphan is grouped under its parent's DIRECTORY (workspaceOf walks up
  // through the missing parent), giving it the header it belongs to.
  //
  // An orphan with no resolvable directory gets a synthetic group rather than
  // being dropped: #81 was "a session that HAS sub-agents shows none of them",
  // and grouping silently is how it hid. These agents have no project to belong
  // to, so they are collected under one, which keeps them listed and keeps every
  // project group homogeneous — a header for them is honest ("no workspace")
  // rather than a bare row floating above the list.
  const ORPHANS = "";
  for (const a of roots) {
    if (!a.parent) continue;
    const ws = workspaceOf(agents, a.id) || ORPHANS;
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

/**
 * The directory an agent belongs to; a sub-agent inherits its parent's.
 *
 * #81: an ORPHANED sub-agent — one whose parent is not in the list, which
 * happens when 👻 (hideGhosts) filters the parent out or a parent is removed
 * without reparenting — used to resolve to `""`, because the walk stops at an
 * id it cannot find. That put it outside every group: no header above it, and
 * no project. Its 🧩 badge still counted (that asks `agents()`), so the badge
 * said 4 and the tree showed none.
 *
 * So when the parent cannot be resolved, fall back to this agent's OWN
 * declared workspace. Many sub-agents carry one; and where it is empty too,
 * the row still renders (just ungrouped) rather than vanishing.
 */
export function workspaceOf(agents: readonly TreeAgent[], id: string, seen = new Set<string>()): string {
  const a = agents.find((x) => x.id === id);
  if (!a) return "";
  if (!a.parent) return a.workspace || "";
  if (seen.has(id)) return a.workspace || ""; // cycle guard
  seen.add(id);
  const parentWs = workspaceOf(agents, a.parent, seen);
  if (parentWs) return parentWs;
  // parent unresolvable — use our own workspace rather than nothing
  return a.workspace || "";
}

/**
 * Should this sidebar row show its collapse caret? (#106)
 *
 * A caret that collapses nothing is noise — the operator reported exactly that:
 * "if there are no sub-agents, the expand button is not needed".
 *
 * The naive fix (gate a chat's caret on "has children") is WRONG, and #18
 * documented why. Collapsing is what WRITES the `chat:<id>` key, so a chat can
 * hold a STALE one by two ordinary routes:
 *
 *   1. upgrade — every chat was collapsed under the old chat header, so every
 *      existing install starts with keys already set;
 *   2. a chat that HAD sub-agents, was collapsed, then lost them to disposal.
 *
 * In both, `sidebarRowsOf` still renders the row marked `chatCollapsedGroup`, so
 * it is visible — but with no caret there is NO on-screen control to clear the
 * key, and the chat is stuck showing ▸ for good. That is the strand-a-chat bug.
 *
 * So: a caret is shown exactly when it would do something, or when it is the only
 * way back out.
 */
export function shouldShowCollapseCaret(args: {
  /** is this row a sub-agent rather than a top-level chat? */
  isSub: boolean;
  /** is the row's group currently collapsed? */
  collapsed: boolean;
  /** does this row have any children? */
  hasChildren: boolean;
}): boolean {
  return args.isSub ? args.hasChildren : args.collapsed || args.hasChildren;
}

/**
 * Every DESCENDANT of `agentId`, at any depth (#98).
 *
 * #98: the sidebar's 🧩 badge counted only DIRECT children
 * (`agents().filter(x => x.parent === agentId)`), so a sub-agent that spawned
 * its own reported a smaller number than actually existed — and a busy nested
 * subtree was invisible, because the `· ▶N` active count had the same shape.
 *
 * `subtreeUnread` in App.tsx already recurses for notifications, so the tree
 * could disagree with the badge about the same subtree. This is the shared
 * version; `seen` guards a cycle in `parent`, which would otherwise recurse
 * forever.
 */
/**
 * The display name a sub-agent was spawned with, recovered from its id.
 *
 * #121: the sidebar's tooltip said only `sub-agent of @<parent>`, so hovering a
 * row named `tyb2-6-sub-mt6628_reg` revealed nothing about WHAT it is — and the
 * parent is already visible two lines above it in the same panel.
 *
 * The name is not stored separately: `spawnChildFor` builds the id as
 * `<parent>-sub[-<persona>]-<name>` (master.ts:782), so it is recovered from
 * that. Characters outside `[\w.-]` were substituted with underscores at spawn
 * time, so they are turned back into spaces — `mt6628_reg` reads as `mt6628 reg`
 * rather than leaking the mangling.
 *
 * Returns null when the id carries no name, so the caller can fall back rather
 * than show an empty tooltip.
 */
export function subAgentDisplayName(id: string, personas: readonly string[] = []): string | null {
  const at = id.indexOf("-sub");
  if (at === -1) return null;
  // strip the separator too, so `-mt6628_reg` does not carry a leading dash
  const rest = id.slice(at + "-sub".length).replace(/^-+/, "");
  if (!rest) return null;
  const parts = rest.split("-");
  // A persona, when present, is the FIRST segment: `<parent>-sub-<persona>-<name>`.
  // The persona list lives on the server and the frontend already loads it from
  // /api/personas, so it is passed in rather than duplicated here — a stale copy
  // would mis-parse every persona-spawned id the day a persona is added.
  const name = personas.includes(parts[0] ?? "") ? parts.slice(1).join("-") : rest;
  return name.replace(/_/g, " ").trim() || null;
}

export function descendantsOf<T extends TreeAgent>(
  agents: readonly T[],
  agentId: string,
  seen = new Set<string>(),
): T[] {
  const out: T[] = [];
  const guard = new Set(seen);
  for (const a of agents) {
    if (a.parent !== agentId) continue;
    if (guard.has(a.id)) continue; // cycle: a -> b -> a
    guard.add(a.id);
    out.push(a, ...descendantsOf(agents, a.id, guard));
  }
  return out;
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
