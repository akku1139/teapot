import type { StagingTextarea } from "../../frontend/lib/clipboard.ts";

export function fakeStaging(): StagingTextarea & { removed: number; selected: number } {
  const el = {
    value: "",
    style: { position: "", opacity: "" },
    selected: 0,
    removed: 0,
    select() {
      el.selected++;
    },
    remove() {
      el.removed++;
    },
  };
  return el;
}
