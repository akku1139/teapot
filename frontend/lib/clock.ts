import { createSignal } from "solid-js";

/**
 * ONE clock for the whole app, so anything that shows elapsed time is a live readout.
 *
 * `fmtDur(Date.now() - startedAt)` in a template renders the instant of the LAST render and then freezes: `Date.now()` is not
 * reactive, so nothing re-runs the expression. MEASURED as "background shells パネルが開いたときの状態で固定されて、時刻カウントもラ
 * イブ更新も進まない", and it had already been fixed twice in isolation (`BashElapsed`, `ThinkingTimer`) with a private
 * `setInterval` each — three intervals once the shells panel needed one, one per row.
 *
 * A module-level signal driven by ONE interval, because:
 *
 *  - a per-component interval cannot be tested at all: Solid 2 defers effects until a renderer settles, so an interval armed
 *    in `createEffect`/`onSettled` never starts outside a real render root (MEASURED — a unit test saw the value stay at its
 *    initial reading);
 *  - and it must not be tested through the DOM either: with the frozen `Date.now()` version the panel's text still moved
 *    ("1m 5s" → "1m 6s") because any unrelated re-render repaints the template. Only the clock itself can be asked.
 *
 * `startClock` is idempotent and returns its own stopper, so the app starts it once and a test starts it in isolation.
 */
const [now, setNow] = createSignal(Date.now());

/** The current time, as a tracked read. Re-evaluates on each tick, and ONLY on each tick. */
export function nowMs(): number {
  return now();
}

let timer: ReturnType<typeof setInterval> | undefined;
/**
 * How many components are currently showing a readout.
 *
 * Refcounted because more than one may be mounted (a running bash row AND the shells panel), and the first one to unmount must
 * not stop the clock for the others — a plain "start returns its stopper" would do exactly that.
 */
let users = 0;

/** Start (or keep) the clock for one user. The returned stopper releases only this user. */
export function startClock(intervalMs = 500): () => void {
  users++;
  if (!timer) {
    setNow(Date.now());
    timer = setInterval(() => setNow(Date.now()), intervalMs);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users = Math.max(0, users - 1);
    if (users === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Is the clock running? Used by the app to start it only where a readout exists. */
export function clockRunning(): boolean {
  return timer !== undefined;
}
