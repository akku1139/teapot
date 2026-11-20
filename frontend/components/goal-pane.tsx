import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { renderMarkdownCached } from "../lib/markdown";
import { composerValueChanged, shouldWriteComposerValue } from "../lib/composer-ime";

/**
 * The goal editor, in the SAME shape as the ✅ tasks pane: one box that toggles between a rendered view and its markdown,
 * plus a footer with [👁/✎] [notify agent] [✓ save].
 *
 * Reported on the first attempt (#206): "tasks と同じ編集構造にする", "verification contract どこ行った?", "auto-continue って
 * ちゃんと書く (autoだけじゃわからない)". So:
 *
 *  - preview mode shows BOTH the goal and its verification contract (the contract used to disappear because it only had a
 *    card in the old always-open form);
 *  - edit mode is the two textareas, nothing else;
 *  - the toggle is the same ✎/👁 icon button the tasks pane uses, in the same footer position.
 */
export function GoalEditor(props: {
  goal: string;
  verify: string;
  preview: boolean;
  onGoal: (v: string) => void;
  onVerify: (v: string) => void;
}) {
  /**
   * The same resizable box the tasks pane has, remembered under its own key.
   *
   * Reported: "goalの表示欄がリサイズできない (tasksがうまく出来てるのに)" — `.todopane` gets `resize: vertical` plus a
   * ResizeObserver that stores the height in localStorage, and the goal pane had neither, so its box was fixed.
   */
  const stored = Number(localStorage.getItem("teapot.goalH") ?? "");
  const [goalHeight, setGoalHeight] = createSignal<number>(Number.isFinite(stored) && stored > 0 ? stored : 0);
  const heightStyle = () => (goalHeight() > 0 ? { height: `${goalHeight()}px` } : undefined);
  /**
   * The verification contract gets the same resize handle, under its own key (#210: "verification contractがリサイズできない").
   * It is a separate box because the two are read for different reasons — the goal says what to do, the contract says how it will
   * be judged — and the operator sizes them independently.
   */
  const storedVerify = Number(localStorage.getItem("teapot.verifyH") ?? "");
  const [verifyHeight, setVerifyHeight] = createSignal<number>(Number.isFinite(storedVerify) && storedVerify > 0 ? storedVerify : 0);
  const verifyStyle = () => (verifyHeight() > 0 ? { height: `${verifyHeight()}px` } : undefined);
  const trackVerify = (el: HTMLElement) => {
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h <= 0) return;
      setVerifyHeight((cur) => {
        if (Math.abs(cur - h) < 1) return cur;
        localStorage.setItem("teapot.verifyH", String(h));
        return h;
      });
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };
  const trackHeight = (el: HTMLElement) => {
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h <= 0) return;
      setGoalHeight((cur) => {
        if (Math.abs(cur - h) < 1) return cur;
        localStorage.setItem("teapot.goalH", String(h));
        return h;
      });
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };
  /**
   * The textareas are UNCONTROLLED on purpose: a `value={…}` binding rewrites the node on every signal change,
   * which moves the caret to the end mid-sentence and ends an in-flight IME composition. The DOM is the source
   * of truth while typing; the signal is only written back when it genuinely diverges (an external update).
   */
  let imeInProgress = false;
  let goalEl: HTMLTextAreaElement | undefined;
  let verifyEl: HTMLTextAreaElement | undefined;
  const trackGoalInput = (el: HTMLTextAreaElement) => {
    goalEl = el;
    el.value = props.goal;
    trackHeight(el);
  };
  const trackVerifyInput = (el: HTMLTextAreaElement) => {
    verifyEl = el;
    el.value = props.verify;
  };
  createEffect(() => {
    const v = props.goal;
    const el = goalEl;
    if (el?.isConnected && shouldWriteComposerValue(imeInProgress) && composerValueChanged(el.value, v)) {
      el.value = v;
    }
  });
  createEffect(() => {
    const v = props.verify;
    const el = verifyEl;
    if (el?.isConnected && shouldWriteComposerValue(imeInProgress) && composerValueChanged(el.value, v)) {
      el.value = v;
    }
  });
  return (
    <Show
      when={!props.preview}
      fallback={
        <div class="goalpane">
          <Show
            when={props.goal.trim()}
            fallback={<div class="card muted">no goal yet — press ✎ to write one</div>}
          >
            <div class="content mdpreview goalbox" style={heightStyle()} ref={trackHeight} innerHTML={renderMarkdownCached(props.goal)} />
          </Show>
          <Show when={props.verify.trim()}>
            <div class="card goalverify" style={verifyStyle()} ref={trackVerify}>
              <div class="goalverify-head">🔍️ verification contract</div>
              <div class="content" innerHTML={renderMarkdownCached(props.verify)} />
            </div>
          </Show>
        </div>
      }
    >
      <div class="goalpane">
        <textarea
          id="goal-input"
          class="mono todopane-edit goalbox"
          rows={3}
          style={heightStyle()}
          ref={trackGoalInput}
          placeholder="set a goal…"
          title="what the agent should work toward — it reads this with get_goal()"
          onCompositionStart={() => {
            imeInProgress = true;
          }}
          onCompositionEnd={() => {
            imeInProgress = false;
          }}
          onInput={(e) => props.onGoal(e.currentTarget.value)}
        />
        <textarea
          id="goal-verify-input"
          class="mono todopane-edit"
          rows={2}
          placeholder="verification contract (optional) — e.g. 'npm test passes; endpoint documented'. finish(goalComplete=true) is then audited against this."
          title="an independent reviewer checks finish(goalComplete=true) against these requirements"
          ref={trackVerifyInput}
          onCompositionStart={() => {
            imeInProgress = true;
          }}
          onCompositionEnd={() => {
            imeInProgress = false;
          }}
          onInput={(e) => props.onVerify(e.currentTarget.value)}
        />
      </div>
    </Show>
  );
}
