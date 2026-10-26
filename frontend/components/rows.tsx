import { For, Show, createMemo, createSignal } from "solid-js";
import { AnsiText, BashElapsed, HighlightedCode } from "./code";
import { Card } from "./card";
import { CopyBtn, IconBtn } from "./chrome";
import { api } from "../lib/api";
import { flashHint } from "../lib/flash";
import { hasAnsi, stripAnsi } from "../lib/ansi";
import { fmtDur, truncate } from "../lib/format";
import { goalLine } from "../lib/goal-timeline";
import { toneOf } from "../lib/timeline-row";
import { renderMarkdown } from "../md";
import { renderMarkdownCached } from "../lib/markdown";
import { groupedWith, type RowLike } from "../lib/row-grouping";
import { outcomeMarker, shellHint, shellOutcome } from "../lib/shell-outcome";
import { authorOf, fmtK, fmtTs, oneLine, rawOf, type Ev } from "../lib/timeline-row";
import { formatToolOutput, outputLang } from "../lib/tool-output-lang";
import { effectiveBashTimeout } from "../lib/bash-timeout";

export function FreeTextAnswer(props: { answered: boolean; onOption?: (t: string) => void }) {
  const [val, setVal] = createSignal("");
  const submit = () => {
    const t = val().trim();
    if (!t || props.answered) return;
    setVal("");
    props.onOption?.(t);
  };
  return (
    <div class="qfree">
      <input
        type="text"
        placeholder={props.answered ? "answered" : "or type your own answer…"}
        disabled={props.answered}
        value={val()}
        oninput={(e) => setVal(e.currentTarget.value)}
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); }
        }}
      />
      <button disabled={props.answered || !val().trim()} onclick={submit}>reply</button>
    </div>
  );
}

export function ToolRow(props: { e: Ev; prev?: Ev; res?: () => Ev | undefined; orphan?: boolean; agentActive?: boolean; onResize?: () => void }) {
  const e = props.e;
  const grouped = groupedWith(props.prev as RowLike | undefined, e as RowLike);
  const resEv = createMemo(() => props.res?.(), undefined, {
    equals: (a, b) => a?.id === b?.id,
  });
  const res = () => resEv();

  const staleDone = () => !props.agentActive && !res();
  const d = e.data ?? {};
  const name = String(d.name ?? "tool");
  const out = () => String(res()?.data?.result ?? "");

  const argStr = (k: string) => String(d.args?.[k] ?? "");
  const cmdText = () => {
    if (name === "bash") return argStr("command");
    return argStr("path") || JSON.stringify(d.args ?? {}, null, 1);
  };
  const effTimeout = () => {
    if (name === "bash") return effectiveBashTimeout(argStr("timeout_ms"));
    if (name === "wait_children") return Number(argStr("timeout_ms")) || 300_000;
    return Number(argStr("timeout_ms")) || undefined;
  };
  /**
   * A tool's ARGUMENT text, in FULL — same rule as its output.
   *
   * It used to truncate at 1500 chars, so `write_file`'s content was cut with `…` while `bash` and
   * `edit_file` showed everything. The operator's reason for the difference being wrong is that the
   * row is ALREADY a `<details>`: opening the card is the request to see it, and `.toolbody` scrolls
   * vertically for a tall one. A second limit inside an explicit open discards what was just asked
   * for, and a `write_file` is exactly the case where the whole content is the thing under review.
   */
  const codeBlock = (text: string, _max?: number, lang?: string) => (
    <HighlightedCode text={text} lang={lang} />
  );
  /** the ARGUMENT block: same surface as the output, and JSON-highlighted when it is an object */
  const argsBlock = () => <HighlightedCode text={JSON.stringify(d.args ?? {}, null, 1)} lang="json" />;
  /**
   * The tool's output, in FULL.
   *
   * Not truncated, and not folded either: a tool row is ALREADY a `<details>`, so the operator
   * opens the card deliberately — a second fold behind the first is another gate, and a character
   * budget discards what they just asked to see.
   *
   * Measured over 91,048 real tool results: median 293 chars, p90 2,364, p99 8,000, max 8,000 —
   * the server caps a result at 8,000, so "show it all" is bounded and cheap. `.toolbody` keeps its
   * own max-height with a scrollbar for the rare tall one.
   */
  const resultBlock = () =>
    (() => {
      const r = res();
      return r ? (
      <>
        {hasAnsi(out()) ? (
          <AnsiText text={out()} />
        ) : (
          <HighlightedCode text={formatToolOutput(out())} lang={outputLang(out())} />
        )}
        <div class="meta">
          {fmtDur(r.data?.durationMs)}
          {}
          {name === "bash"
            ? outcomeMarker(shellOutcome(r.data?.ok, String(r.data?.result ?? "")))
            : r.data?.ok === false
              ? " · FAILED"
              : ""}
          {}
          <CopyBtn text={hasAnsi(out()) ? stripAnsi(out()) : formatToolOutput(out())} />
        </div>
      </>
    ) : (
      <div class="meta">waiting for output…</div>
    );
    })();

  // this whole derivation depends on the result, so it must be a MEMO. It used to
  // run once in the component body, which is why a row created before its result
  // arrived kept the pre-result label and body for good: only the class (re-read
  // from the prop) changed. See the note on `res` above.
  /**
   * The per-tool summary AND its body, built once per RESULT.
   *
   * `body` is a JSX value, so every re-run of this memo builds a NEW element tree — and a
   * `<pre>` replaced that way loses its scroll offset even when the row element itself is
   * reused. MEASURED: a scrolled bash-output block reset whenever an unrelated message
   * arrived, with `ownerWasReused=true`.
   *
   * Two things were needed:
   *
   *  1. read `res()` through a local so the memo's dependencies are explicit;
   *  2. give `createMemo` an `equals` that compares the RESULT ID. Without it the memo's
   *     return value is a fresh `{label, hint, body}` object every run, which never equals
   *     the previous one, so Solid re-rendered the body on every `pairInfo()` recompute —
   *     and `pairInfo()` recomputes on every append, because its `resFor` Map is new even
   *     when the `Ev` inside it is the same object.
   *
   * With the `equals`, the only re-run left is a result that actually changed, which is
   * exactly when the body must be rebuilt.
   */
  const derived = createMemo(
    () => {
  const r = res();
  void r;
  let label = name;
  let hint: string | null = "";
  let body: any = argsBlock();
  try {
    switch (name) {
      case "bash": {
        const cmd = argStr("command");
        const isBg = d.args?.background === true;
        const bgJob = isBg ? (String(out()).match(/job (bg\d+)/)?.[1] ?? "") : "";
        label = (isBg ? "⏳ " : "$ ") + oneLine(cmd, 96);
        const timeoutMs = argStr("timeout_ms") ? Number(argStr("timeout_ms")) : undefined;
        const r = res();
        const outcome = shellOutcome(r?.data?.ok, r ? String(r.data?.result ?? "") : "");
        hint = r
          ? isBg
            ? `background job${bgJob ? ` ${bgJob}` : ""}${timeoutMs ? ` · timeout ${Math.round(timeoutMs / 1000)}s` : ""}`
            : shellHint({ outcome, durationMs: r.data?.durationMs, timeoutMs, fmtDur })
          : null; 
        body = (
          <>
            {isBg ? (
              <div class="meta bgjob-note">
                runs in background — poll with <b>bash_output(job_id=&quot;{bgJob || "?"}&quot;)</b>
                {bgJob ? <> · kill with <b>action="kill"</b></> : null}
              </div>
            ) : null}
            {}
            {cmd !== label.slice(isBg ? 2 : 2) ? (
              <HighlightedCode text={cmd} lang="shellscript" />
            ) : null}
            {resultBlock()}
          </>
        );
        break;
      }
      case "read_file": {
        label = argStr("path") || "(no path)";
        const bits: string[] = [];
        if (argStr("pattern")) bits.push(`grep /${oneLine(argStr("pattern"), 40)}/`);
        if (Number(d.args?.offset) < 0) bits.push(`last ${-Number(d.args.offset)} lines`);
        else if (d.args?.offset) bits.push(`from L${d.args.offset}`);
        if (d.args?.limit) bits.push(`≤${d.args.limit} lines`);
        hint = bits.join(" · ");
        body = resultBlock();
        break;
      }
      case "write_file": {
        const content = String(d.args?.content ?? "");
        label = argStr("path") || "(no path)";
        hint = `${fmtK(content.length)} bytes`;
        body = (
          <>
            {codeBlock(content)}
            {res() ? <div class="meta">{oneLine(out(), 160)}</div> : <div class="meta">writing…</div>}
          </>
        );
        break;
      }
      case "edit_file": {
        label = argStr("path") || "(no path)";
        hint = d.args?.replace_all === true ? "replace all" : "unique spot";
        body = (
          <>
            {/* full text, for the same reason the output is: the card is already an explicit open,
                and `.toolbody` scrolls. A 900-char cut hid the exact line being reviewed. */}
            <pre class="mono toolbody del">{"- " + argStr("old_text")}</pre>
            <pre class="mono toolbody add">{"+ " + argStr("new_text")}</pre>
            {res() ? (
              <div class="meta">
                {oneLine(out(), 120)} · {fmtDur(res()!.data?.durationMs)}
              </div>
            ) : (
              <div class="meta">applying…</div>
            )}
          </>
        );
        break;
      }
      case "apply_patch": {
        const patchLines = argStr("patch").split("\n").filter((l) => l && !/^---$/.test(l.trim()));
        const files = patchLines
          .map((l) => l.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)?.[1])
          .filter(Boolean) as string[];
        label = files.length ? `${files.length} file${files.length > 1 ? "s" : ""}: ${oneLine(files.join(", "), 80)}` : "patch";
        /**
         * Every line, with no per-line cut.
         *
         * This capped the body at 60 lines and each line at 240 chars, so a patch that touched several
         * files showed its beginning and then an elision note — the operator reviewing a patch is
         * exactly who needs the rest, and `.toolbody.patch` already scrolls.
         */
        body = (
          <>
            <pre class="mono toolbody patch">
              {patchLines.map((l) => {
                const cls = l.startsWith("+") ? " add" : l.startsWith("-") ? " del" : /^\*\*\*|^@@/.test(l) ? " meta" : "";
                return <div class={"pline" + cls}>{l}</div>;
              })}
            </pre>
            {res() ? <div class="meta">{oneLine(out().split("\n")[0] ?? "", 140)}{res()!.data?.ok === false ? " · FAILED" : ""}</div> : <div class="meta">validating…</div>}
          </>
        );
        break;
      }
      case "list_dir": {
        label = argStr("path") || ".";
        body = resultBlock();
        break;
      }
      case "read_url": {
        let host = argStr("url");
        try { const u = new URL(host); host = u.host + u.pathname; } catch {  }
        label = oneLine(host, 70);
        hint = "web";
        body = (
          <>
            <div class="meta">
              <Show
                when={/^https?:/i.test(argStr("url"))}
                fallback={<span class="muted">{oneLine(argStr("url"), 80)}</span>}
              >
                <a href={argStr("url")} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">open ↗</a>
              </Show>
            </div>
            {resultBlock()}
          </>
        );
        break;
      }
      case "bash_output": {
        const action = argStr("action") || "read";
        const jobId = argStr("job_id") || "(?)";
        label = `bash_output ${jobId}`;
        hint = action;
        body = resultBlock();
        break;
      }
      case "load_skill": {
        label = `skill: ${argStr("name")}`;
        const mdBody = out().replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""); 
        body = res() ? (
          <>
            <div class="content" innerHTML={renderMarkdown(mdBody)} />
            <div class="meta">{fmtDur(res()!.data?.durationMs)}</div>
          </>
        ) : (
          <div class="meta">loading…</div>
        );
        break;
      }
      case "save_skill": {
        label = `skill: ${argStr("name")}`;
        hint = oneLine(argStr("description"), 60);
        const files = Array.isArray(d.args?.files) ? d.args.files.map((f: any) => f?.name).filter(Boolean) : [];
        body = (
          <>
            {files.length ? <div class="meta">bundled: {files.join(", ")}</div> : null}
            {res() ? <div class="meta">{oneLine(out(), 160)} · {fmtDur(res()!.data?.durationMs)}</div> : <div class="meta">saving…</div>}
          </>
);
        break;
      }
      default: {
        label = name;
        hint = res() ? fmtDur(res()!.data?.durationMs) : null;
        body = (
          <>
            {argsBlock()}
            {resultBlock()}
          </>
        );
        break;
      }
    }
  } catch {
  }
    // `key` is what the memo's `equals` compares: the RESULT's identity plus the label. Two
    // runs that would build the same body must produce the same key, or the `<pre>` inside is
    // discarded and its scroll offset with it.
    return { label, hint, body, key: `${res()?.id ?? "none"}|${label}|${hint ?? ""}` };
    },
    undefined,
    {
      equals: (a, b) => (a as { key?: string }).key === (b as { key?: string }).key,
    },
  );

  return (
    <details
      class={"embed" + (grouped ? " grouped" : "") + (res() ? (res()!.data?.ok === false ? " fail" : " done") : staleDone() ? " done" : " running")}
      title={`${name}${derived().hint ? " — " + derived().hint : ""}`}
      onToggle={(ev: ToggleEvent) => {
        if ((ev.target as HTMLDetailsElement).open) props.onResize?.();
      }}
    >
      <summary>
        {}
        <b>{derived().label}</b>
        <Show when={e.data?.actor}>
          <span class="actor">@{String(e.data.actor)}</span>
        </Show>
        <span class="meta">
          {res()
            ? derived().hint || ""
            : staleDone()
              ? "(result missed)"
              : name === "bash" || effTimeout()
                ? 
                  <BashElapsed startedAt={e.ts} inline timeoutMs={effTimeout()} /> // visible while folded
                : "running…"}
        </span>
        {}
        <span class="toolcopy">
          <CopyBtn text={cmdText()} label="⧉ cmd" title={`copy the ${name} arguments`} />
          <Show when={res()}>
            <CopyBtn
              text={hasAnsi(out()) ? stripAnsi(out()) : out()}
              label="⧉ out"
              title="copy this tool's full output (escapes removed)"
            />
          </Show>
        </span>
      </summary>
      {derived().body}
    </details>
  );
}

export function MessageRow(props: { e: Ev; prev?: () => Ev | undefined; next?: () => Ev | undefined; res?: () => Ev | undefined; orphan?: boolean; showBranch?: boolean; onEdit?: () => void; onCancel?: () => void; onOption?: (text: string) => void; answeredIds?: () => Set<string>; onAnswered?: (callId: string) => void; agentActive?: boolean; onResize?: () => void }) {
  const e = props.e;
  const a = authorOf(e);
  const grouped = () => groupedWith(props.prev?.() as RowLike | undefined, e as RowLike);
  const nextGrouped = () => {
    const n = props.next?.();
    return !!n && groupedWith(e as RowLike, n as RowLike);
  };

  if (e.type === "fork") {
    const d = e.data ?? {};
    return (
      <div class="divider-msg">
        ⑂ forked from {String(d.fromBranch ?? "?")} → {String(d.newBranch ?? e.branch)}
      </div>
    );
  }
  if (e.type === "goal") {
    const line = goalLine(e.data ?? {});
    return (
      <div class={"goalline " + (line.tone === "err" ? "err" : line.tone === "warn" ? "warn" : "")}>
        <div class="goalline-label">{line.label}</div>
        {}
        <Show when={line.hasCard}>
          <Card
            tone={line.tone === "ok" ? "ok" : line.tone === "warn" ? "warn" : "tool"}
            markdown={line.markdown}
            body={line.detail}
          />
        </Show>
      </div>
    );
  }
  /**
   * One step of the completion audit.
   *
   * The auditor runs in its own conversation, so without these rows the timeline showed
   * `audit-started` and then only the verdict — an audit that produced NO verdict was
   * indistinguishable from one that never ran (measured: three silent audits, then an abandonment
   * that read like a provider fault). These are the auditor's own steps, attributed to it.
   */
  if (e.type === "audit_step") {
    const st = String(e.data?.step ?? "");
    const name = String(e.data?.name ?? "");
    const label =
      st === "started"
        ? "🔍️ auditor started"
        : st === "tool"
          ? `🔍️ auditor → ${name}`
          : st === "tool_done"
            ? `🔍️ auditor ← ${name} ${e.data?.ok === false ? "failed" : `${String(e.data?.chars ?? 0)} chars`}`
            : st === "reply"
              ? "🔍️ auditor replied"
              : "🔍️ auditor";
    return (
      <details class="embed auditstep">
        <summary>
          <span class="meta">{label}</span>
          <Show when={st === "tool" && e.data?.args}>
            <span class="meta muted">{truncate(String(e.data?.args ?? ""), 120)}</span>
          </Show>
        </summary>
        <Show when={st === "reply" && e.data?.text}>
          <pre class="mono toolbody">{String(e.data?.text ?? "")}</pre>
        </Show>
        <Show when={st === "tool" && e.data?.args}>
          <pre class="mono toolbody">{String(e.data?.args ?? "")}</pre>
        </Show>
      </details>
    );
  }
  if (e.type === "todo") {
    return <div class="divider-msg">✅ tasks updated ({String(e.data?.by ?? "human")})</div>;
  }
  if (e.type === "state") {
    if (e.data.from === e.data.to) return null;
    return (
      <div class={"divider-msg" + (e.data.to === "error" ? " err" : "")}>
        {e.data.from} → {e.data.to}{e.data.reason ? ` — ${e.data.reason}` : ""}
      </div>
    );
  }
  // system_note MUST resolve here (before the .msg wrapper): the wrapper
  // always renders an avatar + empty body, so notes handled only inside
  // SwitchContent appeared as mysterious EMPTY rows on the timeline.
  // Most notes are log-only; these few earn a visible divider/embed row.
  if (e.type === "system_note") {
    const ev = String(e.data?.event ?? "");
    if (ev === "runaway-detected") {
      return (
        <div class="embed fail" title={`${e.data?.failures} consecutive tool failures hit the configured limit (${e.data?.limit})`}>
          <div class="mono">🛑 runaway: {String(e.data?.failures)} tool failures in a row (limit {String(e.data?.limit)})</div>
          <div class="meta">last: {String(e.data?.lastTool)} — {String(e.data?.lastError ?? "").slice(0, 200)}</div>
        </div>
      );
    }
    if (ev === "error-retry") {
      return (
        <div class="embed warn-embed" title="a round-fatal API error occurred; auto-retry is waiting, then a fresh round starts (onError: retry)">
          <div class="mono">↻ API error — retrying (attempt {String(e.data?.attempt)}) in {Math.round(Number(e.data?.waitMs) / 1000)}s…</div>
        </div>
      );
    }
    if (ev === "background-exit") {
      const failed = e.data?.failed === true;
      const secs = Math.round(Number(e.data?.durationMs ?? 0) / 1000);
      return (
        <div class={"divider-msg" + (failed ? " err" : "")} title={String(e.data?.cmd ?? "")}>
          {(failed ? "⚠ background job " : "✓ background job ") +
            String(e.data?.jobId ?? "?") + " " +
            (failed ? `FAILED (exit ${String(e.data?.code ?? "?")})` : `finished (${secs}s)`)}
        </div>
      );
    }
    if (ev === "context-compacted") {
      return (
        <div class="divider-msg">
          🗜 compacted: {String(e.data?.tokensBefore ?? "?")} → {String(e.data?.tokensAfter ?? "?")} tok ({String(e.data?.mode ?? "")})
        </div>
      );
    }
    // the START of the pass, logged before the (slow) summarizer runs so
    // the timeline shows the conversation being rewritten rather than going
    // quiet for the whole summarize. The completion divider above carries the
    // after-figures; this one only claims what was already known.
    if (ev === "context-compaction-started") {
      return (
        <div class="divider-msg" title="compaction is rewriting older history — the agent is not stuck">
          🗜 compacting: summarizing {String(e.data?.messages ?? "?")} earlier messages from{" "}
          {String(e.data?.tokensBefore ?? "?")} tok ({String(e.data?.reason ?? "auto")})…
        </div>
      );
    }
    return null; // log-only notes (prompt-delivered, llm-retry, …)
  }

  return (
    <div
      class={
        "msg" +
        (grouped() ? " grouped" : "") +
        (nextGrouped() ? " next-grouped" : "") +
        (e.data?.pending ? " pending" : "") +
        (e.data?.cancelled ? " withdrawn" : "")
      }
      data-eid={e.id}
    >
      {}
      {}
      <div
        class={`avatar avghost tone-${toneOf(a.color)}` + (grouped() ? " ghosted" : "")}
        title={grouped() ? `${fmtTs(e.ts)} · ${e.branch}` : undefined}
      >
        {grouped() ? "" : a.icon}
      </div>
      <div class="msg-body">
        {grouped() && <span class="grouptime" title={`${fmtTs(e.ts)} · ${e.branch}`} />}
        <Show when={!grouped()}>
          <div class="msg-head">
            <span class={`author tone-${toneOf(a.color)}`}>{a.name}</span>
            <Show when={e.data?.actor}>
              <span class="actor">@{String(e.data.actor)}</span>
            </Show>
            <span class="ts">{e.data?.pending ? "queued…" : e.data?.cancelled ? "withdrawn" : fmtTs(e.ts)}</span>
            {}
            <Show when={props.showBranch}>
              <span class="ts">{e.branch}</span>
            </Show>
            <Show when={props.onCancel}>
              <button
                class="editbtn"
                title="withdraw this message — it has not reached the model yet; the text goes back to the input box"
                onclick={(ev: MouseEvent) => { ev.stopPropagation(); props.onCancel!(); }}
              >✕ cancel</button>
            </Show>
            {}
            <Show when={e.type !== "tool_call"}>
              <CopyBtn text={rawOf(e)} label="⧉ copy" title="copy the RAW text of this message (no markdown rendering)" />
            </Show>
            <Show when={props.onEdit}>
              <button
                class="editbtn"
                title="edit this prompt — forks the conversation here (later events are dropped or summarized)"
                onclick={(ev: MouseEvent) => { ev.stopPropagation(); props.onEdit!(); }}
              >✎ edit</button>
            </Show>
          </div>
        </Show>

        <SwitchContent e={e} prev={props.prev?.()} res={props.res} orphan={props.orphan} onOption={props.onOption} answeredIds={props.answeredIds} onAnswered={props.onAnswered} agentActive={props.agentActive} onResize={props.onResize} />
      </div>
    </div>
  );
}

export function SwitchContent(props: { e: Ev; prev?: Ev; res?: () => Ev | undefined; orphan?: boolean; onOption?: (text: string) => void; answeredIds?: () => Set<string>; onAnswered?: (callId: string) => void; agentActive?: boolean; onResize?: () => void }) {
  const e = props.e;
  switch (e.type) {
    case "prompt": {
      /**
       * The log stores `{ url, name }`, not a bare URL.
       *
       * `images.map((i) => ({ url: i.url, name: i.name }))` is what `Agent.enqueuePrompt` writes, and
       * the renderer passed each entry straight to `src=` — MEASURED on a real prompt row:
       * `src="[object Object]"`, i.e. no image at all. Older entries may still be plain strings, so
       * both shapes are accepted.
       */
      const imgs: string[] = (e.data?.images ?? [])
        .map((i: unknown) => (typeof i === "string" ? i : (i as { url?: unknown })?.url))
        .filter((u: unknown): u is string => typeof u === "string" && u.length > 0);
      return (
        <>
          <div class="content" innerHTML={renderMarkdownCached(String(e.data.text ?? ""))} />
          <Show when={imgs.length}>
            <div class="promptimgs">
              <For each={imgs}>{(src) => <img src={src} class="promptimg" alt="attachment" />}</For>
            </div>
          </Show>
        </>
      );
    }
    case "message":
      return (
        <>
          <Show when={typeof e.data.reasoning === "string" && e.data.reasoning.trim()}>
            <details class="reasoning">
              {}
              <summary>💭 thinking</summary>
              <div class="mono">{String(e.data.reasoning)}</div>
            </details>
          </Show>
          <div class="content" innerHTML={renderMarkdownCached(String(e.data.content ?? ""))} />
          <Show when={e.data.interrupted}>
            <div class="interrupted">⚠ interrupted — partial output kept</div>
          </Show>
          <Show when={e.data.final}>
            <div class="msgfoot"><CopyBtn text={String(e.data.content ?? "")} /><span>copy summary</span></div>
          </Show>
        </>
      );
    case "tool_call":
      // `prev` must be FORWARDED (grouping #75): without it ToolRow cannot know it
      // continues the previous actor's run, which is what made every consecutive
      // bash row render its own icon + label.
      return <ToolRow e={e} prev={props.prev} res={props.res} orphan={props.orphan} agentActive={props.agentActive} onResize={props.onResize} />;
    case "tool_result": {
      const out = String(e.data.result ?? "");
      const name = String(e.data.name ?? "tool");
      const ok = e.data.ok !== false;
      return (
        <details class={"embed " + (ok ? "" : "fail")} open={props.orphan}>
          <summary>
            <span class="meta">
              {}
              {name === "bash" ? `$ (bash, call evicted)` : name}
            </span>
            <CopyBtn text={out} />
          </summary>
          {}
          <div class="mono">{out}</div>
          <div class="meta">
            {fmtDur(e.data.durationMs)}
            {name === "bash"
              ? outcomeMarker(shellOutcome(e.data.ok, out))
              : ok
                ? ""
                : " · FAILED"}
          </div>
          <Show when={props.orphan}>
            <div class="meta">its call is no longer in the loaded events — the run itself finished</div>
          </Show>
        </details>
      );
    }
    case "decision": {
      const alts = Array.isArray(e.data?.alternatives) ? (e.data.alternatives as string[]) : [];
      return (
        <details class="embed decision">
          <summary>
            <b>📌 <span class="content inline-md" innerHTML={renderMarkdownCached(String(e.data?.decision ?? ""))} /></b>
            <span class="meta">decision logged</span>
          </summary>
          {}
          <div class="content" innerHTML={renderMarkdownCached(String(e.data?.rationale ?? ""))} />
          <Show when={alts.length}>
            <div class="content muted">Rejected: {alts.join(" / ")}</div>
          </Show>
        </details>
      );
    }
    case "question": {
      const opts = Array.isArray(e.data?.options) ? (e.data.options as string[]) : [];
      const callId = e.data?.callId ? String(e.data.callId) : "";
      const answered = () => props.answeredIds?.().has(callId) ?? false;
      return (
        <div class={"embed question" + (answered() ? " answered" : "")}>
          {}
          <div>❓️ <div class="content inline-md" innerHTML={renderMarkdownCached(String(e.data?.question ?? ""))} /></div>
          <Show when={answered()}>
            <div class="meta answerdone">✓ answered — continuing below</div>
          </Show>
          <Show when={opts.length > 0}>
            <div class="qopts">
              <For each={opts}>
                {(o) => (
                  <button
                    class="qopt"
                    disabled={answered()}
                    onclick={() => {
                      props.onAnswered?.(callId);
                      const actor = e.data?.actor;
                      if (actor) {
                        void api(`/api/agents/${encodeURIComponent(String(actor))}/prompt`, {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ text: o, start: true }),
                        }).then(() => flashHint(`→ answered @${String(e.data.actor)}`)).catch(() => flashHint("answer failed"));
                      } else {
                        props.onOption?.(o);
                      }
                    }}
                  >{o}</button>
                )}
              </For>
            </div>
          </Show>
          <FreeTextAnswer answered={answered()} onOption={props.onOption} />
        </div>
      );
    }
    case "progress":
      return (
        <div class="embed progembed">
          {}
          <div>📈 <div class="content inline-md" innerHTML={renderMarkdownCached(String(e.data.doing ?? ""))} /></div>
          <Show when={e.data.goalStatus}><div class="progrow"><b>goal</b><span>{String(e.data.goalStatus)}</span></div></Show>
          <Show when={e.data.recent}><div class="progrow"><b>recent</b><span class="content inline-md" innerHTML={renderMarkdownCached(String(e.data.recent))} /></div></Show>
          <Show when={e.data.problems}><div class="progrow warn"><b>⚠ problems</b><span class="content inline-md" innerHTML={renderMarkdownCached(String(e.data.problems))} /></div></Show>
          <Show when={e.data.next}><div class="progrow"><b>next</b><span class="content inline-md" innerHTML={renderMarkdownCached(String(e.data.next))} /></div></Show>
        </div>
      );
    case "error":
      return <div class="embed fail"><div class="mono">⚠ {String(e.data.message ?? "")}</div></div>;
    case "compaction":
      /**
       * Only a `<details>` when there is something to expand.
       *
       * A summary-pass FAILURE still logs a compaction event with no `summary`, and the disclosure
       * triangle then expanded to nothing — reported as "compactionのカードの中身が空なのにクリックで
       * 展開できるせいでちょっとだけ広がる". The row is a plain embed in that case, so there is no
       * affordance that promises content it does not have.
       */
      if (!e.data.summary)
        return (
          <div class="embed compaction">
            <b>🗜 context compacted</b>
            <span class="meta">
              {String(e.data.mode ?? "")} · {fmtK(Number(e.data.tokensBefore ?? 0))} → {fmtK(Number(e.data.tokensAfter ?? 0))} tok
              {" · "}{e.data.summarized ? `${e.data.summarized} summarized` : `${e.data.dropped} dropped`}
              {String(e.data.mode ?? "") === "truncate" ? " · older history dropped" : ""}
            </span>
            <Show when={String(e.data.mode ?? "") === "truncate"}>
              <div class="muted compactnote">
                the summary pass produced nothing, so the oldest messages were dropped instead — the
                session continues with the recent tail intact
              </div>
            </Show>
          </div>
        );
      return (
        <details class="embed compaction">
          <summary>
            <b>🗜 context compacted</b>
            <span class="meta">
              {String(e.data.mode ?? "")} · {fmtK(Number(e.data.tokensBefore ?? 0))} → {fmtK(Number(e.data.tokensAfter ?? 0))} tok
              {" · "}{e.data.summarized ? `${e.data.summarized} summarized` : `${e.data.dropped} dropped`}
            </span>
          </summary>
          <Show when={e.data.summary}>
            <div class="vtitle compactkept">what the agent kept</div>
            <div class="content" innerHTML={renderMarkdownCached(String(e.data.summary))} />
          </Show>
        </details>
      );
    default:
      return <div class="content muted">{truncate(JSON.stringify(e.data), 200)}</div>;
  }
}
