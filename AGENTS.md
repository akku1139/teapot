# AGENTS.md — working in this repository

Notes for AI agents (and humans) working on teapot. Read this before you
commit. Everything here is a rule that has been paid for by a real bug.

## What this project is

`teapot` is a multi-agent harness: a Node/TypeScript server (`src/`) that runs
LLM coding agents and a Solid + Vite web UI (`frontend/`) that drives them over
one WebSocket plus a small REST surface (`src/server/api.ts`).

```
src/            server: master, agent loop, tools, LLM client, log, cron, API
frontend/       web UI (Solid JSX + app.css); pure helpers live as .ts next to App.tsx
test/           node --test suites (*.test.ts), plus test/helpers/
scripts/        smoke-web.mjs (real bundle in happy-dom), run-portable-tests.mjs
skills/         bundled skills shipped with the package
docs/           design notes and surveys
```

## Non-negotiable rules

1. **Never add a `Co-Authored-By:` trailer, and never touch git config.**
   Do not modify `.gitconfig`, `user.name`, `user.email`, hooks, or remotes.
   Commit as the configured identity only. (See issue #145 — agents doing this
   introduced bogus contributors.)
2. **Never `git push --force` and never rewrite published history.**
3. **Do not commit secrets.** `teapot.config.json` holds API keys and is
   gitignored — keep it that way. `public/` is a build output and is gitignored.
4. **Do not rewrite a file you did not read.** Prefer small, precise edits.
5. **Commit only what the task asked for.** Unrelated reformatting buries the
   real change and makes review worthless.

## Before you say "done"

Run all of these and make them pass. "It typechecks" is not one of them.

```sh
pnpm typecheck      # server
pnpm typecheck-web  # frontend
pnpm lint           # oxlint
pnpm build          # required before pnpm test — the web bundle tests need it
pnpm test           # node --test test/*.test.ts
```

`pnpm build` is **mandatory** before `pnpm test`: `test/web-bundle.test.ts`
FAILS (not skips) when `public/` is missing or older than the sources, because a
stale bundle passes its own smoke tests while exercising code you have since
changed (#75).

To only run what a platform can support (Windows CI), use
`pnpm test:portable`. POSIX-only suites opt out explicitly with
`markPosixOnly("reason")` from `test/helpers/posix-only.ts` — never by filename.

## Testing

- Put pure logic in a `.ts` helper next to `App.tsx` (e.g.
  `frontend/session-scope.ts`) and unit-test it directly with `node --test`.
  Huge parts of `App.tsx` are not mountable in tests, so "make it testable"
  usually means "extract the rule".
- **Assert on the code that actually runs.** A test that re-implements the
  function it is checking, or that only asserts a source-string shape the bug
  can survive, proves nothing. This failure mode shipped more than once (#75).
- Behaviour that depends on the real bundle (rendering, the drawer, the live
  buffer) belongs in `scripts/smoke-web.mjs`, which loads the built bundle in
  happy-dom and drives it. happy-dom does **no layout**, so geometry is
  asserted as a CSS contract (`test/helpers/css.ts`), never as pixels.
- Read source through `readSource()` (`test/helpers/source.ts`) so CRLF
  checkouts behave like LF ones (#126).
- Strip CSS comments before asserting on a rule body (`cssRuleBody` already
  does) — declarations quoted in a rule's own explanatory comment otherwise
  satisfy the assertion (#75).
- **Do not add a test per assertion.** Prefer one test that would fail for the
  real reason over five that pin incidental strings. Delete tests that no
  longer protect anything; a suite that grows without bound gets ignored.

## Comments

Write a comment only when it carries information the code cannot: **why** a
non-obvious choice was made, what was measured, what breaks otherwise.

- Reference the issue (`#142`) when the reason is a reported bug.
- State the mechanism, not the aspiration. "`--termh` never inherited here
  because a custom property only flows down the tree" is useful; "handle the
  height properly" is noise.
- Keep it as short as it can be while still being true.
- Delete comments that restate the next line, narrate history nobody needs, or
  describe code that no longer exists. Dead prose is a maintenance cost and it
  is how wrong explanations get quoted as fact later.

## UI / frontend conventions

- **A `//` comment inside JSX children is not a comment — it is JSX text and it
  renders on screen.** Use `{/* … */}`. (`test/jsx-line-comment.test.ts` parses
  every `.tsx` and fails on this.)
- The composer is an **uncontrolled** textarea on purpose: `value={draft()}`
  writes the DOM on every keystroke, which ends an in-flight IME composition and
  discards the kana being typed. Sync the value through the gated effect in
  `frontend/composer-ime.ts`.
- CSS custom properties inherit **down** the tree only. A variable set on one
  sibling cannot be read by another; publish it on their common ancestor.
- Keep the JS breakpoint (`NARROW_PX` in `App.tsx`) equal to the CSS
  `@media (max-width: …)` breakpoint — they must agree or the drawer and the
  column disagree about which mode they are in.
- Prefer `:has()`/class contracts over one-off inline styles: the tests can pin
  a class, and a class cannot drift from its twin.

## Architecture notes worth knowing

- The timeline is scoped to a **session** (one agent can own several), while
  some client state is keyed by **agent**. When adding state, decide which of
  the two it belongs to and say so in a comment; mixing them is the root of
  several long-lived bugs (#40, #146).
- The server sends authoritative snapshots over the WebSocket; REST is a
  fallback/resync path. Prefer extending the socket payload over adding a poll.
- **The intended timeline architecture** (and the direction to move in): every
  logged event is broadcast over the WebSocket and MERGED client-side, so REST
  is needed only when switching session and when returning from sleep, where
  the gap genuinely cannot be reconstructed locally.
  - The socket already carries the full event (`kind:"event"`, the object the log
    wrote), and `mergeEvents` dedupes by id and sorts by seq, so a socket frame
    and a REST page can arrive in either order.
  - The drift, MEASURED: with synthetic geometry and counters around `fetch`, one
    ordinary socket event costs a FULL `/events` read (the read count goes 1 → 2
    while a message is merely rendered). The event branch merges the payload and
    then schedules `runFeedRefresh`, which re-reads the whole log.
  - What that pass must keep providing, and where it already exists:
    `refreshAgents()` (the `status`/`live` that drives tool-row chrome) — every
    status transition in `src/agent/agent.ts` already emits `kind:"agent-update"`,
    and the WS route attaches a fresh snapshot to each one, so the socket can
    carry it. `catchUpAfterReconnect()` (`?after=<cursor>`) is ALREADY the
    proportional, socket-shaped path; the live branch could use the same call
    instead of a full re-read.
  - Why this is not a quick change: it is the area #54 came from, where the
    socket was made authoritative BEFORE the status path moved with it and every
    tool row broke. Do it as a measured step (count the `/events` reads before and
    after) with the tool-row closure re-verified, not as a tidy-up.
- Agent status (`status`) and "is work in flight" (`live`) are different
  things: a parked tool or a queued prompt is live while the status reads
  `idle`. Use `live`/`isBusy` for control decisions.
- Log events are append-only JSONL; the UI rebuilds state from them. Never
  rewrite history in place.

## Commits and releases

- One logical change per commit. Message: `fix(#NNN): <what was wrong>`, with a
  body explaining the **mechanism** and the evidence (a measurement, a test, a
  reproduction) — not just "fixed the bug".
- Keep the trailer area clean: no `Co-Authored-By`, no generated-by lines.
- Releases are tag-driven (`.github/workflows/publish.yml`). Bumping
  `package.json` and pushing the matching `vX.Y.Z` tag publishes to npm; the
  workflow refuses a tag that disagrees with the version.

## Fixing a bug that has been "fixed" before

Some issues here (#40, #54) have been reported fixed and returned. Before
changing code for one of them:

1. **Reproduce it first, and say how.** A measurement in this repo beats a
   theory every time; the wrong conclusions logged on #40 all came from reading
   code instead of driving it.
2. **Find out how the last fix failed.** Usually the helper was right and the
   WIRING was dead, which is why the pure-helper tests were green (#75). Check
   that the code you are about to change is actually called: instrument it, or
   assert the call site, not the helper.
3. **Write the test so it fails on the old code** before you call it fixed.
