import { For, Show, createSignal, onCleanup } from "solid-js";
import { renderMarkdownCached } from "../lib/markdown";
import { previewLayers, veilColour, backgroundImageValue } from "../lib/theme-preview";
import type { ThemePalette } from "../lib/theme-store";

export function TodoEditor(props: {

  draft: string;
  preview: boolean;
  onDraft: (text: string) => void;
}) {
  const stored = Number(localStorage.getItem("teapot.todoH") ?? "");
  const [todoHeight, setTodoHeight] = createSignal<number>(
    Number.isFinite(stored) && stored > 0 ? stored : 0,
  );
  const heightStyle = () => (todoHeight() > 0 ? { height: `${todoHeight()}px` } : undefined);
  const trackHeight = (el: HTMLElement) => {
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h <= 0) return;
      setTodoHeight((cur) => {
        if (Math.abs(cur - h) < 1) return cur; 
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
        <textarea
          id="todo-input"
          class="mono todopane-edit"
          rows={5}
          style={heightStyle()}
          ref={trackHeight}
          placeholder={"- [ ] task one\n- [ ] task two"}
          value={props.draft}
          oninput={(e) => props.onDraft(e.currentTarget.value)}
          title="shared with the agent \u2014 it may check items off via set_todo; your unsaved edits win until you save"
        />
      }
    >
      {}
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
        {}
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
  backgroundImage?: string;
  surfaceAlpha?: number;
  backgroundDim?: number;
}) {
  const p = () => props.palette;
  const layers = () => previewLayers(props.surfaceAlpha, props.backgroundDim);
  return (
    <span class="tprev" style={{ background: p().bgDark }}>
      <Show when={props.backgroundImage}>
        <span class="tprev-bg" style={{ "background-image": backgroundImageValue(props.backgroundImage) }} />
        {}
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
      {}
      <span class="tprev-line" style={{ left: "32%", top: "38%", width: "34%", background: p().fg, opacity: 0.85 }} />
      <span class="tprev-line" style={{ left: "32%", top: "50%", width: "22%", background: p().acc }} />
      <span class="tprev-line" style={{ left: "32%", top: "62%", width: "40%", background: p().dim }} />
      {}
      <span class="tprev-dot" style={{ left: "6%", top: "20%", background: p().acc }} />
      <span class="tprev-dot" style={{ left: "6%", top: "40%", background: p().dim }} />
      <span class="tprev-dot" style={{ left: "6%", top: "60%", background: p().ok }} />
      <span class="tprev-dot" style={{ left: "70%", top: "12%", background: p().warn }} />
      <span class="tprev-dot" style={{ left: "84%", top: "12%", background: p().err }} />
    </span>
  );
}
