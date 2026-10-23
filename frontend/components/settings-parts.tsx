import { For, Show, createSignal, onCleanup } from "solid-js";
import { renderMarkdownCached } from "../lib/markdown";
import { previewLayers, veilColour, backgroundImageValue } from "../lib/theme-preview";
import type { ThemePalette } from "../lib/theme-store";


export function TodoEditor(props: {

  draft: string;
  preview: boolean;
  onDraft: (text: string) => void;
}) {
  // #88: these two branches were INVERTED — `<Show when={…}>` rendered the TEXTAREA
  // and the checklist was the `fallback`, so `true` meant "editor". `saveTodo` set
  // `true` to reach the preview and therefore did the opposite.
  //
  // The prop is named `preview`, not `viewMode`, because there is an unrelated
  // `viewMode` signal in this file (the file-viewer's code/md/media mode) and the
  // two were being confused. The branches are also swapped, so the name states what
  // actually renders.
  //
  // HEIGHT IS SHARED BY THE TWO VIEWS. The textarea is natively resizable
  // (`resize: vertical`), so the browser applies the drag as an INLINE height on that
  // one element — and the preview is a DIFFERENT element, which fell back to the
  // stylesheet's `11.5em`. Dragging the editor therefore lost its height the moment you
  // switched to the checklist. Observed with a ResizeObserver and applied to both, so a
  // drag survives the toggle; persisted so it also survives a reload.
  const stored = Number(localStorage.getItem("teapot.todoH") ?? "");
  const [todoHeight, setTodoHeight] = createSignal<number>(
    Number.isFinite(stored) && stored > 0 ? stored : 0,
  );
  const heightStyle = () => (todoHeight() > 0 ? { height: `${todoHeight()}px` } : undefined);
  /**
   * Track a height the user produced by dragging.
   *
   * A ResizeObserver rather than `onpointerup`: the native resize handle does not have to
   * involve a pointer event this listener sees (a touch drag, a keyboard/assistive
   * resize), and the observer reports the real box either way. It is armed per element, so
   * whichever view is mounted feeds the same signal.
   */
  const trackHeight = (el: HTMLElement) => {
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h <= 0) return;
      setTodoHeight((cur) => {
        if (Math.abs(cur - h) < 1) return cur; // no churn from sub-pixel reflow
        localStorage.setItem("teapot.todoH", String(h));
        return h;
      });
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };

  return (
    <Show
      when={props.preview}
      fallback={
        /* the markdown editor — the default view */
        <textarea
          id="todo-input"
          class="mono todopane-edit"
          rows={5}
          style={heightStyle()}
          ref={trackHeight}
          placeholder={"- task one\n- task two"}
          value={props.draft}
          oninput={(e) => props.onDraft(e.currentTarget.value)}
          title="shared with the agent \u2014 it may check items off via set_todo; your unsaved edits win until you save"
        />
      }
    >
      {/* rendered checklist; #124: both views take their height from `.todopane`,
          so they cannot drift again — plus the shared dragged height above */}
      <div
        class="content mdpreview todopane"
        style={heightStyle()}
        ref={trackHeight}
        innerHTML={renderMarkdownCached(props.draft)}
      />
    </Show>
  );
}

export function CodePreview(props: { path: string; content: string; html: string; pending: boolean; truncated: boolean }) {
  return (
    <>
      <Show
        when={props.html}
        fallback={
          props.pending ? (
            <div class="muted" style="padding:8px;font-size:12px">
              ✨ highlighting {props.path.split("/").pop()}…
            </div>
          ) : (
            <pre class="mono" style="max-height:62vh;overflow:auto;white-space:pre-wrap;margin:0">
              {props.content}
            </pre>
          )
        }
      >
        {/* shiki emits its own <pre class="shiki"><code>…</code></pre>; content is shiki-generated HTML */}
        <div class="filepreview" innerHTML={props.html} />
      </Show>
      <Show when={props.truncated}>
        <div class="muted" style="padding-top:6px;font-size:11.5px">… truncated (first 100 KB)</div>
      </Show>
    </>
  );
}

export function NumberField(props: {
  label: string;
  value: number;
  onValue: (v: number) => void;
  hint?: string;
}) {
  return (
    <label title={props.hint}>
      {props.label}
      <input
        type="number"
        min="0"
        value={props.value}
        oninput={(e) => props.onValue(Number(e.currentTarget.value))}
      />
    </label>
  );
}

export function ThemePreview(props: {
  palette: ThemePalette;
  /**
   * A custom theme may carry a background image, and a preview that omits it shows a flat palette
   * the operator never sees in the app — two themes that differ only by wallpaper previewed
   * identically. Asked for as "テーマカードに背景画像(透過設定付きで)も出すようになると嬉しい".
   *
   * Drawn as its OWN layer under the palette layers rather than as the root's `background`, so the
   * simulated nav/head/panel keep their colours: the point is to preview the composition, not the
   * photo alone.
   */
  backgroundImage?: string;
  /** the operator's surface-opacity slider for this theme */
  surfaceAlpha?: number;
  /** how much the wallpaper is veiled; the app tints toward the theme's surface, never black */
  backgroundDim?: number;
}) {
  const p = () => props.palette;
  const layers = () => previewLayers(props.surfaceAlpha, props.backgroundDim);
  return (
    <span class="tprev" style={{ background: p().bgDark }}>
      <Show when={props.backgroundImage}>
        <span class="tprev-bg" style={{ "background-image": backgroundImageValue(props.backgroundImage) }} />
        {/**
          * The VEIL is a separate layer, exactly as `.bgphoto-veil` is in the app.
          *
          * It has to sit between the photo and the panels: painting it as the photo's own
          * background would put it UNDER the image (a background never covers its content), and
          * mixing the dim INTO the panel colour would dim twice — once for the veil the app
          * applies and once for the surface opacity, which is the double-counting the operator
          * warned about ("下側の背景透過と重複しないように").
          */}
        <span
          class="tprev-veil"
          style={{ background: veilColour(p().bgDark, layers().dim) }}
        />
      </Show>
      <span
        class="tprev-nav"
        style={{ background: p().bgDarkest, opacity: props.backgroundImage ? String(layers().panel) : "1" }}
      />
      <span
        class="tprev-head"
        style={{ background: p().bgDarkest, opacity: props.backgroundImage ? String(layers().panel) : "1" }}
      />
      <span
        class="tprev-panel"
        style={{ background: p().bgMid, opacity: props.backgroundImage ? String(layers().raised) : "1" }}
      />
      {/* text lines: two "words" then a shorter one, so it reads as prose */}
      <span class="tprev-line" style={{ left: "32%", top: "38%", width: "34%", background: p().fg, opacity: 0.85 }} />
      <span class="tprev-line" style={{ left: "32%", top: "50%", width: "22%", background: p().acc }} />
      <span class="tprev-line" style={{ left: "32%", top: "62%", width: "40%", background: p().dim }} />
      {/* the accent and status dots: what tells two dark themes apart at a glance */}
      <span class="tprev-dot" style={{ left: "6%", top: "20%", background: p().acc }} />
      <span class="tprev-dot" style={{ left: "6%", top: "40%", background: p().dim }} />
      <span class="tprev-dot" style={{ left: "6%", top: "60%", background: p().ok }} />
      <span class="tprev-dot" style={{ left: "70%", top: "12%", background: p().warn }} />
      <span class="tprev-dot" style={{ left: "84%", top: "12%", background: p().err }} />
    </span>
  );
}
