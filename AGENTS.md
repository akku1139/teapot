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

   That includes a **release tag**. Once `Publish to npm` has succeeded for `vX.Y.Z`, that
   version is on npm **permanently** — `git tag -d` + re-tag only makes the next publish fail
   with `E409` (version already exists) while npm keeps the OLD tarball. Measured: v0.34.0 was
   tagged, its Test workflow failed on `typecheck:scripts`, and re-tagging after the fix left
   npm serving a tree without that fix. The only correct move is a NEW version (`0.34.1`) —
   a published version is never rewritten.
3. **Do not commit secrets.** `teapot.config.json` holds API keys and is
   gitignored — keep it that way. `public/` is a build output and is gitignored.
4. **Do not rewrite a file you did not read.** Prefer small, precise edits.
5. **Commit only what the task asked for.** Unrelated reformatting buries the
   real change and makes review worthless.
6. **Never run the server against the operator's real data dir to measure or
   debug.** `Master.start()`/`addAgent()` WRITE: they resolve session directories,
   write `session.json` manifests, and rewrite session pointers in
   `config.json`. Running a probe in place once reassigned 493 agents to empty
   sessions and orphaned 377 MB of history (recoverable only because each
   `chat.jsonl` carries its own `agent` field — see
   `scripts/recover-session-pointers.mjs`).

   **`--port` does NOT isolate anything.** The config path comes from the first
   CLI arg (`$TEAPOT_CONFIG`), so `teapot --port 7803` loads the REAL config and
   the REAL data dir and will rewrite it — this happened repeatedly during
   release verification. To boot safely:

   ```sh
   cp -r ~/.local/share/teapot-coding-agent/sessions /tmp/sbx/sessions
   # copy the config, set "dataDir" to /tmp/sbx, then:
   teapot /tmp/sbx/config.json --port 7831
   ```

   `scripts/measure-boot.mjs <sandbox-config>` does exactly this and reports how
   many sessions were MINTED, so a destructive boot is impossible to miss.

   Shape facts that cost time to rediscover: `dataDir` holds a `sessions/`
   subdirectory (the session dirs live UNDER it, not at `dataDir`), and
   `config.agents` is a **LIST** of `{id, workspace, provider, session}`, not an
   object — feeding it an object fails at boot with
   `this.config.agents is not iterable`. **Never invent a port**: 7788 and 7789
   are the operator's live server and an IPv4 reverse proxy onto it, and a
   sandbox on either one silently loses the bind (EADDRINUSE) while your `ss`
   reads THEIR listener. Pick a high port and confirm it is yours.

7. **Never kill by port or by a broad `pgrep -f`.** Two measured traps:

   - `pgrep -f PATTERN` matches your OWN command line, so a probe that looks for
     a process reliably finds itself.
   - killing whatever listens on a port is how you kill **the process running
     you**. That happened here: 7789 was the harness's own server, and the agent
     killed it believing it was its leftover sandbox.

   Kill by an exact PID you recorded when you started the thing, or not at all.

## Before you say "done"

Run all of these and make them pass. "It typechecks" is not one of them.

```sh
pnpm typecheck      # server
pnpm typecheck-web  # frontend
pnpm typecheck:scripts  # test/ + scripts/ — CI runs it and a local run does NOT cover it
pnpm lint           # oxlint
pnpm build          # required before pnpm test — the web bundle tests need it
pnpm test           # node --test test/*.test.ts
```

`typecheck` and `typecheck-web` skip `test/` and `scripts/`, so a type error in a TEST file
passes every local gate and fails CI. That happened on v0.34.0: `tsconfig.json` omits `test/`,
and the only symptom was a red Test workflow after the tag was already pushed.

`pnpm build` is **mandatory** before `pnpm test`: `test/web-bundle.test.ts`
FAILS (not skips) when `public/` is missing or older than the sources, because a
stale bundle passes its own smoke tests while exercising code you have since
changed (#75).

To only run what a platform can support (Windows CI), use
`pnpm test:portable`. POSIX-only suites opt out explicitly with
`markPosixOnly("reason")` from `test/helpers/posix-only.ts` — never by filename.

Test artifacts all live under ONE root (`<TMPDIR>/teapot-tests`, or `$TEAPOT_TEST_TMP`):

```sh
pnpm test:tmp      # report what is there (dry run)
pnpm test:clean    # delete it
```

Never create a fixture with a bare `mkdtemp(path.join(os.tmpdir(), …))` — use
`mkdtempInRoot(prefix)` / `mkdtempInRootSync(prefix)` from
`test/helpers/tmp-root.ts`. Scattering artifacts across `/tmp` is what makes them
impossible to clean up without guessing by name, and guessing is how a tidying
script deletes somebody else's data (measured: 2006 stray fixture dirs, 439 MB).

- **The helper now REMOVES what it hands out — do not rely on `test:clean` for a normal run.**
  `mkdtempInRoot` / `mkdtempInRootSync` register each directory they create and delete it on
  process exit, which fires however the run ends (including a failing assertion). So a test
  that uses the helper leaks nothing, and `pnpm test:clean` is for the case a process was
  SIGKILLed before the hook ran.

  Why this replaced a rule: the previous text said the helper merely "puts every artifact
  under one root, but nothing deletes them unless the test does **or `pnpm test:clean`
  runs**". That reads as permission, and it was taken as such — `/tmp/teapot-tests` reached
  **2350 directories / 723 MB**, with one file writing ~1000 files per invocation and never
  deleting them (195 MB on its own). Making cleanup *possible* is not the same as making it
  *happen*; moving the responsibility into the helper is what closed it.

  MEASURED after the change: a full `pnpm test` leaves 0 directories / 0 bytes.

  An earlier rule also asked each test file to clean up in a `finally`. Enforcing that found
  **32 offenders** — which is the wrong shape of fix, because it makes correctness depend on
  32 independent authors remembering. One owner (the helper) is better. If you genuinely need
  a directory to outlive the run, say so where you create it.
- `pnpm test:tmp` / `test:clean` are the ONLY sanctioned way to tidy test output. Do not
  `rm -rf /tmp/*` or `rm -rf /tmp/<glob>` by hand: the names are not yours alone.
- **Scratch files from agent work go in `/tmp/<something-specific>/`, and are deleted
  before you finish a task.** Backups (`*.bak`), probe scripts and captured logs left in
  `/tmp` are indistinguishable from a fixture to the next person, and they are what makes
  "clean up /tmp" a guessing game. A measured example: a session's own leftovers
  (`app.fixed.tsx`, `fx2.tsx`, `rp.ts`, `t.log`) were sitting next to 335 real test
  fixtures, with no way to tell which were safe to delete.

## Testing

- **Never assert on SOURCE TEXT.** Do not read `App.tsx` / `agent.ts` / `app.css`
  and `assert.match` a regex against it. Such a test cannot fail for a real reason:
  it pins the SPELLING of code that has to work at RUNTIME, so it breaks on
  refactors that fix bugs and stays green on changes that cause them.

  This is not hypothetical. The ▶ start / ■ stop toggle had tests asserting
  `onclick={isSelLive() ? … }` and they were GREEN while the button posted the wrong
  action (a bare expression in `onclick={…}` is evaluated once, so the handler froze
  and "▶ start" kept sending `/stop`). 250 test cases of this kind were deleted; the
  whole suite was green through a dead button the entire time.

- **Test the behaviour instead.** Put pure logic in a `.ts` helper next to `App.tsx`
  (e.g. `frontend/session-scope.ts`) and unit-test it directly with `node --test`.
  Anything that depends on the real bundle — rendering, the drawer, the live buffer,
  the toggles, the feed — belongs in `scripts/smoke-web.mjs`, which loads the BUILT
  bundle in happy-dom and drives it. happy-dom does **no layout**, so geometry is
  asserted as a CSS contract (`test/helpers/css.ts`), never as pixels.

  A smoke check must assert its own PRECONDITION (that the row exists, that the
  bubble has text, that the element is scrollable) or it passes vacuously, and it
  must be verified to FAIL against the pre-fix code.

- **Do not add a test per assertion.** Prefer one test that would fail for the real
  reason over five that pin incidental strings. Delete tests that no longer protect
  anything; a suite that grows without bound gets ignored.

- **A test that fails on one platform only is usually a fixture bug**, not a product
  bug: Windows has no `/bin/bash` (mark such files POSIX-only via
  `test/helpers/posix-only.ts`) and CRLF changes byte offsets. Never `slice` source
  by a fixed width — use `blockFrom(src, anchor)`. Where a source read is genuinely
  unavoidable, use `readSource()` so CRLF checkouts behave like LF ones (#126).

- **Never wait a fixed duration for a state.** Poll for the condition. A fixed
  `setTimeout` under a loaded CI runner fails as "precondition not met" with no hint
  that the test merely ran out of clock (measured: #136 on Windows, on a
  version-bump commit of otherwise identical code). Also CLEAR timers you race
  against — an abandoned 30 s timer kept a test file's process alive for 20 s of
  pure idle after its work was done.

- If production code hardcodes a delay the test must wait out, make it injectable
  instead of sleeping (`llmRetryWaitsMs` exists for exactly this). Test time is a
  real cost: it is why an over-long suite gets skipped locally and stops being run.

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
- **Wrap an event handler in `() => …` when it decides anything from state.**
  `onclick={cond() ? a() : b()}` is evaluated ONCE, at element creation: Solid
  re-runs the tracked reads in the LABEL and `class`, but NOT the handler, so a
  button can read "▶ start" while its frozen handler posts `/stop`. That shipped —
  after a stop, the agent could never be restarted. Write
  `onclick={() => (cond() ? a() : b())()}` so the choice is made at click time.
- The composer is an **uncontrolled** textarea on purpose: `value={draft()}`
  writes the DOM on every keystroke, which ends an in-flight IME composition and
  discards the kana being typed. Sync the value through the gated effect in
  `frontend/composer-ime.ts`.
- **Never destructure `props`.** `const { a, b } = props` reads once, at
  creation, so the component stops updating — the same shape as the frozen
  handler above, and the reason `splitProps()` exists. Use `props.x` in the
  body (it is tracked on read), or `splitProps()` when a subset must be
  forwarded. Same for destructuring a getter's RESULT: pass the accessor down
  (`parent={() => …}`), not its value.
- **`<For>` keys on ITEM IDENTITY — `items[i] === nextItems[i]`.** A row rebuilt
  as a new object is DISPOSED and re-created, and its DOM state goes with it: an
  expanded `<details>` slams shut, text selection and inner scroll are lost, and
  the timeline flickers. This shipped twice:
  - `rowsWithPrev()` returned `{row, prev, next}` and was passed to `<For>`, so
    every row whose neighbour changed was remounted. Iterate the ROWS and pass
    neighbours as ACCESSORS.
  - `buildTimeline()` gave a queued prompt `seq = max(seq) + 1`, which moves
    whenever anything is logged — a new object per event. Anchor a derived value
    to the row's OWN data, or cache the derivation against the input row.
  A remount renders IDENTICAL HTML, so **no DOM assertion can see it**: measure
  element identity (`scripts/smoke-web.ts` `#rerender`) or pipeline identity
  (`test/timeline-identity.test.ts`). Do not reach for memoisation first — find
  which value moved.
- **`<Show when={…}>` must receive a stable value or a boolean.** `when={{a: 1}}`
  is a new object every run, so the child is torn down and rebuilt on every
  update. `keyed` changes the contract further: with it the child receives the
  VALUE (and is recreated when the value's identity changes), without it the
  child receives an ACCESSOR — and an unkeyed `<Show>` builds its children once,
  so anything derived must be a `createMemo` inside them or it freezes at the
  first snapshot (that is the `#108` gauge-stuck-at-0 bug).
- **A `createEffect` must not register `onCleanup` from a deferred callback.**
  Inside `requestAnimationFrame`/`setTimeout` the Owner is already `null` and
  `onCleanup` silently does nothing (solid.js: `if (Owner === null) ;`), so the
  effect leaks whatever it armed — this pegged a CPU core (#177).
- CSS custom properties inherit **down** the tree only. A variable set on one
  sibling cannot be read by another; publish it on their common ancestor.
- Keep the JS breakpoint (`NARROW_PX` in `App.tsx`) equal to the CSS
  `@media (max-width: …)` breakpoint — they must agree or the drawer and the
  column disagree about which mode they are in.
- Prefer `:has()`/class contracts over one-off inline styles: the tests can pin
  a class, and a class cannot drift from its twin.
- **Use the design tokens in `frontend/app.css`, do not invent a px value.**
  The UI read as "企業製ソフト" because there was no scale: MEASURED at 14
  distinct font sizes (9, 10, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 17, 20px),
  13 spacing values and 8 radii, each picked by eye for its own rule. A font
  size comes from `--text-*`, a gap or padding from `--space-*`, a corner from
  `--radius-*`; if none fits, add a STEP to the scale rather than a one-off.
  The scales follow `sst/opencode` (four type sizes, 130/150/180% leading) and
  Misskey (`--MI-radius: 12px`, one generous radius for panels and controls —
  most of why its UI reads as friendly rather than administrative).
- Structural dividers are **1px**. A 2px rule under a title bar or beside a
  panel is the single strongest "enterprise chrome" cue; the weight only earns
  its place where it IS the signal (the added/removed bars in a diff).

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
- **A feed row that renders nothing must not stay in the feed array.** `prev` is
  taken positionally from `chatEvents()`, and `groupedWith()` keys on the row
  TYPE, so an invisible row (e.g. `state`, which is in `FEED_TYPES` but has no
  render branch) cuts a run of tool calls in half. Assert "does this type draw
  anything" rather than special-casing one type.
- `--host 0.0.0.0` binds **IPv4 only**; `::` (and a missing hostname) binds
  DUAL-STACK. On a host reachable over both families — Tailscale hands out
  `100.x` and `fd7a:…` — an IPv4-only listener is unreachable from an IPv6
  client. `dualStackHost()` in `src/server/api.ts` maps the wildcard to a
  missing hostname for this reason.
- **A tool the prompt advertises must be a tool the loop can RUN.** Meta tools
  (`finish`, `set_todo`, `read_memory`, `ask_user`…) are handled by
  `runTurnsUntilIdle`, not by `executeTool`. Their specs live in
  `src/agent/meta-tools.ts` and their handlers in `metaHandlers`, typed
  `Record<MetaToolName, …>` where `MetaToolName` is derived from the table — so a
  spec without a handler is a COMPILE error. Before that, the mismatch was silent:
  the call fell through to `executeTool`, which answered **"unknown tool"** for a
  tool the same request had just described, and the model retried or gave up. A
  handler with no spec was the quieter half — unreachable code.
  - Adding one: an entry in `META_TOOLS` **and** a key in `metaHandlers`. The two
    return kinds are the old if-chain's two control flows: `"next"` is the
    `continue`, `"end"` is `finish` leaving the whole batch (#105).
- **An empty element still occupies its box.** A grouped row renders
  `<div class="avatar avghost ghosted">` as a continuation marker; `avghost` had
  no rule, so it inherited `.avatar`'s `height: 38px` + `margin-top: 2px` and every
  continuation carried 40px of INVISIBLE height. That is why a run of tool rows
  read as sparse while the embed itself was flush. Scope such a reset to the state
  that needs it (`.msg.grouped`), never to the bare class — `avghost` is on every
  row's avatar, so unscoped it collapses the icon everywhere.
- **`content-visibility: auto` moves the scroll unless the placeholder equals the
  real height.** `contain-intrinsic-size: auto 140px` is a guess, and row heights
  here span three orders of magnitude, so `frontend/feed-reserve.ts` writes each
  row's MEASURED box back via IntersectionObserver (with a ±900px skirt, so a row
  is measured before the scroll reaches it) + ResizeObserver + MutationObserver.
  Chromium does not report a cv unskip as CLS (crbug 40733057), so this cannot be
  caught by a metric — hence `test/feed-reserve.test.ts` and the smoke check.
- **Growing a container and reading its geometry in a later frame is a race.**
  `autosizeComposer` sampled inside a rAF, which can run before the new height is
  laid out; `scrollBottom` then used the OLD maximum and left the feed above the
  tail by exactly the growth. Writing `height` does not lay out, but READING a
  geometry property does — `void el.clientHeight` forces it, then sample and act
  synchronously.
- **Third-party components get a namespace and a containment check.** MCP tools are
  exposed as `mcp__<server>__<tool>`; a plugin's servers are additionally qualified with
  the plugin name (`<plugin>:<server>`) because the registry keys by name and two
  plugins may each ship a `db`. Without the prefix a server exposing `bash` would
  shadow the local shell, and without the qualification one plugin's tools silently
  vanish behind another's.
  - A plugin (`plugin.json`, Agent Plugins spec) is third-party code arriving as a
    directory — usually an extracted archive — so **every package path is resolved with
    `realpath` and proven inside the root**. Checking the literal path misses the only
    attack that matters: a symlink pointing at `~/.ssh`. `plugin.json`, `skills/`, each
    `SKILL.md`, a stdio `command` and `cwd` are all checked, and the failure boundary is
    the NARROWEST one (bad server → that server; bad skill → that skill; bad manifest →
    the plugin).
  - `McpError` uses explicit fields, not parameter properties (`constructor(x, readonly
    y)`): Node's type-stripping loader refuses that syntax and `pnpm test` runs sources
    directly.
- **Remove vs archive vs purge are three different wishes, and conflating them loses
  data.** `removeAgent` originally deleted the agent's config entry while leaving its
  `sessions/` directory on disk: the history survived but nothing in the UI could reach
  it again — recoverable only by knowing the id and hand-editing `config.json`. The
  entry is what binds an agent to a session, so **deleting the entry orphans the
  history** just as surely as deleting the files would. `archived?: boolean` on
  `AgentConfig` is the reversible middle: stopped, hidden, entry and history kept,
  skipped at boot. `purgeAgent` is the only destructive one and deletes both.
  - Anything that "removes" a row from a config list should ask which of these three the
    operator means. A default that is destructive is the one nobody forgives.
- Compaction is ordered by **cost, not by which mechanism is best**: clip re-issuable
  tool output (free, no history rewritten) → only if that is not enough, summarize →
  only if the summarize fails, truncate. `maybePrune()` used to run unconditionally at
  the top of every turn, gated at `0.6 × budget`, and the budget is itself 75% of the
  model's window — so history was clipped at **45% of the real window** with a quarter
  of it still free. Pruning is destructive in a way compaction is not (a clipped tool
  result leaves the model's context; the log keeps it, but the model must re-issue the
  call), so it may only run once a pass is genuinely over budget.

- The web terminal resizes with `stty -F <pty-slave> rows R cols C` — an
  ioctl(TIOCSWINSZ) on the DEVICE — never by writing `stty` to the child's stdin.
  stdin belongs to whatever owns the tty, so a written command arrives as KEYS in
  vim / less / a REPL. This is what VS Code (node-pty) and Alacritty do; neither
  issues `stty` as text. `resolvePtySlave` finds the device via /proc: `script` is
  spawned with piped stdio, so ITS OWN fd 0 is our pipe, and the pty slave is on
  the shell it FORKS — reading the spawned child's fd 0 returns nothing useful and
  silently falls back to typing. macOS has no /proc, so the stdin write stays as
  the fallback there.

## Commits and releases

- One logical change per commit. Message: `fix(#NNN): <what was wrong>`, with a
  body explaining the **mechanism** and the evidence (a measurement, a test, a
  reproduction) — not just "fixed the bug".
- Keep the trailer area clean: no `Co-Authored-By`, no generated-by lines.
- Releases are tag-driven (`.github/workflows/publish.yml`). Bumping
  `package.json` and pushing the matching `vX.Y.Z` tag publishes to npm; the
  workflow refuses a tag that disagrees with the version.
- **A green publish workflow does not mean the version is installable.** npm
  registers it, and the tarball appears on the CDN later; `dist-tags.latest` can
  even name the new version while
  `https://registry.npmjs.org/<pkg>/-/<pkg>-<v>.tgz` still 404s. Verify the
  TARBALL with a HEAD request before declaring a release done, and do not
  conclude from a 404 that it failed.
- Re-running a publish can return `E409 Cannot publish over previously staged
  version`. That means the version was **already accepted** and is awaiting
  validation — it is not a conflict to resolve. **Do not bump the version to
  "get past" it**; that ships a second, identical release. Wait for the tarball.
- `npm cache clean --force` before trusting `npm view` / `npm pack` / `npm i -g`;
  the cache served stale metadata repeatedly here.
- **Do not sit in a foreground loop waiting for the tarball.** It is one slow,
  dumb wait (MEASURED 5–20 min) and blocking the session on it wastes the whole
  turn. `scripts/wait-npm-version.ts <version>` polls the tarball, clears the
  cache, installs and verifies the INSTALLED `package.json`, then exits 0:

  ```sh
  node scripts/wait-npm-version.ts 0.29.48     # run in a BACKGROUND bash job
  ```

  Start it in the background and keep working; the notification arrives when the
  version is installed.

- **Wait for a workflow with `gh run watch`, never a fixed `sleep`.**

  ```sh
  gh run watch <run-id> --exit-status --interval 15   # exits when the run finishes
  gh run list --workflow=publish.yml --limit 1 --json databaseId -q '.[0].databaseId'
  ```

  `--exit-status` makes the exit code the run's result, so a failing job is visible without
  parsing logs. It returns immediately when the run has already completed, which is why it is
  safe to call even when unsure — a `sleep 340` cannot tell the difference between "still
  running" and "finished 5 minutes ago", and MEASURED, it wasted most of a turn on every release
  in one session. Wrap it in `timeout` so a wedged run cannot block the loop forever.

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

## Debugging, and when to stop reasoning

- **When a synthetic reproduction disagrees with the real thing, believe the real
  thing.** A hand-built fixture said a `state` row did not break tool grouping;
  the actual log, replayed through the app's own filter, showed it did. The
  fixture was wrong about the filter, not the app.
- **Drive the artefact, do not read it.** Dump the BUILT bundle's DOM
  (`scripts/smoke-web.mjs`) to see what a user sees. Reading `App.tsx` produced
  three plausible-and-wrong diagnoses in one session; a DOM dump produced the
  answer in one shot.
- **A user's "sometimes it works" is data, not noise.** That a bug is
  intermittent means some condition differs; find the condition (here: whether a
  turn boundary fell between two tool calls) instead of filing it as flaky.
- **A wrong guess about the OPERATOR'S setup is expensive.** Before touching
  anything that listens on a port or holds state, read what is already running
  (`ss -ltnp`) and treat an unknown listener as theirs until proven otherwise.
- When the operator corrects you, `add_feedback` the rule. Two from this session:
  never treat npm's messages as a conflict to work around (E409 = already
  accepted), and never kill a process you have not proven you started.

## Editing many files at once

**Default to `edit_file` / `apply_patch`, not a text-replacement script.** They locate the
target by content and are validated before writing, so a pattern that matches somewhere you
did not intend is REFUSED (`edit_file` demands a unique match) instead of silently rewritten.
A `python`/`sed` replace has no such guard, and MEASURED here: a regex pass over `App.tsx`
rewrote `grouped` → `grouped()` inside the CSS class STRINGS (`" grouped"` became
`" grouped()"`), which broke grouping in a way no typecheck sees — the string is still a
valid string. Repairing it cost more time than making the edits one at a time would have.

- A one-off script IS the right tool when you genuinely want a bulk transform across many
  files (a rename, a wholesale import change). The rule is "no guard rail by accident", not
  "never script": if you script a scoped edit, make the pattern specific and verify the diff.
- One-off scripts that delete or rewrite hundreds of call sites cut four files in half,
  because a brace-matching walker is confused by braces inside template literals and strings.
  Verify EACH file after the edit and revert just that file on failure
  (`node --experimental-strip-types --check <file>` catches TS parse errors that plain
  `node --check` accepts).
- Prefer many small, reviewable edits over one clever transform.
