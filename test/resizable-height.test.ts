import assert from "node:assert/strict";
import test from "node:test";
import { shouldStoreHeight } from "../frontend/lib/resizable-height.ts";

test("a re-mount measurement does not overwrite the operator's height", () => {
  /**
   * "goalの表示欄が、set goalをしたときに元の高さが尊重されずに…デフォルトの高さになる場合がある".
   *
   * The box mounts, the browser gives it its content height (120), and the stored height is 300. That measurement is
   * not a resize: persisting it would replace the operator's choice with the default, permanently.
   */
  assert.equal(shouldStoreHeight(120, 300, false), false, "a mount measurement must not overwrite the stored height");
  assert.equal(shouldStoreHeight(120, 300, true), true, "after a real drag, the new height IS stored");
  assert.equal(shouldStoreHeight(300, 300, true), false, "no change, nothing to store");
  assert.equal(shouldStoreHeight(0, 300, true), false, "a hidden box measures 0 — never store that");
  assert.equal(shouldStoreHeight(Number.NaN, 300, true), false);
  assert.equal(shouldStoreHeight(340, 300, true), true);
  // the first ever measurement: nothing stored yet
  assert.equal(shouldStoreHeight(120, 0, true), true);
});
