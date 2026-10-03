# teapot-9 sub-task: edit-tool design research (line-number gutter problem)

## Scratch location
Blobless clones at /tmp/hn/{aider,opencode,codex,gemini-cli,cline,continue,OpenHands,zed,claude-code}
@ pinned HEADs. Claude Code shipped binary pulled to /tmp/hn/cc/package/claude (v2.1.288, Bun-compiled, NOT stripped).
Read helper: /tmp/hn/g.sh <repo> <grep args>  (runs `git grep -n -I ... HEAD --`)

## KEY GOTCHA
Blobless clones have an EMPTY working tree. Must always pass `HEAD` revspec to git grep/git show,
or you silently search nothing and get false negatives. Hit this once.

## Headline findings
- ZERO of the 10 harnesses strip a line-number prefix programmatically on the edit side.
  The whole burden is pushed onto the model via tool-description prose.
- Three of the ten (Gemini CLI read_file, Continue readFile, Aider file-adds) do not number read output at all.
- NO harness ships a content-addressed / hashed anchor. Greps for fingerprint|contentHash|lineHash|
  anchorId|stableLineId across all of them: zero relevant hits.
- Only Stencila (stencila/stencila, outside the assigned list) actually strips:
  rust/agents/src/tools/mod.rs:224 `strip_line_numbers()` — cuts at first " | ".
  Read the code: it strips on the FILE-CONTENT side (read_raw_content), not on old_string.

## Claude Code source access trick
Repo anthropics/claude-code has NO tool source (mods/ is plugins + types only).
But `mods/types/claude-code.d.ts` contains the real tool input schemas, and the npm package
@anthropic-ai/claude-code-linux-x64 ships an unstripped ELF with the JS embedded. `grep -aob` +
`dd skip=N count=M | tr -d '\000'` extracts exact strings. Two copies of the bundle exist in the
binary (byte offsets ~98.8M and ~211M).

## Useful exact strings recovered
Claude Code Edit desc: "Never include any part of the line number prefix in the old_string or new_string."
Claude Code Read desc: "- Results are returned using cat -n format, with line numbers starting at 1"
Zed read_file_tool.rs:75: `write!(output, "{line_number:>6}\t")`
Cline file-read.ts:171: `${String(lineNumber).padStart(maxLineNumWidth," ")} | ${text}`
OpenCode read.ts: `${i + file.offset}: ${line}`
OpenHands editor.py:820: `f"{i + start_line:6}\t{line}"`

## Decisions
Logged in decisions.md: three design families keyed on (numbered read x matcher tolerance).