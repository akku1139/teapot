/**
 * Whether a keystroke in the composer SENDS, and whether a send collapses the expanded composer.
 *
 * Both were reported as bugs, and both are decisions that used to live inline in `App.tsx` where
 * only a source-text assertion could reach them — which is why the files that "covered" them
 * (`test/composer-maximized-enter.test.ts`, `test/composer-maximized-restores-on-send.test.ts`)
 * contained NO `test()` at all and protected nothing.
 *
 * ## #134 — Enter must not send while expanded
 *
 * The composer sent on `Enter && !shiftKey` with no reference to the expanded state, so a maximized
 * composer — the mode that exists to write long text — could not be typed into: every newline was a
 * send. Sending stays one click away (the button), so suppressing the shortcut costs nothing.
 *
 * ## #138 — a send DOES collapse it, deliberately
 *
 * An earlier fix made the maximize "sticky" so a mid-message send would not throw away writing
 * mode. That is right, and it is NOT what #138 reports: the maximized composer is
 * `position: absolute; inset: 0` over the whole column, so leaving it expanded after a send hides
 * the reply that was just requested. Once Enter no longer sends (#134), the send button is the exit,
 * so the exit must actually exit.
 *
 * Pure and dependency-free so it is unit-testable under `node --test`.
 */

export interface ComposerKeyState {
  key: string;
  shiftKey: boolean;
  /** an IME composition is in progress — Enter is confirming a conversion, not sending */
  composing: boolean;
  /** the composer is in its expanded (timeline-hiding) mode */
  maximized: boolean;
}

/**
 * Does this keydown send the message?
 *
 * Enter sends only when it is unambiguous: no Shift (newline), no IME composition (Enter commits the
 * candidate), and not expanded (the operator is writing, not sending).
 */
export function shouldSendOnKey(s: ComposerKeyState): boolean {
  if (s.key !== "Enter") return false;
  if (s.shiftKey) return false;
  if (s.composing) return false;
  if (s.maximized) return false;
  return true;
}

/**
 * Does a send restore the composer from its expanded mode?
 *
 * Always yes when it is expanded. The state cannot be left as-is: the expanded composer covers the
 * column, so the just-requested reply would be hidden behind the thing that asked for it.
 */
export function shouldRestoreAfterSend(maximized: boolean): boolean {
  return maximized;
}
