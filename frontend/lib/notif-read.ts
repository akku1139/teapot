/**
 * Is a notification already READ at the moment it arrives?
 *
 * A notification exists so an operator who is looking somewhere else can find out later. While the timeline is following
 * the tail of the session the notification is about, the row it points at is being rendered on screen — so the bell must
 * not flash a badge for it, and the unread count must not jump for a message the operator is watching arrive.
 *
 * Reported as "スクロール追従時に通知が一瞬表示されるのが邪魔 / スクロール追従中は未読処理挟まずに既読化", and the mechanism was
 * that every notification was added unread and only cleared by a later scroll or visibility event — so the badge existed
 * for one frame at least, and for as long as nothing happened, at most.
 */
export function arrivesRead(opts: {
  /** the session the notification belongs to */
  notifAgentId: string;
  /** the session on screen */
  selectedAgentId: string | undefined;
  /** is the timeline following the tail of that session? */
  following: boolean;
  /** is the tab visible? a hidden tab is not being watched, whatever the scroll position says */
  visible: boolean;
}): boolean {
  if (!opts.visible) return false;
  return opts.following && opts.selectedAgentId === opts.notifAgentId;
}
