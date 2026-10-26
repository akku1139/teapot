
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

export interface SidebarRow<T extends TreeAgent = TreeAgent> {
  a: T;
  depth: number;
  wsHeader?: string;
  chatHeader?: string;
  headerOnly?: boolean;
  wsCollapsedGroup?: boolean;
  chatCollapsedGroup?: boolean;
  collapsedVia?: string;
}

export function treeRowsOf<T extends TreeAgent>(
  agents: readonly T[],
  collapsedSubs: ReadonlySet<string> = new Set(),
  hideGhosts = false,
  collapsedChats: ReadonlySet<string> = new Set(),
): TreeRow<T>[] {
  const list = hideGhosts
    ? agents.filter((a) => {
        if (!a.workspaceMissing) return true;
        const stack = [a.id];
        const seenIds = new Set<string>();
        while (stack.length) {
          const id = stack.pop()!;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          for (const c of agents) if (c.parent === id && !seenIds.has(c.id)) stack.push(c.id);
        }
        for (const id of seenIds) {
          const d = agents.find((x) => x.id === id);
          if (d && !d.workspaceMissing) return true; 
        }
        return false;
      })
    : agents;
  const byParent = new Map<string, T[]>();
  const roots: T[] = [];
  for (const a of list) {
    const isSub = a.parent && list.some((p) => p.id === a.parent);
    if (isSub) {
      if (!byParent.has(a.parent!)) byParent.set(a.parent!, []);
      byParent.get(a.parent!)!.unshift(a);
    } else roots.push(a);
  }
  const rows: TreeRow<T>[] = [];
  const walk = (nodes: T[], depth: number) => {
    for (const a of nodes) {
      const chatOff = depth === 0 && collapsedChats.has(chatGroupKeyOf(list, a));
      rows.push({ a, depth });
      if (chatOff) continue;
      const kids = byParent.get(a.id);
      if (kids?.length && !collapsedSubs.has(a.id)) walk(kids, depth + 1);
    }
  };
  const groupKeys: string[] = [];
  const groups = new Map<string, T[]>();
  for (const a of roots) {
    if (a.parent) continue;
    const ws = workspaceOf(list, a.id);
    const g = groups.get(ws);
    if (g) g.push(a);
    else {
      groups.set(ws, [a]);
      groupKeys.push(ws);
    }
  }
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

export function workspaceOf(agents: readonly TreeAgent[], id: string, seen = new Set<string>()): string {
  const a = agents.find((x) => x.id === id);
  if (!a) return "";
  if (!a.parent) return a.workspace || "";
  if (seen.has(id)) return a.workspace || ""; 
  seen.add(id);
  const parentWs = workspaceOf(agents, a.parent, seen);
  if (parentWs) return parentWs;
  return a.workspace || "";
}

export function shouldShowCollapseCaret(args: {
  isSub: boolean;
  collapsed: boolean;
  hasChildren: boolean;
}): boolean {
  return args.isSub ? args.hasChildren : args.collapsed || args.hasChildren;
}

export function subAgentDisplayName(id: string, personas: readonly string[] = []): string | null {
  const at = id.indexOf("-sub");
  if (at === -1) return null;
  const rest = id.slice(at + "-sub".length).replace(/^-+/, "");
  if (!rest) return null;
  const parts = rest.split("-");
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
    if (guard.has(a.id)) continue; 
    guard.add(a.id);
    out.push(a, ...descendantsOf(agents, a.id, guard));
  }
  return out;
}

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

export function wsChatCountsOf(agents: readonly TreeAgent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of agents) {
    if (a.parent) continue; 
    const ws = workspaceOf(agents, a.id);
    if (!ws) continue;
    counts.set(ws, (counts.get(ws) ?? 0) + 1);
  }
  return counts;
}

export function sidebarRowsOf<T extends TreeAgent>(
  agents: readonly T[],
  rows: readonly TreeRow<T>[],
  collapsed: ReadonlySet<string> = new Set(),
): SidebarRow<T>[] {
  const out: SidebarRow<T>[] = [];
  let lastWs: string | null = null;
  for (const r of rows) {
    const ws = workspaceOf(agents, r.a.id);
    if (!ws) {
      out.push({ a: r.a, depth: r.depth });
      continue;
    }
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
    if (collapsed.has(chatGroupKeyOf(agents, r.a))) {
      out.push({ a: r.a, depth: r.depth, chatCollapsedGroup: true });
      continue;
    }
    out.push({ a: r.a, depth: r.depth });
  }
  return out;
}
