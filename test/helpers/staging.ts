/**
 * A staging textarea for the clipboard legacy path, without a DOM.
 *
 * `copyText` appends a real `<textarea>` to `document.body`, which does not
 * exist under `node --test`, so the default factory throws and every legacy-path
 * test would report "failed" for the wrong reason. Injecting this keeps those
 * tests about the DECISION (which path is taken) rather than about the absence
 * of a browser.
 */
import type { StagingTextarea } from "../../frontend/clipboard.ts";

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
