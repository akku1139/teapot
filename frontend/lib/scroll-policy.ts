
export type TailSample = Viewport;

export interface Viewport {
  top: number;
  height: number;
  viewport: number;
}

export const AT_TAIL_PX = 24;

export const STICKY_PX = 64;

export function floorOf(v: Viewport): number {
  return Math.max(0, v.height - v.viewport);
}

export function distanceToTail(v: Viewport | null | undefined): number {
  if (!v) return Number.POSITIVE_INFINITY;
  return Math.max(0, v.height - v.top - v.viewport);
}

export function atTail(v: Viewport | null | undefined, tolerance = AT_TAIL_PX): boolean {
  if (!v) return false;
  return distanceToTail(v) <= tolerance;
}

export type ScrollCause = "reader" | "programmatic" | "layout";

export function classifyScroll(
  now: Viewport,
  ledger: { top: number; height: number } | null,
  lastHeight: number | undefined,
  lastViewport?: number,
): ScrollCause {
  if (lastViewport !== undefined && Math.abs(now.viewport - lastViewport) > 0.5) return "layout";
  if (lastHeight !== undefined && Math.abs(now.height - lastHeight) > 0.5) return "layout";
  if (ledger) {
    const expected = Math.min(ledger.top, floorOf(now));
    if (Math.abs(now.top - expected) <= 0.5) return "programmatic";
  }
  return "reader";
}

export function shouldPin(following: boolean, v: Viewport): boolean {
  if (!following) return false;
  return distanceToTail(v) <= STICKY_PX;
}

export function nextFollowing(following: boolean, cause: ScrollCause, v: Viewport): boolean {
  if (cause !== "reader") {
    return following || atTail(v);
  }
  return atTail(v);
}

export function shouldShowJumpToPresent(following: boolean, v: Viewport): boolean {
  return !following && !atTail(v);
}

export const gapToTail = distanceToTail;
