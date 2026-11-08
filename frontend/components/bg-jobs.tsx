import { For, Show } from "solid-js";
import { fmtDur } from "../lib/format";
import { oneLine } from "../lib/timeline-row";

/**
 * The background-shells panel, anchored to the timeline header.
 *
 * It used to be inline JSX inside `App.tsx`, and the CSS anchored it to `.channel` (the nearest positioned ancestor)
 * instead of the header: `top: calc(100% + 6px)` therefore measured from the BOTTOM OF THE WHOLE CHANNEL, so the panel
 * opened somewhere far below the viewport — reported as "謎の場所に生成された background shells パネル". Because it is
 * absolutely positioned inside a flex row, the stray box also pushed the layout around ("タイムラインのボックスごと
 * 持ち上げる"). The header is `position: relative` now and this is a component, so the anchor and the markup are one thing
 * instead of a rule in a stylesheet that nothing in the component refers to.
 */
export type BgJob = {
  id: string;
  cmd: string;
  running: boolean;
  detached: boolean;
  pid?: number | null;
  code?: number | null;
  startedAt: number;
  truncated?: boolean;
  tail: string;
};

export function BgJobsPanel(props: {
  open: boolean;
  jobs: readonly BgJob[];
  onClose: () => void;
  onKill: (job: BgJob) => void | Promise<void>;
}) {
  return (
    <Show when={props.open}>
      <div class="bgjobs-pop" role="dialog" aria-label="background shells">
        <div class="bgjobs-head">
          <span>background shells</span>
          <button type="button" class="iconbtn" title="close" onclick={() => props.onClose()}>✕</button>
        </div>
        <Show
          when={props.jobs.length > 0}
          fallback={<div class="muted bgjobs-empty">no background jobs for this agent</div>}
        >
          <For each={props.jobs}>
            {(j) => (
              <div class="bgjob">
                <div class="bgjob-line">
                  <span class={"bgjob-dot " + (j.running ? "running" : "done")} title={j.running ? "running" : "finished"} />
                  <code class="mono bgjob-cmd" title={j.cmd}>{oneLine(j.cmd, 80)}</code>
                  <span class="muted bgjob-meta">
                    {j.detached
                      ? `detached · pid ${j.pid ?? "?"}`
                      : j.running
                        ? fmtDur(Date.now() - j.startedAt)
                        : `exit ${j.code ?? "?"}`}
                    {j.truncated ? " · truncated" : ""}
                  </span>
                  <button
                    type="button"
                    class="bgjob-kill"
                    title={
                      j.detached
                        ? `this job survived a harness restart (pid ${j.pid ?? "?"}) — its output can no longer be read here; stop it yourself if needed`
                        : j.running
                          ? "kill this job (whole process group)"
                          : "forget this finished job"
                    }
                    onclick={() => void props.onKill(j)}
                  >{j.detached ? "forget" : j.running ? "kill" : "clear"}</button>
                </div>
                <Show
                  when={j.tail.trim()}
                  fallback={
                    <Show when={j.detached}>
                      <div class="muted bgjob-detached">
                        this job outlived a harness restart, so its output is no longer captured here. it is still
                        running as pid {j.pid ?? "?"} — read its own log, or stop it yourself.
                      </div>
                    </Show>
                  }
                >
                  <pre class="mono bgjob-tail">{j.tail}</pre>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </Show>
  );
}
