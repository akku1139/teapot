# When the agent is forced to keep going

Two mechanisms can hand the agent another turn after it has stopped. They answer different problems and have
different lifetimes, and mixing them up is how "the agent kept going for no reason" reports appear. This is the
specification that lives in `src/agent/agent.ts` — keep them in step.

## 1. Auto-continue (the goal loop)

Owner: `runTurnsUntilIdle()` / the round-end block in `agent.ts`.

A round ends when the model produces an assistant message with no tool calls. The loop then asks: does the operator
want this session to keep working on its goal without being prompted?

| Condition | Required |
| --- | --- |
| `finish()` was NOT called in this round | yes — a genuine finish always ends it |
| `opts.autoContinue` is on (per-agent checkbox `auto-continue`) | yes |
| `goal.status === "active"` | yes |
| `goal.text` is non-empty | yes |
| the previous round was not an idle round | bounded by `consecutiveIdleRounds` |

If all hold, a `[harness]` message is appended ("you stopped with the goal still active…") and the loop continues.

## 2. Forced continue after a progress report

Owner: the `reportedThisRound` / `reportedNudges` fields plus the branch placed **before** the goal check.

`report_progress` is answered with an instruction to end the turn right after the call. Models then write "reported."
and stop, with the work unfinished — "`reported.` で止まるケースが多すぎる". This branch exists so that filing a report
can never be the reason a turn ends.

| Condition | Required |
| --- | --- |
| `finish()` was NOT called in this round | yes |
| the round called `report_progress` at least once (`reportedThisRound`) | yes |
| it has not already fired this round (`reportedNudges < 1`) | yes — bounded to once per round |
| `goal.status !== "paused"` | yes — a paused goal means the operator parked this agent |

Deliberately NOT required, and this is the part that looks wrong until you know why:

- **`autoContinue`.** Filing a report is not a decision to stop, so the branch does not consult it.
- **a goal.** The branch sits before the goal check on purpose: the harness asks for progress after real activity, so
  an agent with no goal can still be the agent that stops dead after reporting. Its wording then says "continue what
  the operator asked for" instead of "the goal above".
- **`reportedThisRound` is NOT cleared by work done afterwards.** Measured in `prismrv-2` (events 1077→1087):
  `report_progress`, one `bash git status`, then a summary of the finished work, then a stop. The operator's verdict on
  narrowing the rule was "これ緩めないほうがいいかも / このパターンは結構ある" — that shape is common and must be
  answered. It is still answered only once per round.

`reportedNudges` is reset by any round that calls a work tool (anything outside `NON_WORK_TOOLS`), so a later report
in a later round gets its own answer.

## 3. What is NOT a forced continue

- **A degenerate-output abort** (`isDegenerateRepeat`) hands the model one corrective turn so it can restate the next
  step; up to three per round, then it stops. It is an assist, not a loop.
- **`report_progress` inside a sub-agent round** is answered by the pending-sub-report path, before both mechanisms.
