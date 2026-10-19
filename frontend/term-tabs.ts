/**
 * Pure bookkeeping for the terminal drawer's tab/pane pairing (#172).
 *
 * The bug this exists to prevent: `addTab` read the new tab's index from
 * `termTabs().length` AFTER calling `setTermTabs`. A Solid setter applies
 * SYNCHRONOUSLY, so that read returns the NEW length — one past the end. The pane
 * therefore pointed outside the array, which renders as
 *
 *     no shell here — ＋ opens one, tabs fill the focused pane
 *
 * while a tab visibly existed. The operator's report was "勝手に新しいタブを作る /
 * しかもタブが生えたのに no shell here のことがある" — they pressed ＋ again because
 * nothing appeared, and each press added another tab.
 *
 * Kept as a function rather than inline in the component because the mistake is pure
 * arithmetic and testable without a terminal, a WebSocket, or an xterm instance — and
 * an inline version already regressed once.
 */

/**
 * The index a newly appended tab will occupy.
 *
 * Read `length` BEFORE mutating the list. Taking the list (rather than a length) makes
 * the ordering impossible to get wrong at the call site: the caller passes what it has
 * now, and gets the index the append will produce.
 */
export function indexAfterAppend<T>(list: readonly T[]): number {
  return list.length;
}

/**
 * Clamp a pane index after the tab list changed.
 *
 * - An empty list has no valid index, so both panes go to -1 ("nothing to show").
 * - A pane that was pointing past the end (the #172 symptom, or a close that removed
 *   the tab it showed) moves to the last tab instead of staying invalid.
 * - A valid index is left alone, so an unrelated list change does not move the
 *   operator's focus.
 */
export function clampPaneIndex(index: number, tabCount: number): number {
  if (tabCount <= 0) return -1;
  if (index < 0) return -1;
  return Math.min(index, tabCount - 1);
}

/**
 * The pane index to adopt when a tab is closed.
 *
 * Closing the tab a pane shows must land on a REAL neighbour rather than the invalid
 * index, or the pane shows "no shell here" until the operator clicks a tab. Tabs after
 * the closed one shift down by one; a tab before it is unaffected.
 */
export function paneIndexAfterClose(index: number, closedAt: number, newCount: number): number {
  if (index === closedAt) return clampPaneIndex(closedAt, newCount);
  if (index > closedAt) return clampPaneIndex(index - 1, newCount);
  return clampPaneIndex(index, newCount);
}

/**
 * The tab a freshly split right pane should show: any tab the left pane is NOT
 * showing, or -1 when there is only one tab.
 */
export function rightPaneSeed(leftPane: number, tabCount: number): number {
  const candidate = Array.from({ length: tabCount }, (_, i) => i).find((i) => i !== leftPane);
  return candidate ?? -1;
}
