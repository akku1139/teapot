import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { relTime, truncate } from "../lib/format";

/**
 * The notifications panel — `as` the header's actions, so this component owns the LAYOUT and the caller owns the POLICY.
 *
 * It used to be inline JSX inside `App.tsx`, like every other floating panel, and the "clear all" button was written into the
 * header here: `showNotifs() && notifs().length > 0` had to be true for the header to have anything on the right, so markup and
 * condition lived in two files' worth of one function and neither could be read alone. The header's right side is a SLOT
 * (`actions`) now — the panel never decides which buttons exist, and cannot grow a second "clear all" beside the caller's.
 *
 * The BACKDROP is part of the component with the panel: they are one appearance, and separating them is how one of them ends up
 * rendered without the other.
 */
export type Notif = {
  id: string;
  agentId: string;
  kind: "progress" | "finish" | "question" | "error";
  title: string;
  body: string;
  at: number;
  read: boolean;
  eventId?: string | undefined;
};

const ICON: Record<Notif["kind"], string> = {
  finish: "✅",
  question: "❓️",
  error: "⚠️",
  progress: "📈",
};

export function NotifPanel(props: {
  open: boolean;
  notifs: readonly Notif[];
  /** the header's right-hand side, supplied by the app — e.g. `clear all`, rendered only when there is something to clear */
  actions?: JSX.Element;
  emptyHint?: string;
  onClose: () => void;
  /** the caller decides what selecting DOES: mark read, follow the agent, jump to the row */
  onSelect: (n: Notif) => void;
  onMarkRead: (n: Notif) => void;
}) {
  return (
    <Show when={props.open}>
      <div class="notifbackdrop" onClick={() => props.onClose()} />
      <div class="notifpanel">
        <div class="notifhead">
          notifications
          <span class="notifactions">
            {props.actions}
            <button class="iconbtn" title="close notifications" onClick={() => props.onClose()}>✕</button>
          </span>
        </div>
        <Show
          when={props.notifs.length > 0}
          fallback={
            <div class="muted notifempty">
              {props.emptyHint ?? "nothing yet — progress, finishes, questions and errors will land here"}
            </div>
          }
        >
          <div class="notiflist">
            <For each={props.notifs}>
              {(n) => (
                <div
                  class={"notifitem " + n.kind + (n.read ? " read" : "")}
                  title={`from ${n.agentId}`}
                  onClick={() => props.onSelect(n)}
                >
                  <div class="nhead">
                    <span class="nicon">{ICON[n.kind] ?? ICON.progress}</span>
                    <span class="ntitle">{n.title}</span>
                    <span class="meta muted">{relTime(new Date(n.at).toISOString())}</span>
                    <button
                      class="iconbtn nreadbtn"
                      title={n.read ? "already read" : "mark as read"}
                      onClick={(e: MouseEvent) => {
                        e.stopPropagation();
                        props.onMarkRead(n);
                      }}
                    >{n.read ? "✓" : "○"}</button>
                  </div>
                  <Show when={n.body}>
                    <div class="nbody">{truncate(n.body, 160)}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
