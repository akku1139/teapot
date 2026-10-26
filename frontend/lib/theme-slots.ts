
export type AppearanceMode = "dark" | "light";

export interface SlotTarget {
  slot: "fixed" | "dark" | "light";
  key: string;
}

export function slotForSelection(auto: boolean, mode: AppearanceMode): SlotTarget {
  if (!auto) return { slot: "fixed", key: "teapot.theme" };
  return mode === "dark"
    ? { slot: "dark", key: "teapot.theme.dark" }
    : { slot: "light", key: "teapot.theme.light" };
}

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
