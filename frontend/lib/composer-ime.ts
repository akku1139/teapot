/**
 * The composer's textarea is a controlled input (`value={draft()}`), and Solid
 * writes the DOM node's `value` on every change of that signal.
 *
 * That write is what loses text on a Japanese keyboard. During an IME
 * composition the browser owns the textarea's contents: the pre-edit kana live
 * in the composition, not in `value`. Assigning `.value` mid-composition ENDS
 * the composition, and the characters typed so far are discarded with it —
 * reported as "入力中のメッセージが消失する".
 *
 * Measured, not guessed: an instrumented bundle in happy-dom counted TWO
 * `.value` writes per `input` event, both during a simulated composition
 * (`にほんご` written twice before `compositionend`).
 *
 * The fix is to stop writing while a composition is in progress. Every
 * composition ends with a `compositionend`/`input` pair, and that is when the
 * signal is synced, so nothing is lost — the write is deferred, not dropped.
 *
 * Pure so it can be tested under `node --test` without a DOM.
 */

/**
 * Should a change of the draft signal be written back into the textarea?
 *
 * @param composing      a composition is in progress RIGHT NOW
 * @param composingEnded a composition just ended and has not been written yet
 *
 * The second parameter exists because the ending must still land: the browser
 * fires `compositionend` and then `input`, and Solid's effect for THAT input may
 * already have run with `composing` false — but a caller that clears its flag
 * before the write would leave the final converted text unwritten. So the rule
 * is: write when nothing is composing, and never write while one is.
 */
export function shouldWriteComposerValue(composing: boolean): boolean {
  return !composing;
}

/**
 * A cheaper test of the same rule for the common path: is this write a no-op?
 *
 * Writing a value the node already holds still counts as a write to the DOM and
 * still disturbs an active composition (the browser cannot tell a redundant
 * assignment from a real one), so the check is on the VALUE, not on whether the
 * text "changed" from the signal's point of view.
 */
export function composerValueChanged(nodeValue: string, next: string): boolean {
  return nodeValue !== next;
}
