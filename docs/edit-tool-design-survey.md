# Why the agent abandons `edit_file` — and what other harnesses do

Survey of ten harnesses, read from source (clones at pinned HEADs; Claude Code's
tool source isn't in the repo, so its shipped binary was used). Not implementing
anything — this is the landscape, so the fix is chosen against evidence rather
than by intuition.

## First, a correction to my own framing

I opened this expecting a correctness bug. It isn't. teapot's behaviour is
already the *good* end of this problem space:

    edit_file with the gutter pasted in
      -> old_text not found in file. No similar text found — re-read a.txt
         around the target area and copy old_text exactly. Watch indentation/
         trailing spaces and drop the `N| ` line-number prefixes.

That is a **loud, safe, actionable** failure. It is what Claude Code, OpenCode V2
and Cline all do. Zed, by contrast, silently edits the wrong place — see below.

So the question is not "how do we make the edit succeed" but "why does the model
abandon the tool after a clean, explanatory failure".

## What the ten do

| Harness | Read gutter | Pasted gutter | Matcher | Anchor |
|---|---|---|---|---|
| Claude Code | `cat -n` | **fails loudly** | exact, once | no |
| Aider | **none** | moot | search/replace + elision | no |
| Cline | `N \| ` (pad width varies) | **fails loudly** | exact, zero fuzz | no |
| Continue | **none** | moot | 4-tier cascade | no |
| OpenCode V2 | `N: ` | **fails loudly** | exact | no |
| OpenCode V1 | `N: ` | fuzzy cascade | 9-stage | no |
| Codex CLI | **no read tool** | n/a | `*** Begin Patch`, 4-tier fuzzy | no |
| Gemini CLI | **none** (`grep` numbers separately) | moot | 4-tier + `editCorrector` | no |
| Zed | `%6d\t` | **silently edits WRONG** | 4-stage, per-line Levenshtein | no |
| OpenHands | `%6d\t` / `%6d  ` | fails for multi-line, **silently "works" for single-line** | literal + whole-blob `.strip()` | no |

Two findings that matter more than the table:

**Nobody strips the prefix in the edit path. Zero of ten.** The burden is pushed
onto the model through tool-description prose — and three of ten don't even do
that (Cline ships the gutter, the strictest matcher, and **no warning**).

**Nobody ships a verified anchor.** No per-line content hash, no stable line id,
nothing the model can hand back verbatim. Every design asks the model to
reproduce bytes it saw inside a decorated string and hopes the decoration stays
out. teapot is the only one of these eleven with hashline anchors — and it was
built for exactly this reason (#7/#4).

## Three designs, and what each trades

**Numbered read + exact matcher + prompt warning** (Claude Code, OpenCode V2,
Cline, OpenHands). Deterministic; a failed match is unambiguous and safe to
retry. Costs: every edit is a retry lottery until the model internalises the rule,
and nothing *enforces* it.

**Numbered read + fuzzy cascade** (Zed, OpenCode V1, Gemini, Codex, Continue).
Survives indentation drift and smart quotes. **But this is not a fix for the
gutter — it is a way of hiding it.** Zed is the proof: its fuzzy stage trims the
*query* line, so a pasted `"     1\tconst x = 1;"` clears the 0.8 per-line
Levenshtein gate and the edit lands **somewhere plausible and wrong**, silently.
A cascade converts a loud failure into a silent corruption.

**Unnumbered read output** (Gemini `read_file`, Continue, Aider, Codex). The
class of bug is designed out; exact matching becomes sufficient rather than a
tax. Costs positional orientation, which is why Gemini re-adds numbers in `grep`
output (`L123: `) while keeping the file body clean — numbers for navigation,
raw text for editing. That split is the right one.

## What actually prevents abandonment

Not fuzzy matching — the evidence says that makes it worse. Two things do:

1. **Prompt/anchor iteration.** Claude Code's changelog shows them tuning the
   *prompt*, not the matcher: *"Edit tool now uses shorter `old_string` anchors,
   reducing output tokens"* and *"Read tool now uses compact line-number format"*.
   I verified the equivalent holds here: a short clean anchor succeeds first try.

2. **Strip at the read boundary.** One project outside the set — Stencila —
   does this, in twelve lines, on the *file-content read* path so the edit tool
   always diffs against clean text. It is the cheapest correct fix.

And a constraint worth stating: **any strip logic needs the exact separator, not
`\d+\s*[|:\t]?`.** That pattern eats real leading whitespace and indented
content. teapot's gutter is `` `${n.padStart(w)}| ` `` where `w` **varies per read
window**, so the width cannot be assumed.

## Recommendation for teapot

**Do not add fuzzy matching.** It is the single change that would make this
worse, and teapot's existing loud failure is better than Zed's silent one.

Two options, and the second is now clearly better informed than my earlier guess:

**(a) Strip `N| ` prefixes from `old_text` in `edit_file`, guarded.** Try the
stripped form first; fall back to the raw form. Narrow, ~10 lines, and it leaves
`read_file`'s output format alone.

**(b) Make hash anchors the default `read_file` output.** The research is what
convinces me this is the better answer: ten of ten harnesses are stuck asking the
model to strip a prefix by hand, and **none** has a verified anchor. teapot
already built one for this exact reason. Making it default removes the failure
mode instead of mitigating it.

The cost of (b) is real and is the reason to hesitate: it changes read output for
every model and every skill written against `N| `, and `test/read-gutter.test.ts`
encodes the current default. But (a) keeps a trap alive on the default path, and
the trap is the reported problem.

I'd do **(b)**, with the gutter kept available as an explicit opt-in. Worth
saying plainly: I proposed (a) before this research, and the research moved me.

## Not decided here

Whether a model that has already drifted to `bash + python` will return to
`edit_file` at all. Claude Code's history suggests prompt tuning moves the rate
but does not eliminate the drift, so a fix here may reduce #83 rather than close
it — worth measuring on a real long session before calling it done.