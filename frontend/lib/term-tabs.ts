
export function indexAfterAppend<T>(list: readonly T[]): number {
  return list.length;
}

export function clampPaneIndex(index: number, tabCount: number): number {
  if (tabCount <= 0) return -1;
  if (index < 0) return -1;
  return Math.min(index, tabCount - 1);
}

export function paneIndexAfterClose(index: number, closedAt: number, newCount: number): number {
  if (index === closedAt) return clampPaneIndex(closedAt, newCount);
  if (index > closedAt) return clampPaneIndex(index - 1, newCount);
  return clampPaneIndex(index, newCount);
}

export function rightPaneSeed(leftPane: number, tabCount: number): number {
  const candidate = Array.from({ length: tabCount }, (_, i) => i).find((i) => i !== leftPane);
  return candidate ?? -1;
}
