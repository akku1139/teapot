import { For, Show, createMemo, createSignal } from "solid-js";
import { AnsiText, BashElapsed, HighlightedCode } from "./code";
import { CopyBtn, IconBtn } from "./chrome";
import { api } from "../lib/api";
import { flashHint } from "../lib/flash";
import { hasAnsi, stripAnsi } from "../lib/ansi";
import { fmtDur, truncate } from "../lib/format";
import { goalLine } from "../lib/goal-timeline";
import { renderMarkdown } from "../md";
import { renderMarkdownCached } from "../lib/markdown";
import { groupedWith, type RowLike } from "../lib/row-grouping";
import { outcomeMarker, shellHint, shellOutcome } from "../lib/shell-outcome";
import { authorOf, fmtK, fmtTs, oneLine, rawOf, type Ev } from "../lib/timeline-row";
import { outputLang } from "../lib/tool-output-lang";


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
          // same Safari IME caveat as the main composer: isComposing is
          // already false by the time Enter's keydown arrives
          if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); }
        }}
      />
      <button disabled={props.answered || !val().trim()} onclick={submit}>reply</button>
    </div>
  );
}

export function ToolRow(props: { e: Ev; prev?: Ev; res?: () => Ev | undefined; orphan?: boolean; agentActive?: boolean; onResize?: () => void }) {
  const e = props.e;
  // GROUPING (#75 pattern, again). `groupedWith()` is the shared rule and it
  // ALWAYS said these two bash calls group — but ToolRow never received `prev`, so
  // the rule never ran for tool rows and every one of them rendered a full head:
  //
  //     embed class="embed done" summary="⚙️ $ echo ALPHA3ms…"
  //     embed class="embed done" summary="⚙️ $ echo BETA3ms…"     <- reported
  //
  // helper was right and the CALL was missing. A run of commands therefore read as
  // a stack of unrelated blocks, which is the "timeline is cluttered" complaint.
  const grouped = groupedWith(props.prev as RowLike | undefined, e as RowLike);
  // read the result prop REACTIVELY. `<For each={chatEvents()}>` builds the
  // row while its result is still undefined, and a destructured `const res =
  // props.res` is bound once — so the row kept rendering "running…" forever when
  // the result arrived.
  //
  // `props.res` is now an ACCESSOR from the caller, not a value: `pairInfo()` re-runs on
  // every append, so passing `pairInfo().resFor.get(id)` inline re-evaluated the prop and
  // re-built this row's whole JSX tree — harmless for a label, fatal for a `<pre>` whose
  // scroll offset lives on the element. MEASURED: a scrolled bash-output block lost its
  // offset whenever an unrelated message arrived, with the row ELEMENT itself reused. An
  // accessor makes the row's tree a one-time build that reads a fresh value on demand.
  // narrow dependency: see the memo below
  /**
   * NARROW the dependency to THIS row's result.
   *
   * `props.res` reads `pairInfo()`, which returns a fresh `{resFor, consumed, orphanCalls}` object
   * on every append — so a row's `res()` "changed" whenever ANY event arrived, and every row's
   * `derived` memo re-ran. MEASURED on a 20-row timeline: 40 memo runs and 118 `HighlightedCode`
   * constructions for 20 rows, i.e. roughly twice the work per row plus a full rebuild of every
   * JSX subtree in the memo body (Solid runs the memo function BEFORE `equals` is consulted).
   *
   * This memo compares the RESULT's identity (`Ev.id`), so a row whose result did not change sees
   * no update at all — which is what `equals` was supposed to buy, applied one level earlier where
   * it also skips building the JSX.
   */
  const resEv = createMemo(() => props.res?.(), undefined, {
    equals: (a, b) => a?.id === b?.id,
  });
  /** every read below goes through the NARROW memo, never the raw prop */
  const res = () => resEv();

  // STALE-RUN GUARD: if the agent is no longer running, an unpaired tool_call
  // cannot still be in flight (its result event was missed — e.g. logged while
  // the tab was hidden). Rendering it forever as "running…" was exactly that:
  // switching sessions and back "fixed" it because that reloaded the log.
  //
  // this must be a FUNCTION, not a value. Computed once in the component
  // body it captured `props.agentActive` as it was when the row was BUILT — i.e.
  // `true`, because a row only exists because the agent was working — so the
  // guard could never fire. It was written to close exactly this bug and could
  // not, which is why the issue kept coming back.
  const staleDone = () => !props.agentActive && !res();
  const d = e.data ?? {};
  const name = String(d.name ?? "tool");
  const out = () => String(res()?.data?.result ?? "");

  const argStr = (k: string) => String(d.args?.[k] ?? "");
  // best-effort "what was run" text per tool: bash→the command, others→path/args
  const cmdText = () => {
    if (name === "bash") return argStr("command");
    return argStr("path") || JSON.stringify(d.args ?? {}, null, 1);
  };
  // effective timeout for live elapsed display — tools with defaults that the
  // model omitted (wait_children: 5 min) still show their real cap
  const effTimeout = () => {
    if (name === "bash") return Number(argStr("timeout_ms")) || undefined;
    if (name === "wait_children") return Number(argStr("timeout_ms")) || 300_000;
    return Number(argStr("timeout_ms")) || undefined;
  };
  /**
   * A tool card's code surface: the SAME depth for arguments and output.
   *
   * ではどっちも一段深い". The cause was two different renderers: the output went through
   * `codeBlock` (`.toolbody`, `--bg-darkest`) while the arguments were a bare `<div class="mono">`
   * with no surface at all — so a generic tool showed the card colour for its input and the deeper
   * surface for its result, and `bash` happened to use the deeper one for both.
   *
   * Every code surface in a tool card now uses `.toolbody`, so input and output read as one block
   * with a consistent depth regardless of which tool the row is.
   */
  const codeBlock = (text: string, max = 1500, lang?: string) => (
    <HighlightedCode text={truncate(text, max)} lang={lang} />
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
          <HighlightedCode text={out()} lang={outputLang(out())} />
        )}
        <div class="meta">
          {fmtDur(r.data?.durationMs)}
          {/* #46: a killed shell said nothing here beyond a generic · FAILED, so
              a TIMED OUT command still read as an ordinary completed run. */}
          {name === "bash"
            ? outcomeMarker(shellOutcome(r.data?.ok, String(r.data?.result ?? "")))
            : r.data?.ok === false
              ? " · FAILED"
              : ""}
          <CopyBtn text={hasAnsi(out()) ? stripAnsi(out()) : out()} />
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
  // per-tool summary line: [label, hint]. There is no icon: the default was "⚙️" for
  // every tool and no case ever overrode it, so it identified nothing — the tool NAME
  // is already in the row's author slot, and a grouped row showed no ⚙️ at all, which is
  // the inconsistency this removes.
  let label = name;
  let hint: string | null = "";
  let body: any = argsBlock();
  try {
    switch (name) {
      case "bash": {
        const cmd = argStr("command");
        const isBg = d.args?.background === true;
        // background jobs return INSTANTLY (the shell keeps running) — a plain
        // "$ cmd · 12ms" row read as "finished immediately" and the job was
        // forgotten. Give them their own identity + the job id for bash_output.
        const bgJob = isBg ? (String(out()).match(/job (bg\d+)/)?.[1] ?? "") : "";
        label = (isBg ? "⏳ " : "$ ") + oneLine(cmd, 96);
        const timeoutMs = argStr("timeout_ms") ? Number(argStr("timeout_ms")) : undefined;
        // a command the harness KILLED used to render as
        // `300ms · timeout 1s` — indistinguishable from a fast success, so the
        // row never read as finished. Name the outcome on the summary line.
        const r = res();
        const outcome = shellOutcome(r?.data?.ok, r ? String(r.data?.result ?? "") : "");
        hint = r
          ? isBg
            ? `background job${bgJob ? ` ${bgJob}` : ""}${timeoutMs ? ` · timeout ${Math.round(timeoutMs / 1000)}s` : ""}`
            : shellHint({ outcome, durationMs: r.data?.durationMs, timeoutMs, fmtDur })
          : null; // live elapsed renders in the summary (below)
        body = (
          <>
            {isBg ? (
              <div class="meta bgjob-note">
                runs in background — poll with <b>bash_output(job_id=&quot;{bgJob || "?"}&quot;)</b>
                {bgJob ? <> · kill with <b>action="kill"</b></> : null}
              </div>
            ) : null}
            {/* the command gets SHELL highlighting: it is the one tool input where the syntax
                carries meaning (quoting, pipes, flags), not just data */}
            {cmd !== label.slice(isBg ? 2 : 2) ? codeBlock(cmd, 800, "shellscript") : null}
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
        // content was rendered UNTRUNCATED — a few big write_file calls (the
        // 100KB+ ones real sessions accumulate) made those chats take seconds
        // to open and chew CPU on every prepend while scrolling back
        body = (
          <>
            {codeBlock(content, 1500)}
            {content.length > 1500 ? <div class="meta muted">{fmtK(content.length)} bytes — open it from 🗂 files for the full view</div> : null}
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
            <pre class="mono toolbody del">{truncate("- " + argStr("old_text"), 900)}</pre>
            <pre class="mono toolbody add">{"+ " + truncate(argStr("new_text"), 900)}</pre>
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
        // huge patches rendered one <div> PER LINE with no cap — multi-thousand-
        // line patches froze the feed. Show the head; the rest is noise here.
        const MAX_PATCH_LINES = 60;
        const shown = patchLines.slice(0, MAX_PATCH_LINES);
        body = (
          <>
            <pre class="mono toolbody patch">
              {shown.map((l) => {
                const cls = l.startsWith("+") ? " add" : l.startsWith("-") ? " del" : /^\*\*\*|^@@/.test(l) ? " meta" : "";
                return <div class={"pline" + cls}>{l.length > 240 ? l.slice(0, 240) + "…" : l}</div>;
              })}
              {patchLines.length > MAX_PATCH_LINES ? <div class="pline meta">… {patchLines.length - MAX_PATCH_LINES} more lines</div> : null}
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
        try { const u = new URL(host); host = u.host + u.pathname; } catch { /* keep raw */ }
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
        // reading vs killing reads differently at a glance
        const action = argStr("action") || "read";
        const jobId = argStr("job_id") || "(?)";
        label = `bash_output ${jobId}`;
        hint = action;
        body = resultBlock();
        break;
      }
      case "load_skill": {
        label = `skill: ${argStr("name")}`;
        const mdBody = out().replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""); // strip frontmatter
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
        /**
         * EVERY other tool: show the arguments AND the result.
         *
         * There was no `default:` branch, so any tool without an explicit case — every MCP
         * tool, `wait_children`, `read_memory`, the meta tools, `web` — kept the initial `body`,
         * which is the JSON of its INPUT. Reported as "bashやfile系以外のツールは入力パラメータは
         * 表示されるのに出力がタイムラインに表示されない". The output was in the log and paired
         * correctly; it simply had no case that rendered it.
         *
         * The generic view is the right fallback in shape (the input is often what you want to
         * see first), but it must not be the WHOLE view: for a tool whose effect is its return
         * value — `read_memory`, an MCP lookup, `wait_children` — showing only the arguments
         * tells the operator nothing about what happened.
         */
        label = name;
        // the duration is the only summary fact a generic tool has; the outcome is in the body
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
    /* fall back to the generic view on anything unexpected */
  }
    // `key` is what the memo's `equals` compares: the RESULT's identity plus the label. Two
    // runs that would build the same body must produce the same key, or the `<pre>` inside is
    // discarded and its scroll offset with it.
    return { label, hint, body, key: `${res()?.id ?? "none"}|${label}|${hint ?? ""}` };
    },
    undefined,
    {
      // compare the RESULT the memo was built from, not the returned object (which is always
      // a fresh `{label, hint, body}` and would therefore never compare equal)
      equals: (a, b) => (a as { key?: string }).key === (b as { key?: string }).key,
    },
  );

  return (
    <details
      class={"embed" + (grouped ? " grouped" : "") + (res() ? (res()!.data?.ok === false ? " fail" : " done") : staleDone() ? " done" : " running")}
      title={`${name}${derived().hint ? " — " + derived().hint : ""}`}
      onToggle={(ev: ToggleEvent) => {
        // expanding/collapsing changes the feed height; while following, the
        // bottom line must stay pinned instead of drifting out of view
        if ((ev.target as HTMLDetailsElement).open) props.onResize?.();
      }}
    >
      <summary>
        {/* A GROUPED row keeps its command (you still need to know what ran) but drops
            the repeated marker, so a run of commands reads as one block instead of N
            unrelated ones. The label already carries its own marker ("$ ", "⏳ "). */}
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
                ? // any tool with a timeout shows live elapsed + its cap
                  <BashElapsed startedAt={e.ts} inline timeoutMs={effTimeout()} /> // visible while folded
                : "running…"}
        </span>
        {/* dedicated copy buttons: the generic header "copy" copied "" on tool
            rows (rawOf only knows prompts/messages) — now the command that ran
            and its output each have their own button */}
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
  // Grouping is `groupedWith()` from ./row-grouping — extracted so the rule can
  // be tested against the code that runs. It used to live inline here,
  // and the tests re-implemented it, which is why deleting the real #49 fix left
  // them all green.
  const grouped = () => groupedWith(props.prev?.() as RowLike | undefined, e as RowLike);
  /**
   * Whether the row BELOW continues this run — computed here rather than in CSS.
   *
   * The spacing around a run needs three facts: is this a continuation (`grouped`), does a
   * continuation follow, and does one follow THIS row. `:has(+ .msg.grouped)` could answer
   * the last two, but it makes the style engine run a sibling-matching pass for EVERY row on
   * every style recalc — and this feed renders ~1,100 rows on open. The component
   * already knows the next event, so the answer is free here and the selector disappears.
   */
  const nextGrouped = () => {
    const n = props.next?.();
    return !!n && groupedWith(e as RowLike, n as RowLike);
  };

  // non-chat-looking events become divider lines
  if (e.type === "fork") {
    const d = e.data ?? {};
    return (
      <div class="divider-msg">
        ⑂ forked from {String(d.fromBranch ?? "?")} → {String(d.newBranch ?? e.branch)}
      </div>
    );
  }
  if (e.type === "goal") {
    // the finish→audit→continue lifecycle used to render as bare labels
    // with an EMPTY body ("🎯 goal audit:"), hiding the verification contract
    // and the verdict. Every branch now carries a real detail, and "done" is
    // labelled as PENDING audit because it is logged before the audit runs.
    //
    // the label and this card were children of `.divider-msg`, which is
    // `display:flex` with ::before/::after filling the slack — so the card was
    // a FLEX SIBLING of the label and everything shared one row, with the
    // card's left edge wherever the flex layout put it. `.goalline` stacks them
    // instead: label on its own line, card beneath, both aligned to the same
    // left edge as every other card in the feed.
    const line = goalLine(e.data ?? {});
    return (
      <div class={"goalline " + (line.tone === "err" ? "err" : line.tone === "warn" ? "warn" : "")}>
        <div class="goalline-label">{line.label}</div>
        {/* an empty detail means "nothing real to show" — the label stands
            alone rather than getting a placeholder card. `hasCard` is
            the explicit flag, so this is never a guess from an empty string. */}
        <Show when={line.hasCard}>
          <div
            class={"card " + (line.tone === "ok" ? "auditcard ok" : line.tone === "warn" ? "auditcard" : "verifycard")}
            innerHTML={
              line.markdown
                ? renderMarkdown(line.detail)
                : renderMarkdown(`\`\`\`\n${line.detail}\n\`\`\``)
            }
          />
        </Show>
      </div>
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
        // the row BELOW continues this run — replaces a `:has(+ .msg.grouped)` selector,
        // which made every row pay for a sibling match on every recalc
        (nextGrouped() ? " next-grouped" : "") +
        (e.data?.pending ? " pending" : "") +
        (e.data?.cancelled ? " withdrawn" : "")
      }
      data-eid={e.id}
    >
      {/* grouped rows keep the same geometry as the row that started the
          run — same avatar slot, but EMPTY (no faded ghost icon): a column of
          faint 🧩s read as separate "sub messages" instead of continuation
          lines. Hover still shows time+branch via the title. */}
      <div
        class={"avatar avghost" + (grouped() ? " ghosted" : "")}
        style={{ background: grouped() ? "transparent" : a.color + "33", border: grouped() ? "1px solid transparent" : `1px solid ${a.color}66` }}
        title={grouped() ? `${fmtTs(e.ts)} · ${e.branch}` : undefined}
      >
        {grouped() ? "" : a.icon}
      </div>
      <div class="msg-body">
        {grouped() && <span class="grouptime" title={`${fmtTs(e.ts)} · ${e.branch}`} />}
        <Show when={!grouped()}>
          <div class="msg-head">
            <span class="author" style={{ color: a.color }}>{a.name}</span>
            <Show when={e.data?.actor}>
              <span class="actor">@{String(e.data.actor)}</span>
            </Show>
            <span class="ts">{e.data?.pending ? "queued…" : e.data?.cancelled ? "withdrawn" : fmtTs(e.ts)}</span>
            {/* #32 (clutter): the branch label is constant for a whole session and
                was repeated on EVERY row — MEASURED, all 14940 events of this
                session carry `br0`, so ~1500 rendered rows said "br0" for no
                information. Show it only when the session actually HAS more than
                one branch (a fork), which is the only time it distinguishes
                anything. It stays in the row title, and in the branch picker. */}
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
            {/* tool rows have no copyable message body — their command/output
                buttons live inside ToolRow; rendering the header button anyway
                produced a "copy" that silently copied the empty string */}
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
      // image attachments render as thumbnails under the text (logged events
      // carry data.images; optimistic echoes carry data.pending images array)
      const imgs: string[] = e.data?.images ?? [];
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
              <summary>💭 reasoning{String(e.data.reasoning).length > 4000 ? ` (${fmtK(String(e.data.reasoning).length)} — truncated)` : ""}</summary>
              <div class="mono">{truncate(String(e.data.reasoning), 8000)}</div>
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
      // a result whose call is no longer in the events window. It used to
      // render as a bare output blob with no tool name and no command, which
      // read as "the run never finished". Render the SAME completed tool row a
      // paired result gets, from the result's own metadata, so it is
      // indistinguishable from one that survived in the window.
      const out = String(e.data.result ?? "");
      const name = String(e.data.name ?? "tool");
      const ok = e.data.ok !== false;
      return (
        <details class={"embed " + (ok ? "" : "fail")} open={props.orphan}>
          <summary>
            <span class="meta">
              {/* the call is gone, so the command is too — show the tool and
                  the outcome rather than inventing an argument that was never
                  logged here */}
              {name === "bash" ? `$ (bash, call evicted)` : name}
            </span>
            <CopyBtn text={out} />
          </summary>
          {/* In FULL, like a paired result: the operator opened the card to read it, and this
              path used to cut at 4000 chars — so an evicted call showed a truncated output while a
              surviving one showed everything, from what looked like the same row. */}
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
          {/* model-written markdown, same as progress bodies */}
          <div class="content" innerHTML={renderMarkdownCached(String(e.data?.rationale ?? ""))} />
          <Show when={alts.length}>
            <div class="content muted">Rejected: {alts.join(" / ")}</div>
          </Show>
        </details>
      );
    }
    case "question": {
      const opts = Array.isArray(e.data?.options) ? (e.data.options as string[]) : [];
      // a question is ANSWERED once its tool_result exists in the log (ask_user
      // parks the loop; the reply lands as a user prompt and the tool_result
      // closes the call). Answered questions keep their options visible but
      // disabled — tapping them twice used to send duplicate prompts.
      const callId = e.data?.callId ? String(e.data.callId) : "";
      // called inside the row, so it tracks the signal reactively
      const answered = () => props.answeredIds?.().has(callId) ?? false;
      return (
        <div class={"embed question" + (answered() ? " answered" : "")}>
          {/* questions are model-written and often carry markdown (code refs,
              lists) — render them like progress embeds instead of dumping raw */}
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
                      // mark it answered NOW, before the POST. The derived
                      // set only catches up when the prompt event is logged, and
                      // until then the buttons stayed live — so a second click
                      // sent a duplicate prompt.
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
          {/* progress bodies are model-written markdown — render them, don't
              dump raw text (structured fields keep their labels) */}
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
