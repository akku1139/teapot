/**
 * Which appearance slot a theme selection belongs in.
 *
 * #theme-slots: under "follow the system" the painter reads `sysDarkTheme()`/`sysLightTheme()`, so
 * anything that wrote the FIXED slot (`teapot.theme`) changed a value nothing read. The visible
 * symptom was a theme that highlighted but did not paint, reported as "follow the system を入れてる
 * ときにテーマ複製したりするとやっぱりちょっと変な挙動になる" — and because the control responded,
 * it read as a logic error rather than as a no-op.
 *
 * Pure and dependency-free so it is unit-testable under `node --test`; `App.tsx` has three call
 * sites (a card click, the editor's select, and "duplicate current") and all three must agree.
 */

export type AppearanceMode = "dark" | "light";

export interface SlotTarget {
  /** which store to write */
  slot: "fixed" | "dark" | "light";
  /** the localStorage key that belongs to that store */
  key: string;
}

/**
 * The slot a theme of `mode` goes into.
 *
 * Following the system there are two slots and a selection fills the one for ITS OWN appearance:
 * picking a dark theme populates the dark slot whether or not the OS is currently dark, which is
 * what makes "choose a theme for the other appearance" possible at all. Not following it there is
 * one slot, and it is the fixed one.
 */
export function slotForSelection(auto: boolean, mode: AppearanceMode): SlotTarget {
  if (!auto) return { slot: "fixed", key: "teapot.theme" };
  return mode === "dark"
    ? { slot: "dark", key: "teapot.theme.dark" }
    : { slot: "light", key: "teapot.theme.light" };
}

/**
 * Which theme id is PAINTED — the one whose card must read as selected.
 *
 * The card grid used to key its `on` class off the fixed slot, so under "follow the system" it
 * marked a theme that was not on screen and left the real one unmarked. That is the second half of
 * the same complaint: the panel said one thing and the picture said another.
 */
export function paintedIdFor(state: {
  auto: boolean;
  fixed: string;
  dark: string;
  light: string;
  prefersLight: boolean;
}): string {
  if (!state.auto) return state.fixed;
  return state.prefersLight ? state.light : state.dark;
}
