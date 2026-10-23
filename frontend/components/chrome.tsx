import { Show, createSignal } from "solid-js";
import { copyText } from "../lib/clipboard";

export function IconBtn(props: {
  icon: string;
  title: string;
  onClick?: (e: MouseEvent) => void;
  active?: boolean;
  class?: string;
  style?: string;
}) {
  return (
    <button
      type="button"
      class={"iconbtn" + (props.active ? " active" : "") + (props.class ? " " + props.class : "")}
      title={props.title}
      onclick={props.onClick}
      style={props.style}
    >
      <span class="iconbtn-glyph">{props.icon}</span>
    </button>
  );
}

export function CopyBtn(props: { text: string; label?: string; title?: string }) {
  const [done, setDone] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const copy = (e: MouseEvent) => {
    e.preventDefault(); // <summary> buttons must not toggle the details row
    e.stopPropagation();
    void copyText(props.text ?? "").then((result) => {
      if (result === "unsupported" || result === "failed") {
        setFailed(true); // nothing copied — say so instead of a silent no-op
        setTimeout(() => setFailed(false), 1200);
        return;
      }
      setDone(true);
      setTimeout(() => setDone(false), 900);
    });
  };
  return (
    <button
      class="copybtn"
      title={props.title ?? "copy to clipboard"}
      onclick={copy}
    >{done() ? "✓" : failed() ? "✗" : props.label ?? "⧉"}</button>
  );
}

export function Modal(props: { title: string; onClose: () => void; children: any }) {
  return (
    <div class="overlay" onclick={(e: Event) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal">
        <div class="modal-head">
          <b>{props.title}</b>
          <button class="iconbtn" onclick={props.onClose}>✕</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}
