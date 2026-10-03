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

## RETRACTED — measured afterwards, and it was wrong

**Everything below this line was a recommendation I have since disproved.** Kept
because the survey itself is sound and the retraction is the useful part.

I then measured 2,084 real `edit_file` calls from the session logs:

| tool | calls | failure rate |
|---|---|---|
| edit_file | 2084 | 8.1% |
| apply_patch | 501 | **21.8%** |
| write_file | 934 | 3.2% |
| bash | 31761 | 3.9% |

Of **168** `edit_file` failures, only **2 (1.2%)** had an `N| ` gutter pasted
into `old_text`. 117 were plain "old_text not found", 22 tool errors, 18 empty
`old_text`, 10 non-unique.

So both proposals above — stripping the gutter in `edit_file`, and making
hashline the default — would have addressed **1.2% of the failures** while
changing read output for every model and every skill. Neither was done.

The real cause is visible in the same data: bash mutates files **5980 times**
against 2084 `edit_file` calls, at a *lower* failure rate (3.9% vs 8.1%). The
model is not failing to use `edit_file`; it is rationally preferring the tool
that works more often. That is an ergonomics problem, not a matching problem,
and the lever is first-try success rate — not tolerance of sloppier input.

What survives from the survey:

- **Do not add fuzzy matching.** Zed's cascade silently edits the wrong span.
  That finding is independent of #83 and stands on its own.
- **The design space is genuinely poor** — ten of ten harnesses push this burden
  onto the model, and none ships a verified anchor. If teapot ever revisits this,
  the hashline anchors already built for #7/#4 are the strongest asset it has; the
  timing just is not now.
- **`apply_patch` fails more than twice as often as `edit_file`** (21.8%). It is
  the one finding here that points at a real, separate defect.

Not answered: whether the model's `old_text` is usually *wrong* or *right but for
whitespace*. Those need opposite fixes and the aggregate log cannot distinguish
them — that needs opening a few examples.
